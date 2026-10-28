import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueEngineUpgrade } from '@/core/db';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { loadHome } from '@/modules/dashboard';
import { resolveDescriptor } from '@/modules/evidence';
import { ENGINE_VERSION } from '@/modules/financial-engine';
import type { AccessContext } from '@/modules/tenancy';
import { AS_OF, calculateAndAlert, headline, untilFinished } from '../fixtures/adr120-orgs';
import { month, statement } from '../fixtures/audit-orgs';
import { seedAudit2Orgs, type Audit2Key } from '../fixtures/audit2-orgs';
import { periodId } from '@/db/app/shared';
import { orgCollection } from '@/db/schema';
import { orgRows } from '@/db/rls';
import { jsonbText } from '../fixtures/engine-dump';
import {
  currentFigure, currentFigures, dropQueuedJobs, latestVersion, ownerOf, plantStale, queuedCalculation,
} from '../fixtures/engine-reads';
import { removeSeeded, seedAssignment, seedJob, seedPlatformUser } from '../fixtures/seed';
import { clientFor, createAuthUser, fs } from './setup';

/**
 * ADR-124 — every blocking finding of the SECOND independent audit of ADR-120, reproduced on the
 * auditor's own nine organisations (test/fixtures/audit2-orgs.ts, seeded from nothing) through the
 * real queue, now answered with the truth the auditor computed — or, where the data cannot establish
 * it, with an honest NULL. Then D-6: an organisation left on an older engine's figures is found,
 * shown as updating, and recomputed — by the sweep, by a manual recalculation, and by an import.
 */

const TAG = `b${Date.now().toString(36)}`;
/** Accounts a test creates outside the seeded organisations, removed with them. */
const afterCleanup: string[] = [];
const KEYS: readonly Audit2Key[] = ['GAPGL', 'PARTJUL', 'NEWACCT', 'BSLIST', 'LEDGER3', 'UNRECON', 'CNFUTURE', 'MIDTYPED', 'CYCLE'];
let org: Partial<Record<Audit2Key, string>>;
const o = (k: Audit2Key): string => org[k]!;

const money = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Decimal(value).toFixed(2);
const v = async (k: Audit2Key, start: string, key: string): Promise<string | null> => money((await headline(o(k), start, key))?.value);
/** [opening, net movement, closing] of a month. */
const cash = (k: Audit2Key, start: string): Promise<Array<string | null>> =>
  Promise.all(['opening_cash', 'net_cash_movement', 'closing_cash'].map((key) => v(k, start, key)));

const owners = new Map<string, string>();
const owner = (id: string): string => owners.get(id)!;
const ctxFor = (id: string, userId = owner(id)): AccessContext => ({
  userId, orgId: id, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(userId), requestId: TAG, now: () => new Date(`${AS_OF}T00:00:00Z`),
  organizationStatus: 'active',
});
const descriptorOf = async (k: Audit2Key, start: string, key: string): Promise<unknown> =>
  ((await currentFigure(o(k), start, key))!.evidenceQuery as { descriptor: unknown }).descriptor;
/** `period_start|severity|threshold_summary::text` of every alert of a rule, in that text's order. */
const alerts = async (k: Audit2Key, rule: string): Promise<string[]> => {
  const rows = (await orgCollection(fs(), o(k), 'alerts').where('rule_key', '==', rule).get()).docs.map((d) => d.data());
  const startOf = new Map((await orgCollection(fs(), o(k), 'fiscal_periods').get()).docs.map((d) => [d.id, String(d.get('period_start'))]));
  return rows.filter((a) => startOf.has(String(a.period_id)))
    .map((a) => `${startOf.get(String(a.period_id))}|${String(a.severity)}|${a.threshold_summary == null ? '{}' : jsonbText(a.threshold_summary)}`)
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
};

beforeAll(async () => {
  org = await seedAudit2Orgs(TAG, KEYS);
  for (const k of KEYS) owners.set(o(k), await ownerOf(o(k)));
  for (const k of KEYS) await calculateAndAlert(o(k));
}, 3_600_000);

afterAll(async () => {
  if (!org) return;
  await removeSeeded(Object.values(org), `@${TAG}.`);
  for (const uid of afterCleanup) await fs().collection('platform_users').doc(uid).delete();
}, 600_000);

