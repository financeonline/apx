import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatValue, latestCompletePeriodByFlag, loadHome, loadPeriodSnapshots, loadTrend, partialPeriod,
} from '@/modules/dashboard';
import { ENGINE_VERSION } from '@/modules/financial-engine';
import { auth } from '@/db/firestore';
import { orgRows } from '@/db/rls';
import { rpc, clientFor, createAuthUser, deleteOrg, fs } from './setup';
import { addMember, createOrgFixture } from './r-fixtures';
import {
  clearJobs, clearTables, ensureMonths, monthId, seedLedgerEntry, setComplete, systemAccountId,
  writeJob, writeMetric as writeMetricOf, writeRun,
} from './r-metrics';
import { writeImportBatch, writeSourceDocument } from './r-records';

/**
 * Home, against the database (UX_ARCHITECTURE.md §4).
 *
 * The assertion the plan asks for, and the one that matters: **every figure Home shows equals the
 * `metric_current` snapshot for that month.** A dashboard that recomputes, rounds or adjusts on its
 * way to the screen is a dashboard whose numbers cannot be reconciled with the evidence behind
 * them, and the whole product rests on being able to do that.
 *
 * Run-unique fixtures written into Firestore as a calculation run leaves them (`r-metrics.ts`);
 * only this suite's organisation and people are removed.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const RUN = `h${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.home.itest.motion`;

let ownerId: string;
let clientUserId: string;
let orgId: string;
let orgSlug: string;
let march: string;
let april: string;
const users: string[] = [];

/** Writes a snapshot and its pointer, as a calculation run would. */
function writeMetric(periodId: string, key: string, value: string | null, over: {
  unit?: string; basis?: string; assurance?: string; quality?: Record<string, unknown>;
  components?: Record<string, unknown>; runId?: string;
} = {}): Promise<string> {
  return writeMetricOf(orgId, periodId, key, value, { ...over, engineVersion: ENGINE_VERSION });
}

/**
 * One accepted record, so Home's first-run gate sees an organisation that has data.
 *
 * These suites write snapshots directly, which no real organisation ever has without records behind
 * them — and Home asks about RECORDS, because a rolled-back import leaves a full set of snapshots
 * whose every cash figure is a known zero (ADR-058.8). A fixture with figures and no records is a
 * state the product cannot reach.
 */
async function seedOneRecord(periodId: string): Promise<void> {
  await seedLedgerEntry(orgId, {
    id: `seed-${RUN}`, accountId: await systemAccountId(orgId, 'revenue'), period: periodId,
    entryDate: '2026-05-15', direction: 'credit', amount: '1.00',
  });
}

const markComplete = (periodId: string, complete: boolean) => setComplete(orgId, periodId, complete);

async function user(label: string): Promise<string> {
  const id = await createAuthUser(`${label}@${DOMAIN}`);
  users.push(id);
  return id;
}

beforeAll(async () => {
  ownerId = await user('home-owner');
  clientUserId = await user('home-client');

  const org = await createOrgFixture({ name: `ITest Home ${RUN}`, ownerId });
  orgId = org.id;
  orgSlug = org.slug;
  await addMember(orgId, clientUserId, 'client');
  await ensureMonths(orgId, '2026-01-01', '2026-12-31');

  march = monthId(orgId, '2026-03');
  april = monthId(orgId, '2026-04');
});

afterAll(async () => {
  await clearJobs(orgId);
  await deleteOrg(orgId);
  for (const id of users) {
    await fs().collection('profiles').doc(id).delete();
    await auth().deleteUser(id).catch(() => undefined);
  }
});

beforeEach(async () => {
  await clearTables(orgId, ['metric_current', 'metric_snapshots', 'calculation_runs', 'ledger_entries', 'import_batches', 'source_documents']);
  await clearJobs(orgId);
  const periods = await orgRows<{ id: string }>(clientFor(ownerId), orgId, 'fiscal_periods');
  for (const p of periods) await markComplete(p.id, false);
  await seedOneRecord(march);
});

