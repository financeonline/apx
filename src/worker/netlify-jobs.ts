import { log } from '@/core/logging';
import { drainJobs, registerJobHandlers, type DrainResult } from '@/modules/jobs';

/**
 * The job queue's worker on Netlify (ADR-183), bundled by `scripts/build-netlify-worker.mjs` into the
 * background function `jobs-worker-background` (the `-background` name is what makes Netlify answer
 * 202 at once and allow fifteen minutes).
 *
 * A Next.js route on Netlify stops at 60 seconds, and a marketing or investment report is one AI call
 * of up to four minutes: run there, it would be cut off, reclaimed and retried — a paid call each
 * time. Here a job may use its full budget (`jobMaxRuntimeSeconds`, at most five minutes for a
 * report), and no new job is claimed after NEW_JOB_CUTOFF_MS, so the last one ends inside the limit.
 */
registerJobHandlers();

const NEW_JOB_CUTOFF_MS = 9 * 60_000;

export async function runQueuedJobs(now: () => number = Date.now): Promise<DrainResult> {
  const started = now();
  const total = { claimed: 0, succeeded: 0, failed: 0 };
  while (now() - started < NEW_JOB_CUTOFF_MS) {
    const r = await drainJobs(1);
    total.claimed += r.claimed;
    total.succeeded += r.succeeded;
    total.failed += r.failed;
    if (r.claimed === 0) break;
  }
  return total;
}

/** The background function: the shared cron secret, as `/api/jobs/*` check it (constant time). */
export default async function handler(request: Request): Promise<Response> {
  const { timingSafeEqual } = await import('node:crypto');
  const expected = process.env.CRON_SECRET ?? '';
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const ok = expected.length > 0 && presented.length === expected.length
    && timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
  if (!ok) return new Response(null, { status: 404 });
  const result = await runQueuedJobs();
  log.info('job worker finished', { ...result });
  return new Response(null, { status: 202 });
}