describe('N-1 · a month no statement fully covers publishes no closing balance', () => {
  it('GAPGL: July is unknown, though a GL "covers" it — not 9,000 carried, and no 0.00 "ledger" movement', async () => {
    expect(await cash('GAPGL', '2026-06-01')).toEqual(['10000.00', '-1000.00', '9000.00']);
    expect(await cash('GAPGL', '2026-07-01')).toEqual(['9000.00', null, null]);
    expect((await headline(o('GAPGL'), '2026-07-01', 'closing_cash'))!.missing).toEqual(['no_source_covers_period']);
    expect((await headline(o('GAPGL'), '2026-07-01', 'net_cash_movement'))!.basis).toBe('none');
    expect(await cash('GAPGL', '2026-08-01')).toEqual(['4000.00', '-500.00', '3500.00']);
  });

  it('GAPGL: July working capital is unknown with it — not 10,000', async () => {
    expect(await v('GAPGL', '2026-07-01', 'working_capital')).toBeNull();
  });

  it('PARTJUL: a July statement ending on the 15th leaves July unknown — not a verified 7,000', async () => {
    expect(await cash('PARTJUL', '2026-07-01')).toEqual(['9000.00', null, null]);
    expect((await headline(o('PARTJUL'), '2026-07-01', 'closing_cash'))!.warnings).toContain('bank_coverage_partial');
    expect(await cash('PARTJUL', '2026-08-01')).toEqual(['4000.00', '-500.00', '3500.00']);
  });

  it('PARTJUL: so no alert says cash "fell from 7,000"', async () => {
    for (const alert of (await alerts('PARTJUL', 'cash.decline'))) expect(alert).not.toMatch(/7000/);
  });
});

describe('N-2 · a typed opening months earlier never opens a later month; a split first month chains', () => {
  it('MIDTYPED: June 5,000 · July 5,500 · August 5,600 — the truth, with no mismatch left to flag', async () => {
    expect(await cash('MIDTYPED', '2026-06-01')).toEqual(['10000.00', '-5000.00', '5000.00']);
    expect(await cash('MIDTYPED', '2026-07-01')).toEqual(['5000.00', '500.00', '5500.00']);
    expect(await cash('MIDTYPED', '2026-08-01')).toEqual(['5500.00', '100.00', '5600.00']);
    for (const m of ['2026-06-01', '2026-07-01', '2026-08-01']) {
      expect((await headline(o('MIDTYPED'), m, 'closing_cash'))!.warnings, m).not.toContain('statement_balance_mismatch');
    }
  });

  it('P-2 · CYCLE: statements from the 5th to the 4th chain June 8,000 · July 7,000 · August 6,000', async () => {
    // May: 1–4 May are covered by no statement, so May has no stated movement.
    expect(await cash('CYCLE', '2026-05-01')).toEqual(['10000.00', null, null]);
    expect(await cash('CYCLE', '2026-06-01')).toEqual(['9000.00', '-1000.00', '8000.00']);
    expect(await cash('CYCLE', '2026-07-01')).toEqual(['8000.00', '-1000.00', '7000.00']);
    expect(await cash('CYCLE', '2026-08-01')).toEqual(['7000.00', '-1000.00', '6000.00']);
  });
});

describe('N-3 · an account joining later joins the total; it does not blank the history (NEWACCT)', () => {
  it('account A alone March–July, A + B from August: 9,100', async () => {
    expect(await cash('NEWACCT', '2026-03-01')).toEqual(['10000.00', '-500.00', '9500.00']);
    expect(await cash('NEWACCT', '2026-07-01')).toEqual(['8000.00', '-500.00', '7500.00']);
    expect(await cash('NEWACCT', '2026-08-01')).toEqual(['9500.00', '-400.00', '9100.00']);
  });

  it('the statements that did not reconcile still say so', async () => {
    expect((await headline(o('NEWACCT'), '2026-08-01', 'closing_cash'))!.warnings).toContain('unreconciled_statement');
  });
});

describe('N-4 · a list committed during a finished month does not outrank its balance sheet (BSLIST)', () => {
  it('August receivables are the balance sheet\'s 3,000 — not a verified 5,000 from a list that stopped on the 3rd', async () => {
    expect(await v('BSLIST', '2026-08-01', 'receivables')).toBe('3000.00');
    expect((await headline(o('BSLIST'), '2026-08-01', 'receivables'))!.basis).toBe('period_balances');
  });

  it('R-2: June and July too — the unconfirmed list (issued Jun–Aug) never states 0.00 over the balance sheet\'s 3,000', async () => {
    for (const m of ['2026-06-01', '2026-07-01']) {
      expect(await v('BSLIST', m, 'receivables'), m).toBe('3000.00');
      expect((await headline(o('BSLIST'), m, 'receivables'))!.basis, m).toBe('period_balances');
    }
  });
});