describe('every figure Home shows is the snapshot for that month', () => {
  beforeEach(async () => {
    await markComplete(march, true);
    await writeMetric(march, 'revenue', '20000.00');
    await writeMetric(march, 'cost_of_sales', '6000.00');
    await writeMetric(march, 'gross_profit', '14000.00');
    await writeMetric(march, 'operating_profit', '8000.00');
    await writeMetric(march, 'net_profit', '6400.00');
    await writeMetric(march, 'closing_cash', '25000.00');
    await writeMetric(march, 'receivables', '12000.00');
    await writeMetric(march, 'payables', '4500.00');
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
    // One "Based on", the sources listed ("Based on your accounts"), never "Based on from your accounts".
    expect(state.view.basisLine).toContain('Based on your accounts');
    expect(state.view.basisLine).toContain('Mar 2026 (latest complete month)');
  });
});

describe('a figure that cannot be computed shows a dash, never a zero (§4)', () => {
  it('renders — with the reason from the snapshot', async () => {
    await markComplete(march, true);
    await writeMetric(march, 'revenue', '20000.00');
    await writeMetric(march, 'closing_cash', null, {
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
    await markComplete(march, true);
    await writeMetric(march, 'revenue', '20000.00');
    await writeMetric(march, 'gross_profit', null, {
      quality: {
        completeness: 1, proxy: false, warnings: [], missing: ['no_cost_of_sales_accounts'],
      },
    });
    await writeMetric(march, 'operating_profit', '8000.00');

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    expect(state.view.hidesGrossProfit).toBe(true);
    expect(state.view.cards.map((c) => c.metricKey)).not.toContain('gross_profit');
  });
});

describe('the partial current month gets one line and nothing more (§4)', () => {
  it('opens on the complete month and lines up the partial one beneath', async () => {
    await markComplete(march, true);
    await writeMetric(march, 'revenue', '20000.00');

    await markComplete(april, false);
    await writeMetric(april, 'cash_inflows', '6000.00');
    await writeMetric(april, 'cash_outflows', '4100.00');

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');

    // Home stays on March: a part-month compared with a whole one misleads.
    expect(state.view.period.id).toBe(march);
    expect(state.view.partialMonth?.label).toBe('Apr 2026 so far');
    expect(state.view.partialMonth?.summary).toContain('money in');
    expect(state.view.partialMonth?.summary).toContain('money out');
  });

  it('shows no partial line when the latest month is complete', async () => {
    await markComplete(march, true);
    await markComplete(april, true);
    await writeMetric(april, 'revenue', '21000.00');

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');
    expect(state.view.period.id).toBe(april);
    expect(state.view.partialMonth).toBeNull();
  });
});

describe('the bank-only variant (ADR-035)', () => {
  it('shows the three cash cards when no P&L source covers the month', async () => {
    await markComplete(march, true);
    await writeMetric(march, 'revenue', null, {
      basis: 'none',
      quality: { completeness: 0, proxy: false, warnings: [], missing: ['no_source_covers_period'] },
    });
    await writeMetric(march, 'cash_inflows', '18000.00', { basis: 'bank' });
    await writeMetric(march, 'cash_outflows', '14000.00', { basis: 'bank' });
    await writeMetric(march, 'net_cash_movement', '4000.00', { basis: 'bank' });
    await writeMetric(march, 'closing_cash', '25000.00', { basis: 'bank' });

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    expect(state.kind).toBe('bank_only');
    if (state.kind !== 'bank_only') return;

    expect(state.view.cards.map((c) => c.metricKey))
      .toEqual(['cash_inflows', 'cash_outflows', 'net_cash_movement', 'closing_cash']);
  });
});

describe('first run and awaiting review are different pages (§6)', () => {
  // The one suite that needs NO records: it is about the state before any exist.
  beforeEach(async () => {
    await clearTables(orgId, ['ledger_entries']);
  });

  it('says first run when nothing has been added', async () => {
    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    expect(state.kind).toBe('first_run');
  });

  it('says a review is waiting when a batch is awaiting one', async () => {
    const doc = await writeSourceDocument(orgId, {
      path: `${orgId}/h/march.csv`, filename: 'march-statement.csv', kind: 'bank_statement', sha256: 'a1',
    });
    await writeImportBatch(orgId, {
      documentId: doc, importType: 'bank_statement', targetTable: 'bank_transactions', status: 'awaiting_review',
      rowCounts: { total: 312, error: 4 },
    });

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    expect(state.kind).toBe('awaiting_review');
    if (state.kind !== 'awaiting_review') return;
    expect(state.filename).toBe('march-statement.csv');
    expect(state.rowCount).toBe(312);
  });
});

describe('the recalculation banner keys off the job, not the run (§7.1, F-D-03)', () => {
  it('shows while a calculation job is queued', async () => {
    await markComplete(march, true);
    await writeMetric(march, 'revenue', '20000.00');
    // Parked a month out, so no worker draining the shared queue takes it while Home looks.
    const jobId = await writeJob(orgId, { jobType: 'calculation.run', payload: {} });
    await fs().collection('jobs').doc(jobId).update({ run_after: new Date(Date.now() + 30 * 86_400_000).toISOString() });

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');
    expect(state.view.recalculating).toBe(true);
  });

  it('does not show for an orphaned run row with no job', async () => {
    await markComplete(march, true);
    await writeMetric(march, 'revenue', '20000.00');
    await writeRun(orgId, {
      periodFrom: march, status: 'running', startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), finishedAt: null,
    });

    const state = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (state.kind !== 'ready') throw new Error('expected ready');
    // A run row that was orphaned would otherwise leave the banner up forever.
    expect(state.view.recalculating).toBe(false);
  });
});

describe('what each role can see', () => {
  beforeEach(async () => {
    await markComplete(march, true);
    await writeMetric(march, 'revenue', '20000.00');
  });

  it('lets a client read the figures', async () => {
    const state = await loadHome(clientFor(clientUserId), orgId, orgSlug);
    expect(state.kind).toBe('ready');
  });

  it('refuses a stranger with not-found, never with a partial page', async () => {
    const stranger = await user('home-stranger');
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
    await markComplete(march, true);
    await writeMetric(march, 'revenue', '20000.00');
    await markComplete(april, true);
    // April deliberately has no revenue snapshot.
    await writeMetric(april, 'closing_cash', '25000.00');

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
    await markComplete(march, true);
    await writeMetric(march, 'revenue', '20000.00');
    await writeMetric(march, 'closing_cash', '25000.00');
    const before = await loadHome(clientFor(ownerId), orgId, orgSlug);
    if (before.kind !== 'ready' && before.kind !== 'bank_only') {
      throw new Error(`expected figures before suspension, got ${before.kind}`);
    }

    await fs().collection('organizations').doc(orgId).update({ status: 'suspended' });
    try {
      // A later run's figure for the same cell that nothing points at: history, which a suspended
      // member must not see. `metric_current` keeps its first pointer (`on conflict do nothing`).
      await writeMetric(march, 'revenue', '99999.00');

      const db = clientFor(ownerId);
      const role = await rpc(db, 'my_context', { p_slug: orgSlug });
      expect((role.data as Array<{ role: string }>)[0]?.role).toBe('suspended_member');

      const frozen = await loadHome(db, orgId, orgSlug, undefined, { suspended: true });
      expect(frozen.kind).toBe(before.kind);
      if (frozen.kind !== 'ready' && frozen.kind !== 'bank_only') return;
      expect(frozen.view.period.id).toBe(march);
      expect(frozen.view.cards.map((c) => [c.metricKey, c.rawValue]))
        .toEqual(before.view.cards.map((c) => [c.metricKey, c.rawValue]));

      // The policy, directly: exactly the pointed-at snapshot, not the newer one beside it.
      const visible = await orgRows<{ value: string }>(db, orgId, 'metric_snapshots', (q) => q.where('metric_key', '==', 'revenue'));
      // numeric is a decimal string, stored as the engine wrote it.
      expect(visible.map((r) => String(r.value))).toEqual(['20000.00']);
    } finally {
      await fs().collection('organizations').doc(orgId).update({ status: 'active' });
    }
  });
});
