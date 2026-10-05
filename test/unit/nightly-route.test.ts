import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cron routes (FU-6, ADR-131, ADR-135): the nightly sweep and engine-upgrade queue, and the HOURLY
 * daily-recalculation enqueue — which the database keeps to one run per organisation and local date.
 */

const calls: string[] = [];
const db = {
  enqueueNightlySweep: vi.fn(async () => { calls.push('sweep'); return 'job-sweep'; }),
  enqueueEngineUpgrade: vi.fn(async (_v: string) => { calls.push('upgrade'); return 2; }),
  enqueueScheduledRecalculation: vi.fn(async () => { calls.push('scheduled'); return 5; }),
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

  it('nightly: the sweep, then the engine upgrade — and not the daily recalculation', async () => {
    const response = await nightly.GET(request('cron-test-secret'));
    expect(response.status).toBe(200);
    expect(calls).toEqual(['sweep', 'upgrade']);
  });

  it('hourly: the daily recalculation only', async () => {
    const response = await scheduled.GET(request('cron-test-secret'));
    expect(response.status).toBe(200);
    expect(calls).toEqual(['scheduled']);
    expect(await response.json()).toEqual({ scheduled: 5 });
  });

  it('hourly: a failure is reported, not swallowed', async () => {
    db.enqueueScheduledRecalculation.mockRejectedValueOnce(new Error('boom'));
    const response = await scheduled.GET(request('cron-test-secret'));
    expect(response.status).toBe(500);
  });
});
