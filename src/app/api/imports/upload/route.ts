import { NextResponse, type NextRequest } from 'next/server';
import { registerDocument, finalizeUpload } from '@/core/db';
import { MotionError, PermissionDenied, ValidationError, toMotionError } from '@/core/errors';
import { log, newRequestId } from '@/core/logging';
import { uploadDocument, MAX_FILE_BYTES } from '@/modules/documents';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';

/**
 * `POST /api/imports/upload` (IMPORT_ENGINE.md §2).
 *
 * The single entry point for a file. It runs on the server because every step that matters —
 * hashing, sniffing, the duplicate check, the storage write — must happen somewhere the browser
 * cannot skip. The response tells the client what to do next; it never returns a storage URL.
 *
 * Node runtime, not Edge: the validators read magic bytes and inspect ZIP directories.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();

  try {
    const orgSlug = request.nextUrl.searchParams.get('org');
    if (!orgSlug) throw new ValidationError('The organization is missing from the request.');

    // Throws NotFound when the caller has no access, which the handler below renders as a 404 —
    // the uniform answer, so a caller learns nothing about whether the slug exists.
    const ctx = await getAccessContext(orgSlug);
    const db = ctx.db;
    if (!ctx.orgId) return new NextResponse(null, { status: 404 });
    if (!can(ctx, 'imports.create')) {
      throw new PermissionDenied('You do not have permission to upload files here.');
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new ValidationError('Choose a file to upload.');

    // Checked before the body is read into memory, so an oversized upload cannot exhaust the server
    // before the limit is applied.
    if (file.size > MAX_FILE_BYTES) {
      throw new ValidationError(
        `That file is larger than the ${Math.floor(MAX_FILE_BYTES / 1_048_576)} MB limit. Split it by period.`,
      );
    }

    const documentKind = String(form.get('documentKind') ?? 'unknown');
    const bytes = new Uint8Array(await file.arrayBuffer());

    const result = await uploadDocument(
      {
        orgId: ctx.orgId,
        userId: ctx.userId,
        db,
        requestId,
        registerDocument: (meta) =>
          registerDocument({ userId: ctx.userId, requestId }, ctx.orgId!, meta),
        finalizeUpload: (documentId, byteSize, scanResult, status) =>
          finalizeUpload({ userId: ctx.userId, requestId }, ctx.orgId!, {
            documentId, byteSize, scanResult, status,
          }),
      },
      {
        filename: file.name,
        declaredMimeType: file.type || 'application/octet-stream',
        bytes,
        documentKind,
      },
    );

    return NextResponse.json(result, { headers: { 'x-request-id': requestId } });
  } catch (cause) {
    const error = cause instanceof MotionError ? cause : toMotionError(cause, requestId);
    if (error.status >= 500) {
      log.error('an upload could not be completed', { requestId, error: error.message });
    }
    return NextResponse.json(
      { error: error.toJSON() },
      { status: error.status, headers: { 'x-request-id': requestId } },
    );
  }
}
