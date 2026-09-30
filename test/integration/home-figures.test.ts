import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  formatValue, latestCompletePeriodByFlag, loadHome, loadPeriodSnapshots, loadTrend, partialPeriod,
} from '@/modules/dashboard';
import { ENGINE_VERSION } from '@/modules/financial-engine';
import { adminSql, clientFor, createAuthUser, resetFixtures } from './setup';

/**
 * Home, against the database (UX_ARCHITECTURE.md §4).
 *
 * The assertion the plan asks for, and the one that matters: **every figure Home shows equals the
 * `metric_current` snapshot for that month.** A dashboard that recomputes, rounds or adjusts on its
 * way to the screen is a dashboard whose numbers cannot be reconciled with the evidence behind
 * them, and the whole product rests on being able to do that.
 */

let ownerId: string;
let clientUserId: string;
let orgId: string;
let orgSlug: string;
let march: string;
let april: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

/** Writes a snapshot and its pointer, as a calculation run would. */
function writeMetric(periodId: string, key: string, value: string | null, over: {
  unit?: string; basis?: string; assurance?: string; quality?: Record<string, unknown>;
  components?: Record<string, unknown>; runId?: string;
} = {}): string {
  const runId = over.runId ?? one(`
    insert into public.calculation_runs
           (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
    values ('${orgId}', 'recalc_manual', '${ENGINE_VERSION}', '${periodId}', '${periodId}', '2026-06-15', 'succeeded')
    returning id`);

  const snapshotId = one(`
    insert into public.metric_snapshots
           (organization_id, calculation_run_id, period_id, metric_key, dimension_type,
            value, unit, currency, basis, assurance_level, data_quality, components)
    values ('${orgId}', '${runId}', '${periodId}', '${key}', 'none',
            ${value === null ? 'null' : value}, '${over.unit ?? 'money'}', 'GBP',
            '${over.basis ?? 'ledger'}', '${over.assurance ?? 'verified'}',
            '${JSON.stringify(over.quality ?? { completeness: 1, proxy: false, warnings: [], missing: [] })}'::jsonb,
            '${JSON.stringify(over.components ?? {})}'::jsonb)
    returning id`);

  adminSql(`
    insert into public.metric_current
           (organization_id, period_id, metric_key, dimension_type, dimension_id,
            snapshot_id, calculation_run_id)
    values ('${orgId}', '${periodId}', '${key}', 'none', null, '${snapshotId}', '${runId}')
    on conflict do nothing`);

  return snapshotId;
}

/**
 * One accepted record, so Home's first-run gate sees an organisation that has data.
 *
 * These suites write snapshots directly, which no real organisation ever has without records behind
 * them — and Home asks about RECORDS, because a rolled-back import leaves a full set of snapshots
 * whose every cash figure is a known zero (ADR-058.8). A fixture with figures and no records is a
 * state the product cannot reach.
 */
function seedOneRecord(periodId: string): void {
  adminSql(`
    insert into public.ledger_entries
           (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
    values ('${orgId}', '2026-05-15',
            (select id from public.accounts
              where organization_id = '${orgId}' and standard_category = 'revenue' limit 1),
            'credit', 1.00, '${periodId}', 'accepted')
    on conflict do nothing`);
}

function markComplete(periodId: string, complete: boolean): void {
  adminSql(`update public.fiscal_periods set is_complete = ${complete} where id = '${periodId}'`);
}

beforeAll(async () => {
  resetFixtures();
  ownerId = createAuthUser('home-owner@itest.motion');
  clientUserId = createAuthUser('home-client@itest.motion');

  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: 'ITest Home',
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  orgSlug = one(`select slug from public.organizations where id = '${orgId}'`);

  adminSql(`
    set local app.bootstrap = 'on';
    insert into public.organization_memberships (organization_id, user_id, role)
    values ('${orgId}', '${clientUserId}', 'client');`);

  march = one(`
    select id from public.fiscal_periods
     where organization_id = '${orgId}' and period_start = '2026-03-01'`);
  april = one(`
    select id from public.fiscal_periods
     where organization_id = '${orgId}' and period_start = '2026-04-01'`);
});

afterAll(() => resetFixtures());

beforeEach(() => {
  adminSql(`
    begin;
    set local app.purge = 'on';
    delete from public.metric_current where organization_id = '${orgId}';
    delete from public.metric_snapshots where organization_id = '${orgId}';
    delete from public.calculation_runs where organization_id = '${orgId}';
    delete from public.jobs where organization_id = '${orgId}';
    update public.fiscal_periods set is_complete = false where organization_id = '${orgId}';
    delete from public.ledger_entries where organization_id = '${orgId}';
    commit;`);
  seedOneRecord(march);
});

