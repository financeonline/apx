import { NextResponse, type NextRequest } from 'next/server';
import { enqueueEngineUpgrade, enqueueNightlySweep } from '@/core/db';
import { ENGINE_VERSION } from '@/modules/financial-engine';
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

  let jobId: string;
  try {
    jobId = await enqueueNightlySweep();
  } catch (cause) {
    log.error('the nightly sweep could not be queued', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return NextResponse.json({ error: 'The nightly sweep could not be queued.' }, { status: 500 });
  }

  /*
   * ADR-120: every organisation still on an older engine's figures is queued for a full
   * recalculation, every night, until a run on this version has succeeded for it. The first night
   * after a deploy does the bulk; later nights pick up only the ones whose run failed. Its own error
   * path: the sweep above is already queued, and a failure here must say what failed.
   */
  try {
    const engineUpgrade = await enqueueEngineUpgrade(ENGINE_VERSION);
    if (engineUpgrade > 0) {
      log.info('organisations queued for the engine upgrade', { engineVersion: ENGINE_VERSION, count: engineUpgrade });
    }
    return NextResponse.json({ jobId, engineUpgrade });
  } catch (cause) {
    log.error('the engine upgrade could not be queued', {
      engineVersion: ENGINE_VERSION,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return NextResponse.json({ jobId, error: 'The engine upgrade could not be queued.' }, { status: 500 });
  }
}
