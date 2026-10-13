import { NextResponse, type NextRequest } from 'next/server';
import { recordAccessEvent, throttle } from '@/core/db';
import { MotionError, NotFound, PermissionDenied, ValidationError, toMotionError } from '@/core/errors';
import { log, newRequestId } from '@/core/logging';
import { can } from '@/core/permissions';
import {
  getLatestInvestmentReport, investmentEnabled, investmentFilename, renderInvestmentDocx, renderInvestmentPdf,
} from '@/modules/investment';
import { getAccessContext } from '@/modules/tenancy';

/**
 * `GET /app/[orgSlug]/investment/download?format=docx|pdf` — the Investment Pack as a Word file or a
 * PDF (ADR-171), rendered now from the newest ready pack. Marketing's download in every step
 * (ADR-170): nothing is stored or signed — the pack is already the organisation's own row, read
 * through the caller's client, so RLS decides what there is to render.
 *
 * The same order as the other downloads (ROUTE_ARCHITECTURE.md §166; ADR-038.7): the organisation
 * from the slug against the caller's own access (ADR-014), `reports.view`, the system switch (off is
 * NOT FOUND, ADR-158), the shared `report.download` limit, and the `report.downloaded` access event
 * written BEFORE the first byte — a download that started is a fact whether or not it finished. A
 * route is not under the tenant layout, so it decides all of this itself.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CONTENT_TYPE = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
} as const;

type Format = keyof typeof CONTENT_TYPE;

function isFormat(value: string | null): value is Format {
  return value === 'docx' || value === 'pdf';
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ orgSlug: string }> }) {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();
  const headers = { 'x-request-id': requestId, 'cache-control': 'no-store' };

  try {
    const { orgSlug } = await params;
    const format = request.nextUrl.searchParams.get('format');
    if (!isFormat(format)) throw new ValidationError('Choose a format: docx or pdf.');

    const ctx = await getAccessContext(orgSlug);
    if (!ctx.orgId) throw new NotFound();
    if (!can(ctx, 'reports.view')) throw new PermissionDenied('You do not have permission to download reports here.');
    if (!investmentEnabled(ctx)) throw new NotFound();

    // ROUTE_ARCHITECTURE.md §166: 30 an hour, on the counter the report downloads already share.
    await throttle({ userId: ctx.userId, requestId }, 'report.download', 30, '1 hour');

    const report = await getLatestInvestmentReport(ctx);
    if (report === null) throw new NotFound();

    await recordAccessEvent(
      { userId: ctx.userId, requestId },
      // Ids and kinds only in the metadata (ADR-038.9); the pack has no `report_files` row to name.
      { organizationId: ctx.orgId, action: 'report.downloaded', targetTable: null, targetId: null, metadata: { surface: 'investment', export_kind: format } },
    );

    const bytes = format === 'docx' ? await renderInvestmentDocx(report) : await renderInvestmentPdf(report);
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        ...headers,
        'content-type': CONTENT_TYPE[format],
        'content-disposition': `attachment; filename="${investmentFilename(orgSlug, report.generatedAt, format)}"`,
      },
    });
  } catch (cause) {
    const error = cause instanceof MotionError ? cause : toMotionError(cause, requestId);
    if (error.status >= 500) log.error('an investment pack download failed', { requestId, error: error.message });
    return NextResponse.json({ error: error.toJSON() }, { status: error.status, headers });
  }
}