describe('every figure Home shows is the snapshot for that month', () => {
  beforeEach(() => {
    markComplete(march, true);
    writeMetric(march, 'revenue', '20000.00');
    writeMetric(march, 'cost_of_sales', '6000.00');
    writeMetric(march, 'gross_profit', '14000.00');
    writeMetric(march, 'operating_profit', '8000.00');
    writeMetric(march, 'net_profit', '6400.00');
    writeMetric(march, 'closing_cash', '25000.00');
    writeMetric(march, 'receivables', '12000.00');
    writeMetric(march, 'payables', '4500.00');
  });

  it('opens on the latest complete month', async () => {
    const db = clientFor(ownerId);
    const state = await loadHome(db, orgId, orgSlug);
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.view.period.id).toBe(march);
  });

  it('shows exactly the snapshot values, formatted and unaltered', async () => {
    const db = clientFor(ownerId);
    const state = await loadHome(db, orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error(`unexpected state ${state.kind}`);

    const snapshots = await loadPeriodSnapshots(db, orgId, march);
    const byKey = new Map(snapshots.map((s) => [s.metricKey, s]));

    for (const card of state.view.cards) {
      const snapshot = byKey.get(card.metricKey);
      expect(snapshot, `${card.metricKey} has no snapshot`).toBeDefined();
      // The raw value is passed through untouched; only the presentation differs.
      expect(card.rawValue, card.metricKey).toBe(snapshot!.value);
      expect(card.value, card.metricKey).toBe(formatValue(snapshot!));
    }
  });

  it('shows the headline cards in the order §4 fixes', async () => {
    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');
    expect(state.view.cards.map((c) => c.metricKey)).toEqual([
      'revenue', 'gross_profit', 'operating_profit', 'closing_cash', 'receivables', 'payables',
    ]);
  });

  it('puts net profit on the operating-profit card, visibly', async () => {
    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');
    const card = state.view.cards.find((c) => c.metricKey === 'operating_profit');
    // §4: "never tooltip-only".
    expect(card?.secondaryLine?.value).toContain('6,400');
  });

  it('names the basis and the freshness in one line', async () => {
    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');
    expect(state.view.basisLine).toContain('from your accounts');
    expect(state.view.basisLine).toContain('Mar 2026 (latest complete month)');
  });
});

describe('a figure that cannot be computed shows a dash, never a zero (§4)', () => {
  it('renders — with the reason from the snapshot', async () => {
    markComplete(march, true);
    writeMetric(march, 'revenue', '20000.00');
    writeMetric(march, 'closing_cash', null, {
      quality: { completeness: 0, proxy: false, warnings: [], missing: ['no_opening_cash'] },
    });

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    const cash = state.view.cards.find((c) => c.metricKey === 'closing_cash');
    // A zero here would tell somebody they have no money, which is a different claim entirely.
    expect(cash?.value).toBe('—');
    expect(cash?.rawValue).toBeNull();
    expect(cash?.status.tooltip).toContain('opening bank balance');
  });
});

describe('the gross-profit card is hidden without direct-cost accounts (CD-05)', () => {
  it('omits it rather than showing a margin of 100%', async () => {
    markComplete(march, true);
    writeMetric(march, 'revenue', '20000.00');
    writeMetric(march, 'gross_profit', null, {
      quality: {
        completeness: 1, proxy: false, warnings: [], missing: ['no_cost_of_sales_accounts'],
      },
    });
    writeMetric(march, 'operating_profit', '8000.00');

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    expect(state.view.hidesGrossProfit).toBe(true);
    expect(state.view.cards.map((c) => c.metricKey)).not.toContain('gross_profit');
  });
});

describe('the partial current month gets one line and nothing more (§4)', () => {
  it('opens on the complete month and lines up the partial one beneath', async () => {
    markComplete(march, true);
    writeMetric(march, 'revenue', '20000.00');

    markComplete(april, false);
    writeMetric(april, 'cash_inflows', '6000.00');
    writeMetric(april, 'cash_outflows', '4100.00');

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    // Home stays on March: a part-month compared with a whole one misleads.
    expect(state.view.period.id).toBe(march);
    expect(state.view.partialMonth?.label).toBe('Apr 2026 so far');
    expect(state.view.partialMonth?.summary).toContain('money in');
    expect(state.view.partialMonth?.summary).toContain('money out');
  });

  it('shows no partial line when the latest month is complete', async () => {
    markComplete(march, true);
    markComplete(april, true);
    writeMetric(april, 'revenue', '21000.00');

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');
    expect(state.view.period.id).toBe(april);
    expect(state.view.partialMonth).toBeNull();
  });
});

