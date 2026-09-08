import { NextResponse, type NextRequest } from 'next/server';
import { enqueueNightlySweep } from '@/core/db';
import { log } from '@/core/logging';
import { cronAuthorised } from '../_lib/cron-auth';

/**
 * The nightly enqueue (SERVICE_ARCHITECTURE.md §7; ADR-074), driven by Vercel Cron once a day.
 *
 * It queues exactly one platform-wide `storage.cleanup_orphans` for today's date — the sweep that
 * collects orphaned objects and prunes the throttle counter — and the minute-by-minute worker on
 * `/api/jobs/run` picks it up. Until this route existed the handler was registered and never ran:
 * `vercel.json` drained the queue every minute and nothing ever put the sweep in it (ADR-064).
 *
 * Idempotent by date on the database side, so a cron that fires twice queues nothing twice.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!cronAuthorised(request)) {
    // 404, not 401: an unauthenticated caller learns nothing about whether this endpoint exists.
    return new NextResponse(null, { status: 404 });
  }

  try {
    const jobId = await enqueueNightlySweep();
    return NextResponse.json({ jobId });
  } catch (cause) {
    log.error('the nightly sweep could not be queued', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return NextResponse.json({ error: 'The nightly sweep could not be queued.' }, { status: 500 });
  }
}
