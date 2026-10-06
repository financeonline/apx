import { NextResponse, type NextRequest } from 'next/server';
import { enqueueEngineUpgrade, enqueueFundingBackstop, enqueueHealthUpgrade, enqueueNightlySweep } from '@/core/db';
import { ENGINE_VERSION, HEALTH_CONFIG_VERSION } from '@/modules/financial-engine';
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
  let engineUpgrade: number;
  try {
    engineUpgrade = await enqueueEngineUpgrade(ENGINE_VERSION);
    if (engineUpgrade > 0) {
      log.info('organisations queued for the engine upgrade', { engineVersion: ENGINE_VERSION, count: engineUpgrade });
    }
  } catch (cause) {
    log.error('the engine upgrade could not be queued', {
      engineVersion: ENGINE_VERSION,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return NextResponse.json({ jobId, error: 'The engine upgrade could not be queued.' }, { status: 500 });
  }

  /*
   * ADR-147: the same for a new Health config — every organisation whose scores were all worked out
   * under another one is queued for a full re-score. Its own error path.
   */
  let healthUpgrade: number;
  try {
    healthUpgrade = await enqueueHealthUpgrade(HEALTH_CONFIG_VERSION);
    if (healthUpgrade > 0) log.info('organisations queued for the health config upgrade', { configVersion: HEALTH_CONFIG_VERSION, count: healthUpgrade });
  } catch (cause) {
    log.error('the health config upgrade could not be queued', {
      configVersion: HEALTH_CONFIG_VERSION,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return NextResponse.json({ jobId, engineUpgrade, error: 'The health config upgrade could not be queued.' }, { status: 500 });
  }

  /*
   * Phase 16 (ADR-121): the Funding Readiness backstop — any organisation with it switched on whose
   * latest scored month has no current assessment is queued. Its own error path, after the two above.
   */
  try {
    const fundingBackstop = await enqueueFundingBackstop();
    if (fundingBackstop > 0) log.info('organisations queued for a funding readiness assessment', { count: fundingBackstop });
    return NextResponse.json({ jobId, engineUpgrade, healthUpgrade, fundingBackstop });
  } catch (cause) {
    log.error('the funding readiness backstop could not be queued', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return NextResponse.json({ jobId, engineUpgrade, healthUpgrade, error: 'The funding readiness backstop could not be queued.' }, { status: 500 });
  }
}
