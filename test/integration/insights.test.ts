import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadInsights } from '@/modules/dashboard';
import { ensurePeriods, periodId } from '@/db/app/shared';
import { auth } from '@/db/firestore';
import { metricCellId, newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, fs } from './setup';
import { createOrgFixture } from './r-fixtures';

/**
 * Insights (UX_ARCHITECTURE.md §3.1, §6; IMPLEMENTATION_PLAN.md Phase 7 slice 5).
 *
 * The property under test: **movements are ranked by MONEY, not by percentage.** A category that
 * doubled from £40 to £80 is not news; one that rose 12% on £90,000 is. Ranking by percentage would
 * put the noise at the top of the page every month, which is the failure this page exists to avoid.
 *
 * Snapshots and their `metric_current` pointers are written as fixtures in the shapes the engine
 * writes (FIRESTORE_DATA_MODEL.md §3: values are decimal strings); the page's read is the real one.
 */

const RUN = `i${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.insights.itest.motion`;

let ownerId: string;
let orgId: string;
let orgSlug: string;
let march: string;
let april: string;
let january: string;
let runId: string;

async function writeMetric(period: string, key: string, value: string | null, over: {
  dimensionType?: string; dimensionId?: string | null; dimensionKey?: string | null;
  components?: Record<string, unknown>; quality?: Record<string, unknown>;
} = {}): Promise<void> {
  const snapshotId = newId();
  const now = nowIso();
  const dimension = {
    dimension_type: over.dimensionType ?? 'none',
    dimension_id: over.dimensionId ?? null,
    dimension_key: over.dimensionKey ?? null,
  };
  await orgRow(fs(), orgId, 'metric_snapshots', snapshotId).set({
    id: snapshotId, organization_id: orgId, calculation_run_id: runId, period_id: period, metric_key: key,
    ...dimension, value, unit: 'money', currency: 'GBP', basis: 'ledger', assurance_level: 'verified',
    data_quality: over.quality ?? { completeness: 1, proxy: false, warnings: [], missing: [] },
    components: over.components ?? {}, evidence_query: null, created_at: now,
  });
  // `on conflict do nothing`: the first pointer to a cell stands.
  const cell = orgRow(fs(), orgId, 'metric_current', metricCellId({ period_id: period, metric_key: key, ...dimension }));
  if (!(await cell.get()).exists) {
    await cell.set({
      organization_id: orgId, period_id: period, metric_key: key, ...dimension, snapshot_id: snapshotId,
      calculation_run_id: runId, previous_snapshot_id: null, updated_at: now,
    });
  }
}

const complete = async (...ids: string[]) => {
  for (const id of ids) await orgRow(fs(), orgId, 'fiscal_periods', id).update({ is_complete: true });
};

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  const org = await createOrgFixture({ name: `ITest Insights ${RUN}`, ownerId });
  orgId = org.id;
  orgSlug = org.slug;
  await ensurePeriods(fs(), orgId, '2026-01-01', '2026-04-01');
  january = periodId(orgId, '2026-01-01');
  march = periodId(orgId, '2026-03-01');
  april = periodId(orgId, '2026-04-01');
});

afterAll(async () => {
  await deleteOrg(orgId);
  await fs().collection('profiles').doc(ownerId).delete();
  await auth().deleteUser(ownerId).catch(() => undefined);
});

beforeEach(async () => {
  for (const table of ['metric_current', 'metric_snapshots', 'calculation_runs'] as const) {
    await fs().recursiveDelete(orgCollection(fs(), orgId, table));
  }
  const periods = await orgCollection(fs(), orgId, 'fiscal_periods').get();
  for (const p of periods.docs) await p.ref.update({ is_complete: false });

  runId = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'calculation_runs', runId).set({
    id: runId, organization_id: orgId, job_id: null, trigger: 'recalc_manual', trigger_ref_id: null,
    engine_version: '1.0.0', period_from: january, period_to: april, as_of: '2026-06-15', as_of_ts: now,
    status: 'succeeded', failure_reason: null, stale: false, input_fingerprint: null, chunks: [],
    progress: {}, started_at: now, finished_at: now, duration_ms: 1, error: null, stats: {},
    created_at: now, updated_at: now,
  });
});

describe('two months are needed before anything can have changed (§6)', () => {
  it('shows the empty state with fewer than two months of data', async () => {
    await complete(march);
    await writeMetric(march, 'revenue', '20000.00');

    const state = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    expect(state.kind).toBe('needs_two_periods');
  });
});

