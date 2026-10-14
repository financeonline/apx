import { NextResponse, type NextRequest } from 'next/server';
import { recordAccessEvent, throttle } from '@/core/db';
import { MotionError, NotFound, PermissionDenied, toMotionError, ValidationError } from '@/core/errors';
import { log, newRequestId } from '@/core/logging';
import { can } from '@/core/permissions';
import { getMonthlySummary, renderSummaryPdf } from '@/modules/reporting';
import { getAccessContext, moduleOn } from '@/modules/tenancy';

/**
 * `GET /api/reports/summary/[periodId]?org=<slug>` — the Monthly Management Report's SUMMARY EDITION
 * as a PDF (ADR-172 addendum, the owner's decision of 2026-10-14).
 *
 * The edition a reader without `financials.view` gets — a 3rd party by default — and one a full
 * reader may take too: the headline figures, the Business Health Score and the report's own words,
 * built from the overview alone with the reader's own client (`getMonthlySummary`) and rendered now.
 * Nothing is stored or signed, as for the Marketing report and the Investment pack (ADR-170): a
 * stored PDF is the one place the database cannot redact, and this edition has nothing to redact.
 *
 * The order of the other downloads (ROUTE_ARCHITECTURE.md §166; ADR-038.7): the organisation from
 * the slug against the caller's own access (ADR-014), `reports.view`, the Reports system switch (off
 * is NOT FOUND, ADR-158), the shared `report.download` limit, the edition itself (a month that has
 * not finished, has no figures or is another organisation's is NOT FOUND), and the
 * `report.downloaded` access event — naming the MONTH, since there is no file — written BEFORE the
 * first byte. `api_server.record_access_event` re-checks the actor and that the month is a complete
 * one of this organisation (migration 20261018000036). A route is not under the tenant layout, so it
 * decides all of this itself.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "May 2026" → "monthly-report-summary-may-2026.pdf": ASCII, no path, nothing the reader typed. */
function filenameFor(periodLabel: string): string {
  const slug = periodLabel.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `monthly-report-summary${slug === '' ? '' : `-${slug}`}.pdf`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ periodId: string }> },
) {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();
  const headers = { 'x-request-id': requestId, 'cache-control': 'no-store' };

  try {
    const { periodId } = await params;
    const orgSlug = request.nextUrl.searchParams.get('org');
    if (!orgSlug) throw new ValidationError('The organization is missing from the request.');
    // Not a uuid: no month of anybody's. NOT FOUND before a single query.
    if (!UUID.test(periodId)) throw new NotFound();

    const ctx = await getAccessContext(orgSlug);
    if (!ctx.orgId) throw new NotFound();
    if (!can(ctx, 'reports.view')) {
      throw new PermissionDenied('You do not have permission to download reports here.');
    }
    if (!moduleOn(ctx, 'reports')) throw new NotFound();

    // ROUTE_ARCHITECTURE.md §166: 30 an hour, on the counter every report download shares.
    await throttle({ userId: ctx.userId, requestId }, 'report.download', 30, '1 hour');

    const summary = await getMonthlySummary(ctx, periodId);
    if (summary === null) throw new NotFound();

    await recordAccessEvent(
      { userId: ctx.userId, requestId },
      // Ids and kinds only in the metadata (ADR-038.9). The target is the month: there is no file.
      {
        organizationId: ctx.orgId,
        action: 'report.downloaded',
        targetTable: 'fiscal_periods',
        targetId: summary.period.id,
        metadata: { period_id: summary.period.id, surface: 'summary_edition' },
      },
    );

    const bytes = await renderSummaryPdf(summary);
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        ...headers,
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${filenameFor(summary.period.label)}"`,
      },
    });
  } catch (cause) {
    const error = cause instanceof MotionError ? cause : toMotionError(cause, requestId);
    if (error.status >= 500) log.error('a summary edition download failed', { requestId, error: error.message });
    return NextResponse.json({ error: error.toJSON() }, { status: error.status, headers });
  }
}
