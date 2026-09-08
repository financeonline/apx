import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

/**
 * The shared secret every cron-driven route checks (ROUTE_ARCHITECTURE.md §5 `/api/jobs/*`).
 *
 * These are public URLs, so the secret is the only thing standing between the internet and the
 * service role. The comparison is constant-time, so the secret cannot be recovered a byte at a time
 * by timing; and with no secret configured the routes refuse everything rather than running open.
 */
export function cronAuthorised(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

  // timingSafeEqual throws on a length mismatch, which would itself leak the length. Compare
  // fixed-size buffers instead.
  const a = Buffer.from(presented.padEnd(expected.length, '\0').slice(0, expected.length));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) && presented.length === expected.length;
}