describe('N-5 · a mid-month opening journal counts nothing twice (LEDGER3)', () => {
  it('August receivables 5,000 — not 6,000 — and the drill-down selects exactly those rows', async () => {
    expect(await v('LEDGER3', '2026-06-01', 'receivables')).toBe('6000.00');
    expect(await v('LEDGER3', '2026-08-01', 'receivables')).toBe('5000.00');
    const selection = await resolveDescriptor(ctxFor(o('LEDGER3')), await descriptorOf('LEDGER3', '2026-08-01', 'receivables'));
    expect(money(selection.total)).toBe('5000.00');
    expect(((await descriptorOf('LEDGER3', '2026-08-01', 'receivables')) as { filters: Record<string, unknown> }).filters.entry_date_from).toBe('2026-07-15');
  });

  it('July, which neither GL export\'s declared range spans, is unknown rather than guessed', async () => {
    expect(await v('LEDGER3', '2026-07-01', 'receivables')).toBeNull();
  });
});

describe('N-7 · the overdue share is a share (CNFUTURE)', () => {
  it('the alert states 100% of the open invoices, the credit note beside it — never 500%', async () => {
    const [alert] = await alerts('CNFUTURE', 'receivables.deterioration');
    const summary = JSON.parse(alert!.split('|').slice(2).join('|')) as Record<string, string>;
    expect(summary).toMatchObject({ share: '1.000000', overdue_invoices: '1000.00', open_invoices: '1000.00', open_credits: '800.00' });
    // The figures themselves are what the engine computed: 200 owed net, 1,000 overdue.
    expect(await v('CNFUTURE', '2026-08-01', 'receivables')).toBe('200.00');
    expect(await v('CNFUTURE', '2026-08-01', 'receivables_overdue')).toBe('1000.00');
  });
});

describe('N-8 · only a current statement flags its month unreconciled (UNRECON)', () => {
  it('June\'s superseded upload no longer marks June', async () => {
    expect(await cash('UNRECON', '2026-06-01')).toEqual(['1000.00', '-100.00', '900.00']);
    expect((await headline(o('UNRECON'), '2026-06-01', 'closing_cash'))!.warnings).not.toContain('unreconciled_statement');
  });
});