describe('the bank-only variant (ADR-035)', () => {
  it('shows the three cash cards when no P&L source covers the month', async () => {
    markComplete(march, true);
    writeMetric(march, 'revenue', null, {
      basis: 'none',
      quality: { completeness: 0, proxy: false, warnings: [], missing: ['no_source_covers_period'] },
    });
    writeMetric(march, 'cash_inflows', '18000.00', { basis: 'bank' });
    writeMetric(march, 'cash_outflows', '14000.00', { basis: 'bank' });
    writeMetric(march, 'net_cash_movement', '4000.00', { basis: 'bank' });
    writeMetric(march, 'closing_cash', '25000.00', { basis: 'bank' });

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    expect(state.kind).toBe('bank_only');
    if (state.kind !== 'bank_only') return;

    expect(state.view.cards.map((c) => c.metricKey))
      .toEqual(['cash_inflows', 'cash_outflows', 'net_cash_movement', 'closing_cash']);
  });
});

describe('first run and awaiting review are different pages (§6)', () => {
  // The one suite that needs NO records: it is about the state before any exist.
  beforeEach(() => {
    adminSql(`
      begin;
      set local app.purge = 'on';
      delete from public.ledger_entries where organization_id = '${orgId}';
      commit;`);
  });

  it('says first run when nothing has been added', async () => {
    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    expect(state.kind).toBe('first_run');
  });

  it('says a review is waiting when a batch is awaiting one', async () => {
    const doc = one(`
      insert into public.source_documents
             (organization_id, storage_path, original_filename, mime_type, byte_size, sha256,
              status, document_kind)
      values ('${orgId}', '${orgId}/h/march.csv', 'march-statement.csv', 'text/csv', 10,
              decode('a1','hex'), 'ready', 'bank_statement')
      returning id`);
    adminSql(`
      insert into public.import_batches
             (organization_id, source_document_id, import_type, target_table, status,
              extraction_method, row_counts)
      values ('${orgId}', '${doc}', 'bank_statement', 'bank_transactions', 'awaiting_review',
              'csv', '{"total": 312, "error": 4}'::jsonb)`);

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    expect(state.kind).toBe('awaiting_review');
    if (state.kind !== 'awaiting_review') return;
    expect(state.filename).toBe('march-statement.csv');
    expect(state.rowCount).toBe(312);
  });
});

describe('the recalculation banner keys off the job, not the run (§7.1, F-D-03)', () => {
  it('shows while a calculation job is queued', async () => {
    markComplete(march, true);
    writeMetric(march, 'revenue', '20000.00');
    adminSql(`
      insert into public.jobs (organization_id, job_type, payload)
      values ('${orgId}', 'calculation.run', '{}'::jsonb)`);

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');
    expect(state.view.recalculating).toBe(true);
  });

  it('does not show for an orphaned run row with no job', async () => {
    markComplete(march, true);
    writeMetric(march, 'revenue', '20000.00');
    adminSql(`
      insert into public.calculation_runs
             (organization_id, trigger, engine_version, period_from, period_to, as_of, status, started_at)
      values ('${orgId}', 'recalc_manual', '1.0.0', '${march}', '${march}', '2026-06-15',
              'running', now() - interval '2 days')`);

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');
    // A run row that was orphaned would otherwise leave the banner up forever.
    expect(state.view.recalculating).toBe(false);
  });
});

describe('what each role can see', () => {
  beforeEach(() => {
    markComplete(march, true);
    writeMetric(march, 'revenue', '20000.00');
  });

  it('lets a client read the figures', async () => {
    const state = await loadHome(clientFor(clientUserId), orgId, orgSlug);
    expect(state.kind).toBe('ready');
  });

  it('refuses a stranger with not-found, never with a partial page', async () => {
    const stranger = createAuthUser('home-stranger@itest.motion');
    // The uniform answer (SECURITY_MODEL.md §14): a caller with no access learns nothing about
    // whether the organisation exists, let alone what it earned. In production the layout has
    // already returned 404 before Home runs; this asserts the read layer would not leak either.
    await expect(loadHome(clientFor(stranger), orgId, orgSlug)).rejects.toThrow();
  });

  it('shows a client the same figures an owner sees', async () => {
    const owner = await loadHome(clientFor(ownerId), orgId, orgSlug);
    const client = await loadHome(clientFor(clientUserId), orgId, orgSlug);
    if (owner.kind !== 'ready' || client.kind !== 'ready') throw new Error('expected ready');
    expect(client.view.cards.map((c) => c.value)).toEqual(owner.view.cards.map((c) => c.value));
  });
});

