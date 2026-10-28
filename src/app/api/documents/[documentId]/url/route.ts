import { NextResponse, type NextRequest } from 'next/server';
import { recordAccessEvent, throttle } from '@/core/db';
import { MotionError, NotFound, PermissionDenied, toMotionError, ValidationError } from '@/core/errors';
import { log, newRequestId } from '@/core/logging';
import { can } from '@/core/permissions';
import { signDownloadUrl, SOURCE_DOCUMENTS_BUCKET } from '@/core/storage/signer';
import { getAccessContext } from '@/modules/tenancy';
import { getDocumentObject } from '@/modules/documents';

/**
 * `GET /api/documents/[documentId]/url` (ROUTE_ARCHITECTURE.md §164; EVIDENCE_MODEL.md §6 level 4,
 * §10; SECURITY_MODEL.md §5b; ADR-043.5).
 *
 * Level 4 of the evidence drawer, and the only way a source document leaves MOTION.
 *
 * The order is the whole security property, and it is deliberately audit-first:
 *
 *   1. resolve the organization from the URL slug — never from anything the caller sent;
 *   2. `documents.view`, which the client role does not have (§10, CD-17);
 *   3. resolve the document by `(organization_id, id)`, so another organization's id is a 404 and
 *      not a 403 — a 403 would confirm the document exists for somebody (SECURITY_MODEL.md §14);
 *   4. write `document.downloaded` through `api_server.record_access_event`, which re-checks the
 *      permission and the organization in SQL and returns the audit id;
 *   5. hand that id to the signer, which re-reads the row and refuses unless it is this actor, this
 *      target and less than 30 seconds old, before it mints anything. The link it returns leads to
 *      `/api/storage/download`, which checks the session and the audit row again and then serves the
 *      bytes itself, as an attachment (files never leave through a bucket URL; FIRESTORE_DATA_MODEL.md §1).
 *
 * A download that was not recorded therefore cannot happen — not because the code remembers to
 * audit, but because the audit row is the input the signer needs.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();

  try {
    const { documentId } = await params;
    const orgSlug = request.nextUrl.searchParams.get('org');
    if (!orgSlug) throw new ValidationError('The organization is missing from the request.');

    const ctx = await getAccessContext(orgSlug);
    if (!ctx.orgId) return new NextResponse(null, { status: 404 });

    if (!can(ctx, 'documents.view')) {
      // §10: the drawer already renders this level as locked for a client, so reaching here means
      // the URL was called directly. The reason is still said plainly rather than 404'd, because the
      // caller is a member of this organization and is not being told anything they do not know.
      throw new PermissionDenied('Source documents are available to owners and admins.');
    }

    // ROUTE_ARCHITECTURE.md §164: 60/min, on the counter every api.* function already shares.
    await throttle({ userId: ctx.userId, requestId }, 'document.url', 60, '1 minute');

    // Read under the caller's own policy (`source_documents_select`), scoped to the organisation in
    // the URL: another organisation's id is simply not there.
    const document = await getDocumentObject(ctx, documentId);
    if (document === null) throw new NotFound();

    const auditEventId = await recordAccessEvent(
      { userId: ctx.userId, requestId },
      {
        organizationId: ctx.orgId,
        action: 'document.downloaded',
        targetTable: 'source_documents',
        targetId: document.id,
        metadata: { surface: 'evidence' },
      },
    );

    const signed = await signDownloadUrl(
      { orgId: ctx.orgId, userId: ctx.userId },
      {
        bucket: document.storageBucket || SOURCE_DOCUMENTS_BUCKET,
        key: document.storagePath,
        auditEventId,
        targetTable: 'source_documents',
        targetId: document.id,
        downloadAs: document.originalFilename,
      },
    );

    return NextResponse.json(signed, {
      // Never cached, anywhere: the link is valid for 60 seconds and is personal to this request.
      headers: { 'x-request-id': requestId, 'cache-control': 'no-store' },
    });
  } catch (cause) {
    const error = cause instanceof MotionError ? cause : toMotionError(cause, requestId);
    if (error.status >= 500) {
      log.error('a document URL could not be minted', { requestId, error: error.message });
    }
    return NextResponse.json(
      { error: error.toJSON() },
      { status: error.status, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } },
    );
  }
}