describe('evidence reconciles to every figure the nine organisations publish', () => {
  it('each leaf descriptor of the balance and movement families totals to its figure', async () => {
    let checked = 0;
    for (const k of KEYS) {
      const rows = (await currentFigures(o(k), {
        keys: ['receivables', 'receivables_overdue', 'payables', 'payables_overdue', 'cash_inflows', 'cash_outflows'],
      })).filter((f) => f.value !== null && f.evidenceQuery?.kind === 'leaf');
      for (const row of rows) {
        const selection = await resolveDescriptor(ctxFor(o(k)), (row.evidenceQuery as { descriptor: unknown }).descriptor);
        expect(money(selection.total), `${k} ${row.periodStart} ${row.metricKey}`).toBe(money(row.value));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(30);
  }, 600_000);
});

describe('tenancy · the new reads stay inside the organisation', () => {
  it('another organisation\'s owner resolves nothing from LEDGER3\'s dated drill-down', async () => {
    const intruder = owner(o('CNFUTURE')) === owner(o('LEDGER3')) ? owner(o('GAPGL')) : owner(o('CNFUTURE'));
    const selection = await resolveDescriptor({ ...ctxFor(o('LEDGER3')), userId: intruder, db: clientFor(intruder) },
      (await descriptorOf('LEDGER3', '2026-08-01', 'receivables')));
    expect(selection.count).toBe(0);
  });

  it('an unassigned employee resolves nothing; an assigned one resolves the figure', async () => {
    const assigned = await createAuthUser(`assigned@${TAG}.roles.itest`);
    const unassigned = await createAuthUser(`unassigned@${TAG}.roles.itest`);
    await seedPlatformUser(assigned, 'employee');
    await seedPlatformUser(unassigned, 'employee');
    await seedAssignment(o('LEDGER3'), assigned, owner(o('LEDGER3')));
    afterCleanup.push(assigned, unassigned);
    const descriptor = await descriptorOf('LEDGER3', '2026-08-01', 'receivables');
    expect((await resolveDescriptor(ctxFor(o('LEDGER3'), unassigned), descriptor)).count).toBe(0);
    expect(money((await resolveDescriptor(ctxFor(o('LEDGER3'), assigned), descriptor)).total)).toBe('5000.00');
  });

  it('a member of one organisation cannot read another\'s per-account cash components', async () => {
    const data = await orgRows(clientFor(owner(o('CNFUTURE'))), o('NEWACCT'), 'metric_snapshots',
      (q) => q.where('metric_key', '==', 'closing_cash'));
    expect(data).toEqual([]);
  });
});

describe('D-6 · figures an earlier engine wrote are found, flagged and recomputed', () => {
  it('every run of this suite ran on the current engine, and says so', async () => {
    for (const k of KEYS) expect(await latestVersion(o(k)), k).toBe(ENGINE_VERSION);
    // ADR-124 shipped engine 3.0.0. FU-1 (ADR-122 follow-up register, R5) changes existing values, so
    // FINANCIAL_ENGINE.md §6 required a MAJOR bump to 4.0.0, which made the literal '3.0.0' pin stale.
    // What this test guards is that the engine carries ADR-124's fixes (major 3 or later) and that
    // every run above ran on the current ENGINE_VERSION; it no longer hard-codes a later bump.
    // FU-1's own suite pins that the version moved past 3.0.0 (fu1-remediation.test.ts).
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number(ENGINE_VERSION.split('.')[0])).toBeGreaterThanOrEqual(3);
  });

  it('an organisation left on 2.0.0 is shown as updating, queued by the sweep, and recomputed to the truth', async () => {
    // What 7a139b8 left behind for PARTJUL: July "verified" at 7,000, on 2.0.0 (audit N-1, N-6).
    const id = o('PARTJUL');
    // Fixture only: the state an older engine's run left, not an app write.
    await plantStale(id, { oldVersion: '2.0.0', start: '2026-07-01', key: 'closing_cash', value: '7000.000000' });
    const home = await loadHome(clientFor(owner(id)), id, 'x');
    expect('view' in home && home.view.recalculating).toBe(true);

    expect(await enqueueEngineUpgrade(ENGINE_VERSION)).toBeGreaterThanOrEqual(1);
    const job = await queuedCalculation(id);
    expect(job).not.toBe('');
    expect(await untilFinished(job)).toBe('succeeded');
    expect(await latestVersion(id)).toBe(ENGINE_VERSION);
    expect(await cash('PARTJUL', '2026-07-01')).toEqual(['9000.00', null, null]);
    const after = await loadHome(clientFor(owner(id)), id, 'x');
    expect('view' in after && after.view.recalculating).toBe(false);
  }, 900_000);

  it('an organisation already on this engine is not queued', async () => {
    const id = o('UNRECON');
    await dropQueuedJobs(id);
    await enqueueEngineUpgrade(ENGINE_VERSION);
    expect(await queuedCalculation(id)).toBe('');
  }, 900_000);

  it('an import on an organisation still on 2.0.0 recomputes its whole history, not just the imported month', async () => {
    // What 7a139b8 left for MIDTYPED: July 10,500 on 2.0.0. A September statement arrives.
    const id = o('MIDTYPED');
    // Fixture only: the state an older engine's run left, not an app write.
    await plantStale(id, { oldVersion: '2.0.0', start: '2026-07-01', key: 'closing_cash', value: '10500.000000' });
    const bank = (await orgCollection(fs(), id, 'bank_accounts').limit(1).get()).docs[0]!.id;
    await statement(id, bank, { ...month('2026-09'), opening: '5600', closing: '5500', moves: [{ date: '2026-09-05', amount: '-100' }], tag: 'mt-sep' });
    const sep = periodId(id, '2026-09-01');
    const job = await seedJob(id, 'calculation.run', { trigger: 'import_commit', as_of: '2026-09-30', period_ids: [sep] }, 3);
    expect(await untilFinished(job)).toBe('succeeded');
    expect(await latestVersion(id)).toBe(ENGINE_VERSION);
    expect(await cash('MIDTYPED', '2026-07-01')).toEqual(['5000.00', '500.00', '5500.00']);
    expect(await cash('MIDTYPED', '2026-09-01')).toEqual(['5600.00', '-100.00', '5500.00']);
  }, 900_000);

  it('a manual recalculation runs on the current engine', async () => {
    await calculateAndAlert(o('CYCLE'));
    expect(await latestVersion(o('CYCLE'))).toBe(ENGINE_VERSION);
  }, 900_000);
});