describe('the trend leaves a gap where a month has no figure (§4)', () => {
  it('returns null rather than zero for an uncomputed month', async () => {
    markComplete(march, true);
    writeMetric(march, 'revenue', '20000.00');
    markComplete(april, true);
    // April deliberately has no revenue snapshot.
    writeMetric(april, 'closing_cash', '25000.00');

    const db = clientFor(ownerId);
    const state = await loadHome(db, orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    const trend = await loadTrend(db, orgId, state.view.periods);
    const revenue = trend.find((s) => s.key === 'revenue');
    const aprilPoint = revenue?.points.find((p) => p.period === april);
    expect(aprilPoint?.value, 'a missing month is a gap, not a zero').toBeNull();
  });
});

describe('the period helpers', () => {
  it('finds the latest complete month', () => {
    const periods = [
      { id: 'a', label: 'Apr', periodStart: '2026-04-01', periodEnd: '2026-04-30', isComplete: false },
      { id: 'm', label: 'Mar', periodStart: '2026-03-01', periodEnd: '2026-03-31', isComplete: true },
    ];
    expect(latestCompletePeriodByFlag(periods)?.id).toBe('m');
  });

  it('offers a partial month only when it is after the complete one', () => {
    const periods = [
      { id: 'a', label: 'Apr', periodStart: '2026-04-01', periodEnd: '2026-04-30', isComplete: false },
      { id: 'm', label: 'Mar', periodStart: '2026-03-01', periodEnd: '2026-03-31', isComplete: true },
    ];
    expect(partialPeriod(periods, new Set(['a', 'm']))?.id).toBe('a');
    // A partial month with no data is not worth a line.
    expect(partialPeriod(periods, new Set(['m']))).toBeNull();
  });
});

describe('a suspended organisation keeps its frozen Home (ADR-044.4, ADR-068)', () => {
  /*
   * PRODUCTION_AUDIT.md H1, executed: the five tables that admitted `suspended_member` were two
   * pointer tables and three others, and neither the month nor the figures Home shows were among
   * them. Under suspension Home rendered "add your first file" beneath the suspension banner.
   */
  it('shows the figures it showed before suspension, and nothing written since', async () => {
    markComplete(march, true);
    writeMetric(march, 'revenue', '20000.00');
    writeMetric(march, 'closing_cash', '25000.00');
    const before = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (before.kind !== 'ready' && before.kind !== 'bank_only') {
      throw new Error(`expected figures before suspension, got ${before.kind}`);
    }

    adminSql(`update public.organizations set status = 'suspended' where id = '${orgId}'`);
    try {
      // A later run's figure for the same cell that nothing points at: history, which a suspended
      // member must not see. `metric_current` keeps its first pointer (`on conflict do nothing`).
      writeMetric(march, 'revenue', '99999.00');

      const db = clientFor(ownerId);
      const role = await db.schema('api').rpc('my_context', { p_slug: orgSlug });
      expect((role.data as Array<{ role: string }>)[0]?.role).toBe('suspended_member');

      const frozen = await loadHome(db, orgId, orgSlug, undefined, { suspended: true });
      expect(frozen.kind).toBe(before.kind);
      if (frozen.kind !== 'ready' && frozen.kind !== 'bank_only') return;
      expect(frozen.view.period.id).toBe(march);
      expect(frozen.view.cards.map((c) => [c.metricKey, c.rawValue]))
        .toEqual(before.view.cards.map((c) => [c.metricKey, c.rawValue]));

      // The policy, directly: exactly the pointed-at snapshot, not the newer one beside it.
      const visible = await db.from('metric_snapshots').select('value')
        .eq('organization_id', orgId).eq('metric_key', 'revenue');
      expect(visible.error).toBeNull();
      expect((visible.data ?? []).map((r) => String(r.value))).toEqual(['20000']);
    } finally {
      adminSql(`update public.organizations set status = 'active' where id = '${orgId}'`);
    }
  });
});
