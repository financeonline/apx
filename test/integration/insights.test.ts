import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadInsights } from '@/modules/dashboard';
import { adminSql, clientFor, createAuthUser, resetFixtures } from './setup';

/**
 * Insights (UX_ARCHITECTURE.md §3.1, §6; IMPLEMENTATION_PLAN.md Phase 7 slice 5).
 *
 * The property under test: **movements are ranked by MONEY, not by percentage.** A category that
 * doubled from £40 to £80 is not news; one that rose 12% on £90,000 is. Ranking by percentage would
 * put the noise at the top of the page every month, which is the failure this page exists to avoid.
 */

let ownerId: string;
let orgId: string;
let orgSlug: string;
let march: string;
let april: string;
let january: string;
let runId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function writeMetric(periodId: string, key: string, value: string | null, over: {
  dimensionType?: string; dimensionId?: string | null; dimensionKey?: string | null;
  components?: Record<string, unknown>; quality?: Record<string, unknown>;
} = {}): void {
  const snapshotId = one(`
    insert into public.metric_snapshots
           (organization_id, calculation_run_id, period_id, metric_key, dimension_type, dimension_id,
            dimension_key, value, unit, currency, basis, assurance_level, data_quality, components)
    values ('${orgId}', '${runId}', '${periodId}', '${key}',
            '${over.dimensionType ?? 'none'}',
            ${over.dimensionId ? `'${over.dimensionId}'` : 'null'},
            ${over.dimensionKey ? `'${over.dimensionKey}'` : 'null'},
            ${value === null ? 'null' : value}, 'money', 'GBP', 'ledger', 'verified',
            '${JSON.stringify(over.quality ?? { completeness: 1, proxy: false, warnings: [], missing: [] })}'::jsonb,
            '${JSON.stringify(over.components ?? {})}'::jsonb)
    returning id`);

  adminSql(`
    insert into public.metric_current
           (organization_id, period_id, metric_key, dimension_type, dimension_id, dimension_key,
            snapshot_id, calculation_run_id)
    values ('${orgId}', '${periodId}', '${key}', '${over.dimensionType ?? 'none'}',
            ${over.dimensionId ? `'${over.dimensionId}'` : 'null'},
            ${over.dimensionKey ? `'${over.dimensionKey}'` : 'null'}, '${snapshotId}', '${runId}')
    on conflict do nothing`);
}

beforeAll(async () => {
  resetFixtures();
  ownerId = createAuthUser('insights-owner@itest.motion');
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: 'ITest Insights',
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  orgSlug = one(`select slug from public.organizations where id = '${orgId}'`);

  const periodId = (start: string) => one(`
    select id from public.fiscal_periods
     where organization_id = '${orgId}' and period_start = '${start}'`);
  january = periodId('2026-01-01');
  march = periodId('2026-03-01');
  april = periodId('2026-04-01');
});

afterAll(() => resetFixtures());

beforeEach(() => {
  adminSql(`
    begin;
    set local app.purge = 'on';
    delete from public.metric_current where organization_id = '${orgId}';
    delete from public.metric_snapshots where organization_id = '${orgId}';
    delete from public.calculation_runs where organization_id = '${orgId}';
    update public.fiscal_periods set is_complete = false where organization_id = '${orgId}';
    commit;`);

  runId = one(`
    insert into public.calculation_runs
           (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
    values ('${orgId}', 'recalc_manual', '1.0.0', '${january}', '${april}', '2026-06-15', 'succeeded')
    returning id`);
});

describe('two months are needed before anything can have changed (§6)', () => {
  it('shows the empty state with fewer than two months of data', async () => {
    adminSql(`update public.fiscal_periods set is_complete = true where id = '${march}'`);
    writeMetric(march, 'revenue', '20000.00');

    const state = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    expect(state.kind).toBe('needs_two_periods');
  });
});

describe('movements are ranked by money, not by percentage', () => {
  beforeEach(() => {
    adminSql(`
      update public.fiscal_periods set is_complete = true
       where id in ('${march}', '${april}')`);
    writeMetric(march, 'revenue', '90000.00');
    writeMetric(april, 'revenue', '100800.00');

    // A large movement on a large base: 12% of £90,000.
    writeMetric(april, 'revenue.variance.prev_period', '10800.00', {
      components: { current: '100800.00', comparison: '90000.00', pct_change: '0.12' },
    });
    // A spectacular percentage on a trivial base: £40 doubling.
    writeMetric(april, 'operating_expenses.variance.prev_period', '40.00', {
      components: { current: '80.00', comparison: '40.00', pct_change: '1.0' },
    });
    // A middling movement.
    writeMetric(april, 'cost_of_sales.variance.prev_period', '3000.00', {
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
    adminSql(`
      update public.fiscal_periods set is_complete = true
       where id in ('${march}', '${april}')`);
    writeMetric(march, 'revenue', '90000.00');
    writeMetric(april, 'revenue', '90000.00');
    writeMetric(april, 'expense_by_category.variance.prev_period', '2900.00', {
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
    adminSql(`
      update public.fiscal_periods set is_complete = true
       where id in ('${january}', '${march}')`);
    writeMetric(january, 'revenue', '80000.00');
    writeMetric(march, 'revenue', '90000.00');
    writeMetric(march, 'revenue.variance.prev_period', '10000.00', {
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
    adminSql(`
      update public.fiscal_periods set is_complete = true
       where id in ('${march}', '${april}')`);
    writeMetric(march, 'revenue', '90000.00');
    writeMetric(april, 'revenue', '100000.00');

    const state = await loadInsights(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');
    expect(state.view.comparisonIsAdjacent).toBe(true);
  });
});

describe('a variance across two bases is shown without a percentage (ADR-030)', () => {
  it('reports the amount and flags the basis rather than a misleading ratio', async () => {
    adminSql(`
      update public.fiscal_periods set is_complete = true
       where id in ('${march}', '${april}')`);
    writeMetric(march, 'revenue', '90000.00');
    writeMetric(april, 'revenue', '100000.00');
    writeMetric(april, 'revenue.variance.prev_period', '10000.00', {
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
