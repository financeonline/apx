import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cron routes (FU-6, ADR-131, ADR-135): the nightly sweep and engine-upgrade queue, and the HOURLY
 * daily-recalculation enqueue — which the database keeps to one run per organisation and local date.
 * Phase 17 (ADR-141): the hourly tick also queues the scheduled daily and weekly reports.
 */

const calls: string[] = [];
const db = {
  enqueueNightlySweep: vi.fn(async () => { calls.push('sweep'); return 'job-sweep'; }),
  enqueueEngineUpgrade: vi.fn(async (_v: string) => { calls.push('upgrade'); return 2; }),
  enqueueHealthUpgrade: vi.fn(async (_v: string) => { calls.push('health'); return 4; }),
  enqueueScheduledRecalculation: vi.fn(async () => { calls.push('scheduled'); return 5; }),
  enqueueScheduledReports: vi.fn(async () => { calls.push('reports'); return 3; }),
  enqueueFundingBackstop: vi.fn(async () => { calls.push('funding'); return 1; }),
};
vi.mock('@/core/db', () => db);

const nightly = await import('@/app/api/jobs/nightly/route');
const scheduled = await import('@/app/api/jobs/scheduled/route');

function request(secret: string | null) {
  return new Request('http://localhost/api/jobs/x', {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  }) as never;
}

beforeEach(() => {
  calls.length = 0;
  process.env.CRON_SECRET = 'cron-test-secret';
  for (const fn of Object.values(db)) fn.mockClear();
});

describe('the cron routes', () => {
  it('both answer 404 without the cron secret, and queue nothing', async () => {
    expect((await nightly.GET(request(null))).status).toBe(404);
    expect((await scheduled.GET(request('wrong'))).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('nightly: the sweep, the engine upgrade, the health re-score, then the funding backstop — and not the daily recalculation', async () => {
    const response = await nightly.GET(request('cron-test-secret'));
    expect(response.status).toBe(200);
    expect(calls).toEqual(['sweep', 'upgrade', 'health', 'funding']);
    expect(db.enqueueHealthUpgrade).toHaveBeenCalledWith('health.config.v5');
  });

  it('nightly: a failing health re-score is reported, and the backstop after it is not queued (ADR-147)', async () => {
    db.enqueueHealthUpgrade.mockRejectedValueOnce(new Error('boom'));
    const response = await nightly.GET(request('cron-test-secret'));
    expect(response.status).toBe(500);
    expect(calls).toEqual(['sweep', 'upgrade']);
  });

  it('nightly: a failing funding backstop is reported after the others were queued (ADR-121)', async () => {
    db.enqueueFundingBackstop.mockRejectedValueOnce(new Error('boom'));
    const response = await nightly.GET(request('cron-test-secret'));
    expect(response.status).toBe(500);
    expect(calls).toEqual(['sweep', 'upgrade', 'health']);
  });

  it('hourly: the daily recalculation, then the scheduled reports (Phase 17)', async () => {
    const response = await scheduled.GET(request('cron-test-secret'));
    expect(response.status).toBe(200);
    expect(calls).toEqual(['scheduled', 'reports']);
    expect(await response.json()).toEqual({ scheduled: 5, reports: 3 });
  });

  it('hourly: a failure is reported, not swallowed — and does not stop the other queue', async () => {
    db.enqueueScheduledRecalculation.mockRejectedValueOnce(new Error('boom'));
    const response = await scheduled.GET(request('cron-test-secret'));
    expect(response.status).toBe(500);
    expect(calls).toEqual(['reports']);
  });

  it('hourly: a failure to queue the reports is reported too, after the recalculation was queued', async () => {
    db.enqueueScheduledReports.mockRejectedValueOnce(new Error('boom'));
    const response = await scheduled.GET(request('cron-test-secret'));
    expect(response.status).toBe(500);
    expect(calls).toEqual(['scheduled']);
  });
});
