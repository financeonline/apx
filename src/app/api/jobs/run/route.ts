import { NextResponse, type NextRequest } from 'next/server';
import { drainJobs, registerJobHandlers } from '@/modules/jobs';
import { cronAuthorised } from '../_lib/cron-auth';

// The import above is what registers the handlers; this call makes that dependency explicit rather
// than relying on a side effect a bundler could tree-shake (ADR-057.1).
registerJobHandlers();
import { log } from '@/core/logging';

/**
 * The job worker endpoint, driven by Vercel Cron (`vercel.json`).
 *
 * It is a public URL, so the shared secret is the only thing standing between the internet and the
 * service role; `cronAuthorised` in `../_lib/cron-auth.ts` is the one implementation of that check,
 * shared with `/api/jobs/nightly` (ADR-074).
 *
 * `force-dynamic` because a cached response would mean the queue silently stops draining.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!cronAuthorised(request)) {
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