describe('movements are ranked by money, not by percentage', () => {
  beforeEach(async () => {
    await complete(march, april);
    await writeMetric(march, 'revenue', '90000.00');
    await writeMetric(april, 'revenue', '100800.00');

    // A large movement on a large base: 12% of £90,000.
    await writeMetric(april, 'revenue.variance.prev_period', '10800.00', {
      components: { current: '100800.00', comparison: '90000.00', pct_change: '0.12' },
    });
    // A spectacular percentage on a trivial base: £40 doubling.
    await writeMetric(april, 'operating_expenses.variance.prev_period', '40.00', {
      components: { current: '80.00', comparison: '40.00', pct_change: '1.0' },
    });
    // A middling movement.
    await writeMetric(april, 'cost_of_sales.variance.prev_period', '3000.00', {
      components: { current: '9000.00', comparison: '6000.00', pct_change: '0.5' },
    });
  });

  it('puts the biggest money movement first, not the biggest percentage', async () => {
    const state = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    const all = [...state.view.unfavourable, ...state.view.favourable];
    const bySize = [...all].sort((a, b) => Number(b.magnitude) - Number(a.magnitude));

    // £10,800 outranks a 100% rise on £40. Ranking by percentage would invert this every month.
    expect(bySize[0]?.metricKey).toBe('revenue');
    expect(bySize[bySize.length - 1]?.metricKey).toBe('operating_expenses');
  });

  it('separates what went well from what needs attention, per metric', async () => {
    const state = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    // A rise in sales is good news; a rise in costs is not.
    expect(state.view.favourable.map((m) => m.metricKey)).toContain('revenue');
    expect(state.view.unfavourable.map((m) => m.metricKey)).toContain('cost_of_sales');
    expect(state.view.unfavourable.map((m) => m.metricKey)).toContain('operating_expenses');
  });

  it('ranks unfavourable movements by money too', async () => {
    const state = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    const magnitudes = state.view.unfavourable.map((m) => Number(m.magnitude));
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);
  });

  it('shows the before and after so the change can be checked', async () => {
    const state = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    const revenue = state.view.favourable.find((m) => m.metricKey === 'revenue');
    expect(revenue?.comparison).toContain('90,000');
    expect(revenue?.current).toContain('100,800');
    expect(revenue?.change).toContain('10,800');
    expect(revenue?.percent).toContain('12');
  });

  it('gives every movement a Why link to its evidence', async () => {
    const state = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    for (const movement of [...state.view.favourable, ...state.view.unfavourable]) {
      expect(movement.whyHref).toContain('metric=');
      expect(movement.whyHref).toContain(`period=${april}`);
    }
  });

  it('is deterministic under repeated loads', async () => {
    const first = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    const second = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('the drivers behind a movement come from dimensioned snapshots', () => {
  it('names the category that moved', async () => {
    await complete(march, april);
    await writeMetric(march, 'revenue', '90000.00');
    await writeMetric(april, 'revenue', '90000.00');
    await writeMetric(april, 'expense_by_category.variance.prev_period', '2900.00', {
      dimensionType: 'standard_category', dimensionKey: 'marketing',
      components: { current: '6300.00', comparison: '3400.00', pct_change: '0.85' },
    });

    const state = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    const driver = state.view.unfavourable.find((m) => m.metricKey === 'expense_by_category');
    expect(driver, 'the category movement must appear').toBeDefined();
    expect(driver?.change).toContain('2,900');
    // The driver names WHICH category moved — that is the whole point of a dimensioned breakdown.
    expect(driver?.dimensionLabel).toBe('marketing');
  });
});

describe('a gap in the data is stated, not hidden (§6)', () => {
  it('says which month it is really comparing with', async () => {
    // March compared with January, because February was never uploaded.
    await complete(january, march);
    await writeMetric(january, 'revenue', '80000.00');
    await writeMetric(march, 'revenue', '90000.00');
    await writeMetric(march, 'revenue.variance.prev_period', '10000.00', {
      components: { current: '90000.00', comparison: '80000.00', pct_change: '0.125' },
    });

    const state = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    expect(state.view.period.id).toBe(march);
    expect(state.view.comparison?.id).toBe(january);
    // Presenting a two-month change as a one-month change would overstate every movement.
    expect(state.view.comparisonIsAdjacent).toBe(false);
  });

  it('reports an adjacent comparison as adjacent', async () => {
    await complete(march, april);
    await writeMetric(march, 'revenue', '90000.00');
    await writeMetric(april, 'revenue', '100000.00');

    const state = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');
    expect(state.view.comparisonIsAdjacent).toBe(true);
  });
});

describe('a variance across two bases is shown without a percentage (ADR-030)', () => {
  it('reports the amount and flags the basis rather than a misleading ratio', async () => {
    await complete(march, april);
    await writeMetric(march, 'revenue', '90000.00');
    await writeMetric(april, 'revenue', '100000.00');
    await writeMetric(april, 'revenue.variance.prev_period', '10000.00', {
      components: { current: '100000.00', comparison: '90000.00', pct_change: '0.111' },
      quality: { completeness: 1, proxy: false, warnings: ['basis_differs'], missing: [] },
    });

    const state = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    const revenue = state.view.favourable.find((m) => m.metricKey === 'revenue');
    expect(revenue?.basisDiffers).toBe(true);
    // The percentage would compare a bank figure with a ledger figure.
    expect(revenue?.percent).toBeNull();
    expect(revenue?.change).toContain('10,000');
  });
});
