import { MAX_FILE_BYTES } from './validate-file';

/**
 * The upload body limit, decided from the request HEADER (ROUTE_ARCHITECTURE.md §5 `/api/imports/upload`;
 * ADR-070; PRODUCTION_AUDIT.md M1).
 *
 * `request.formData()` materialises every part of a multipart body in memory before it returns, and
 * only then can `file.size` be read. A limit applied after that call is applied after the damage: a
 * caller with `imports.create` could post gigabytes and the first thing to fail would be the
 * function's memory, not the guard. The one fact available BEFORE the body is read is
 * `Content-Length`, which every browser sends for a `FormData` post, so that is what decides.
 *
 * Pure, so the decision is unit-tested without a request.
 */

/** Headroom for the multipart framing around a file that is exactly at the limit. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** The largest body the route will read at all. */
export const MAX_UPLOAD_BODY_BYTES = MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES;

export type DeclaredLengthVerdict = 'ok' | 'missing' | 'too_large';

/**
 * Judges the `Content-Length` header before a byte of body is read.
 *
 * A missing or unparseable header is `missing`, not `ok`: a chunked upload with no declared length
 * cannot be bounded up front, and this route has no reason to accept one — browsers do not send them.
 */
export function checkDeclaredLength(header: string | null | undefined): DeclaredLengthVerdict {
  if (header === null || header === undefined) return 'missing';
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return 'missing';
  const declared = Number(trimmed);
  if (!Number.isSafeInteger(declared)) return 'too_large';
  return declared > MAX_UPLOAD_BODY_BYTES ? 'too_large' : 'ok';
}
