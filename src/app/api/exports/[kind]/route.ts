import { NextResponse, type NextRequest } from 'next/server';
import { recordAccessEvent, throttle } from '@/core/db';
import { MotionError, NotFound, PermissionDenied, ValidationError, toMotionError } from '@/core/errors';
import { log, newRequestId } from '@/core/logging';
import { can } from '@/core/permissions';
import { exportCsv, exportFilename, isExportKind } from '@/modules/exports';
import { getAccessContext } from '@/modules/tenancy';

/**
 * `GET /api/exports/[kind]?org=slug` (ROUTE_ARCHITECTURE.md §167; SECURITY_MODEL.md §8 step 4, §12).
 *
 * The organisation comes from the slug, resolved against the caller's own access (ADR-014); the
 * permission is `data.export`; the limit is ten an hour per user on the shared counter. The
 * `export.created` access event is written BEFORE the first byte — an export that started is a
 * fact whether or not the download finished — and the CSV streams from the caller's own client, so
 * nothing RLS would hide is in it, and a bank line carries only its masked text (ADR-038.4).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();
  const headers = { 'x-request-id': requestId };

  try {
    const { kind } = await params;
    if (!isExportKind(kind)) throw new NotFound();
    const orgSlug = request.nextUrl.searchParams.get('org');
    if (!orgSlug) throw new ValidationError('The organization is missing from the request.');

    const ctx = await getAccessContext(orgSlug);
    if (!ctx.orgId) throw new NotFound();
    if (!can(ctx, 'data.export')) throw new PermissionDenied('data.export');

    await throttle({ userId: ctx.userId, requestId }, 'export', 10, '1 hour');

    await recordAccessEvent(
      { userId: ctx.userId, requestId },
      { organizationId: ctx.orgId, action: 'export.created', targetTable: null, targetId: null, metadata: { export_kind: kind } },
    );

    const today = new Date().toISOString().slice(0, 10);
    const lines = exportCsv(ctx, kind);
    // The first line is the header: pulling it now surfaces a refusal as a status, not as a broken file.
    const first = await lines.next();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          if (!first.done) controller.enqueue(encoder.encode(first.value));
          for await (const line of lines) controller.enqueue(encoder.encode(line));
          controller.close();
        } catch (cause) {
          log.error('an export stopped part way', { requestId, kind, error: cause instanceof Error ? cause.message : String(cause) });
          controller.error(cause);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...headers,
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${exportFilename(kind, today)}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (cause) {
    const error = cause instanceof MotionError ? cause : toMotionError(cause, requestId);
    if (error.status >= 500) log.error('an export could not start', { requestId, error: error.message });
    return NextResponse.json({ error: error.toJSON() }, { status: error.status, headers });
  }
}
