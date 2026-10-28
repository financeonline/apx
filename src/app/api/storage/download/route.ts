import { NextResponse, type NextRequest } from 'next/server';
import { createUserClient } from '@/core/db';
import { MotionError, toMotionError } from '@/core/errors';
import { log, newRequestId } from '@/core/logging';
import { attachmentDisposition, redeemDownloadGrant } from '@/core/storage/signer';

/**
 * `GET /api/storage/download?grant=…` — where a download link from `signDownloadUrl` leads
 * (ADR-043.5; FIRESTORE_DATA_MODEL.md §1: files are served only by the server).
 *
 * The link was minted after the route that issued it checked the permission, resolved the file row
 * and wrote the audit event. Here, before any byte is read: the grant's signature and 60-second
 * expiry, that the signed-in person IS the actor it was minted for (a forwarded link is a 404 to
 * anybody else), and — in the signer — the audit event, re-read and matched again. The bytes go out
 * as an attachment, never cached.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? newRequestId();
  try {
    const grant = request.nextUrl.searchParams.get('grant') ?? '';
    const { actor } = await createUserClient();
    const object = await redeemDownloadGrant(grant, actor.kind === 'user' ? actor.userId : null);
    return new NextResponse(Buffer.from(object.bytes), {
      status: 200,
      headers: {
        'content-type': object.contentType,
        'content-length': String(object.bytes.byteLength),
        'content-disposition': attachmentDisposition(object.filename),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'x-request-id': requestId,
      },
    });
  } catch (cause) {
    const error = cause instanceof MotionError ? cause : toMotionError(cause, requestId);
    if (error.status >= 500) log.error('a stored file could not be served', { requestId, error: error.message });
    return NextResponse.json(
      { error: error.toJSON() },
      { status: error.status, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } },
    );
  }
}
