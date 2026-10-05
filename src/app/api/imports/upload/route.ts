import { NextResponse, type NextRequest } from 'next/server';
import { registerDocument, finalizeUpload, throttle } from '@/core/db';
import {
  MotionError, PermissionDenied, QuotaExceeded, ValidationError, toMotionError,
} from '@/core/errors';
import { log, newRequestId } from '@/core/logging';
import { uploadDocument, checkDeclaredLength, MAX_FILE_BYTES } from '@/modules/documents';
import { getAccessContext } from '@/modules/tenancy';
import { isDocumentKind } from '@/modules/imports';
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

    /*
     * ROUTE_ARCHITECTURE.md §5: 20 an hour per user, 100 a day per organisation — on the counter
     * every api.* function already shares. The organisation bucket is keyed on the organisation's
     * id; the counter's actor column is a plain uuid, and an organisation is the actor of its own
     * daily allowance. Counted before the body is read, so a refused upload costs the server nothing.
     */
    await throttle({ userId: ctx.userId, requestId }, 'upload', 20, '1 hour');
    await throttle({ userId: ctx.orgId, requestId }, 'upload:org', 100, '1 day');

    /*
     * The size limit is decided from Content-Length, BEFORE `request.formData()` — which reads the
     * whole multipart body into memory and only then exposes `file.size`. The check that used to sit
     * after that call was applied after the damage (PRODUCTION_AUDIT.md M1; ADR-070).
     */
    const verdict = checkDeclaredLength(request.headers.get('content-length'));
    if (verdict === 'missing') {
      throw new ValidationError('The upload must declare its length.');
    }
    if (verdict === 'too_large') {
      throw new QuotaExceeded(
        `That file is larger than the ${Math.floor(MAX_FILE_BYTES / 1_048_576)} MB limit. Split it by period.`,
      );
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new ValidationError('Choose a file to upload.');

    // Belt and braces after the header check: the one part that is a file is still measured.
    if (file.size > MAX_FILE_BYTES) {
      throw new ValidationError(
        `That file is larger than the ${Math.floor(MAX_FILE_BYTES / 1_048_576)} MB limit. Split it by period.`,
      );
    }

    // Checked, not cast: `register_document` casts it to `document_kind_enum`, and an unknown value
    // surfaced as a Postgres error rather than a sentence.
    const documentKind = String(form.get('documentKind') ?? 'unknown');
    if (!isDocumentKind(documentKind)) {
      throw new ValidationError('That is not a kind of document MOTION keeps.');
    }
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
