import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { drainJobs } from '@/modules/jobs';
import { log } from '@/core/logging';

/**
 * The job worker endpoint, driven by Vercel Cron (`vercel.json`).
 *
 * It is a public URL, so the shared secret is the only thing standing between the internet and the
 * service role. Two consequences, both deliberate:
 *   - the comparison is constant-time, so the secret cannot be recovered a byte at a time by timing;
 *   - with no secret configured the route refuses everything rather than running open.
 *
 * `force-dynamic` because a cached response would mean the queue silently stops draining.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorised(request: NextRequest): boolean {
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

export async function GET(request: NextRequest) {
  if (!authorised(request)) {
    // 404, not 401: an unauthenticated caller learns nothing about whether this endpoint exists.
    return new NextResponse(null, { status: 404 });
  }

  try {
    const result = await drainJobs();
    return NextResponse.json(result);
  } catch (cause) {
    log.error('the job worker could not run', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return NextResponse.json({ error: 'The job worker could not run.' }, { status: 500 });
  }
}
