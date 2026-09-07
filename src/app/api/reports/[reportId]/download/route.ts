import { NextResponse, type NextRequest } from 'next/server';
import { recordAccessEvent, throttle } from '@/core/db';
import { MotionError, NotFound, PermissionDenied, toMotionError, ValidationError } from '@/core/errors';
import { log, newRequestId } from '@/core/logging';
import { can } from '@/core/permissions';
import { signDownloadUrl } from '@/core/storage/signer';
import { getReportFile } from '@/modules/reporting';
import { getAccessContext } from '@/modules/tenancy';

/**
 * `GET /api/reports/[reportId]/download` (ROUTE_ARCHITECTURE.md §166; ADR-038.7, ADR-043.5).
 *
 * The same audit-first order as the document route, for the same reason: the audit row is the INPUT
 * the signer verifies, so a download that was not recorded cannot happen. The report is resolved by
 * `(organization_id, id)` first, so another organisation's report id is a 404 rather than a 403 —
 * isolation case 23 (SECURITY_MODEL.md §14).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reportId: string }> },
) {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();

  try {
    const { reportId } = await params;
    const orgSlug = request.nextUrl.searchParams.get('org');
    if (!orgSlug) throw new ValidationError('The organization is missing from the request.');

    const ctx = await getAccessContext(orgSlug);
    if (!ctx.orgId) return new NextResponse(null, { status: 404 });
    if (!can(ctx, 'reports.view')) {
      throw new PermissionDenied('You do not have permission to download reports here.');
    }

    // ROUTE_ARCHITECTURE.md §166: 30/h, on the counter every api.* function already shares.
    await throttle({ userId: ctx.userId, requestId }, 'report.download', 30, '1 hour');

    const file = await getReportFile(ctx, reportId);
    if (file === null) throw new NotFound();

    const auditEventId = await recordAccessEvent(
      { userId: ctx.userId, requestId },
      {
        organizationId: ctx.orgId,
        action: 'report.downloaded',
        targetTable: 'report_files',
        targetId: file.id,
        metadata: { report_id: file.id, period_id: file.periodId },
      },
    );

    const signed = await signDownloadUrl(
      { orgId: ctx.orgId, userId: ctx.userId },
      {
        bucket: file.storageBucket,
        key: file.storagePath,
        auditEventId,
        targetTable: 'report_files',
        targetId: file.id,
        downloadAs: 'monthly-management-report.pdf',
      },
    );

    return NextResponse.json(signed, {
      headers: { 'x-request-id': requestId, 'cache-control': 'no-store' },
    });
  } catch (cause) {
    const error = cause instanceof MotionError ? cause : toMotionError(cause, requestId);
    if (error.status >= 500) {
      log.error('a report URL could not be minted', { requestId, error: error.message });
    }
    return NextResponse.json(
      { error: error.toJSON() },
      { status: error.status, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } },
    );
  }
}
