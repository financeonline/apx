import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolveDescriptor } from '@/modules/evidence';
import { ENGINE_VERSION } from '@/modules/financial-engine';
import type { AccessContext } from '@/modules/tenancy';
import {
  AS_OF, calculateAndAlert, headline, periodId, seedAdr120Orgs, type FixtureKey,
} from '../fixtures/adr120-orgs';
import { orgRows } from '@/db/rls';
import { clientFor, createAuthUser } from './setup';
import { addMember, addPlatformUser, assign, dropFixtures, rowOf, rowsOf } from './f-fixtures';

/**
 * ADR-120 — receivables, payables and working capital recovered; the cash chain carried.
 *
 * Six organisations (test/fixtures/adr120-orgs.ts, every expected figure hand-computed there) are
 * seeded as raw accepted records under committed batches and computed ONLY by the real
 * `calculation.run` job and the `alerts.evaluate` job it enqueues. This file never writes a
 * `metric_snapshots` row: the figures below are the engine's, not the test's.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 900_000 });

const TAG = `r${Date.now().toString(36)}`;
let org: Record<FixtureKey, string>;
const owners = new Map<string, string>();

const owner = (o: string): string => owners.get(o)!;

const ctxFor = (o: string): AccessContext => ({
  userId: owner(o), orgId: o, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(owner(o)), requestId: TAG, now: () => new Date(`${AS_OF}T00:00:00Z`),
  organizationStatus: 'active',
});

const money = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Decimal(value).toFixed(2);

const v = async (o: string, start: string, key: string): Promise<string | null> => money((await headline(o, start, key))?.value);

/** The snapshot's evidence query, as the run stored it. */
const evidenceOf = async (o: string, snapshotId: string) =>
  (await rowOf(o, 'metric_snapshots', snapshotId))!.evidence_query as { kind: string; descriptor: unknown };

beforeAll(async () => {
  org = await seedAdr120Orgs(TAG);
  for (const id of Object.values(org)) {
    owners.set(id, String((await rowsOf(id, 'organization_memberships', { role: 'owner' }))[0]!.user_id));
  }
  for (const key of Object.keys(org) as FixtureKey[]) await calculateAndAlert(org[key]);
}, 900_000);

afterAll(async () => {
  await dropFixtures(Object.values(org ?? {}), `${TAG}.adr120.itest`);
  await dropFixtures([], `${TAG}.roles.itest`);
}, 120_000);

describe('K/L · the figures come from a real calculation run, not from inserted rows', () => {
  it('every receivables snapshot belongs to a succeeded run of the current engine', async () => {
    const snaps = (await rowsOf(org.INVBANK, 'metric_snapshots')).filter((s) => ['receivables', 'payables', 'working_capital'].includes(String(s.metric_key)));
    const runs = new Set<string>();
    for (const runId of new Set(snaps.map((s) => String(s.calculation_run_id)))) {
      const r = (await rowOf(org.INVBANK, 'calculation_runs', runId))!;
      runs.add(`${r.status}|${r.engine_version}`);
    }
    // The version the test asserts is the deployed one, never a literal a bump silently leaves behind (ADR-124 D-6).
    expect([...runs]).toEqual([`succeeded|${ENGINE_VERSION}`]);
  });
});

describe('receivables and payables on the invoice basis (INVBANK)', () => {
  it('A · positive receivables, aged at each period end — a later payment still counts', async () => {
    expect(await v(org.INVBANK, '2026-06-01', 'receivables')).toBe('1200.00'); // S1 paid 07-01, after 06-30
    expect(await v(org.INVBANK, '2026-07-01', 'receivables')).toBe('2400.00');
    expect(await v(org.INVBANK, '2026-08-01', 'receivables')).toBe('4400.00'); // credit note subtracts, void excluded
    expect(await v(org.INVBANK, '2026-08-01', 'receivables_overdue')).toBe('1800.00');
    expect((await headline(org.INVBANK, '2026-08-01', 'receivables'))?.basis).toBe('invoices');
  });

  /*
   * ADR-123 (audit F-9): this used to assert 4,400 for September — possible only because the fixture
   * stamped every batch `committed_at = now()`, after the run's as-of date. With a real commit time
   * (10 Sep) the June–August list says nothing about invoices issued in September, so September is
   * honestly unknown. Current-month aging from a list that DOES reach into the month is proven by the
   * CURRENT organisation in adr123-remediation.test.ts.
   */
  it('the current period is unknown when no list reaches into it', async () => {
    const sep = (await headline(org.INVBANK, '2026-09-01', 'receivables'))!;
    expect(sep.value).toBeNull();
    expect(sep.missing).toContain('stale_invoice_data');
  });

  it('D/E · payables: positive, then a genuine zero when everything was paid', async () => {
    expect(await v(org.INVBANK, '2026-06-01', 'payables')).toBe('600.00');
    expect(await v(org.INVBANK, '2026-07-01', 'payables')).toBe('0.00');
    expect(await v(org.INVBANK, '2026-08-01', 'payables')).toBe('900.00');
    expect(await v(org.INVBANK, '2026-08-01', 'payables_overdue')).toBe('900.00');
  });

  it('days to get paid uses three months of gross invoice totals', async () => {
    expect(money((await headline(org.INVBANK, '2026-08-01', 'receivables_days'))?.value)).toBe('61.00'); // 4,400 / 6,600 × 91.25 → 61
    expect((await headline(org.INVBANK, '2026-07-01', 'receivables_days'))?.missing).toContain('insufficient_history');
  });

  it('G · working capital from carried cash, receivables and payables', async () => {
    expect(await v(org.INVBANK, '2026-08-01', 'working_capital')).toBe('8300.00'); // 4,800 + 4,400 − 900
    expect((await headline(org.INVBANK, '2026-08-01', 'working_capital'))?.warnings).toContain('partial_working_capital');
  });
});

describe('F/H/J · missing data is unavailable, never zero', () => {
  it('a sales-only organisation has unknown payables and unknown working capital', async () => {
    expect(await v(org.INVONLY, '2026-08-01', 'receivables')).toBe('4400.00');
    expect((await headline(org.INVONLY, '2026-08-01', 'payables'))?.value).toBeNull();
    expect((await headline(org.INVONLY, '2026-08-01', 'payables'))?.missing).toContain('no_source_covers_period');
    expect((await headline(org.INVONLY, '2026-08-01', 'working_capital'))?.value).toBeNull();
    expect((await headline(org.INVONLY, '2026-08-01', 'working_capital'))?.missing).toEqual(
      expect.arrayContaining(['no_bank_accounts', 'no_source_covers_period']),
    );
  });

  it('I · an empty organisation manufactures no zero anywhere', async () => {
    const keys = new Set(['receivables', 'receivables_overdue', 'receivables_days', 'payables', 'payables_overdue',
      'payables_days', 'working_capital', 'opening_cash', 'closing_cash', 'cash_runway_months']);
    const cells = (await rowsOf(org.EMPTY, 'metric_current', { dimension_type: 'none' })).filter((c) => keys.has(String(c.metric_key)));
    const zeros: string[] = [];
    for (const c of cells) {
      const snap = await rowOf(org.EMPTY, 'metric_snapshots', String(c.snapshot_id));
      if (snap && snap.value !== null) zeros.push(`${c.metric_key}@${c.period_id}`);
    }
    expect(zeros).toEqual([]);
    expect((await headline(org.EMPTY, '2026-08-01', 'receivables'))?.missing).toContain('no_source_covers_period');
  });

  it('a month before any source reports its reason', async () => {
    expect((await headline(org.INVBANK, '2026-05-01', 'receivables'))?.value).toBeNull();
    expect((await headline(org.INVBANK, '2026-05-01', 'receivables'))?.missing).toContain('stale_invoice_data');
  });
});

describe('the ledger and trial-balance bases', () => {
  it('ledger: opening journal plus movements (ADR-027.3 item 3)', async () => {
    expect([await v(org.LEDGER, '2026-06-01', 'receivables'), await v(org.LEDGER, '2026-07-01', 'receivables'), await v(org.LEDGER, '2026-08-01', 'receivables')])
      .toEqual(['6000.00', '6500.00', '2500.00']);
    expect([await v(org.LEDGER, '2026-06-01', 'payables'), await v(org.LEDGER, '2026-07-01', 'payables'), await v(org.LEDGER, '2026-08-01', 'payables')])
      .toEqual(['2200.00', '2400.00', '2600.00']);
    expect((await headline(org.LEDGER, '2026-08-01', 'receivables'))?.basis).toBe('ledger');
    expect((await headline(org.LEDGER, '2026-08-01', 'receivables_overdue'))?.value).toBeNull(); // a ledger has no due dates
  });

  it('trial balance: balances; an account it does not list is unknown on a trial balance nobody confirmed complete (NF-2)', async () => {
    expect([await v(org.TB, '2026-06-01', 'receivables'), await v(org.TB, '2026-07-01', 'receivables'), await v(org.TB, '2026-08-01', 'receivables')])
      .toEqual(['7000.00', '8000.00', '9000.00']);
    // July lists no payables line. The fixture's trial balance was never answered complete (IMP-TB-016),
    // so July's payables are unknown — not the 0.00 earlier engines read into the missing line.
    expect([await v(org.TB, '2026-06-01', 'payables'), await v(org.TB, '2026-07-01', 'payables'), await v(org.TB, '2026-08-01', 'payables')])
      .toEqual(['3000.00', null, '4000.00']);
    expect(await v(org.TB, '2026-08-01', 'working_capital')).toBe('10400.00'); // 3,400 + 9,000 + 2,000 − 4,000
  });
});

describe('the cash chain (§3.3): each month opens at the last one\'s close', () => {
  it('carries cash forward', async () => {
    const chain = await Promise.all(['2026-06-01', '2026-07-01', '2026-08-01']
      .map(async (m) => [await v(org.BANK, m, 'opening_cash'), await v(org.BANK, m, 'closing_cash')]));
    expect(chain).toEqual([['20000.00', '17000.00'], ['17000.00', '14000.00'], ['14000.00', '11000.00']]);
  });

  it('gives a runway only over three months a statement fully stated', async () => {
    expect((await headline(org.BANK, '2026-08-01', 'cash_runway_months'))?.value).toBe('3.666667');
    for (const month of ['2026-06-01', '2026-07-01', '2026-09-01']) {
      expect((await headline(org.BANK, month, 'cash_runway_months'))?.value, month).toBeNull();
      expect((await headline(org.BANK, month, 'cash_runway_months'))?.missing, month).toContain('insufficient_history');
    }
  });

  it('a month without a statement is unknown, never a carried balance (§2.3; ADR-123 F-1)', async () => {
    const sep = (await headline(org.BANK, '2026-09-01', 'closing_cash'))!;
    expect(sep.value).toBeNull();
    expect(sep.missing).toContain('no_source_covers_period');
  });
});

describe('history first, banking later — and the statement\'s own opening balance (CD-06)', () => {
  it('months before any statement have unknown cash, never zero', async () => {
    for (const month of ['2026-03-01', '2026-04-01', '2026-05-01']) {
      const closing = (await headline(org.HISTORY, month, 'closing_cash'))!;
      expect(closing.value, month).toBeNull();
      // ADR-124 D-2: the account starts with its first statement (it has no typed balance), so nothing
      // covers these months at all — §2.3's reason, where ADR-120 said "no opening balance".
      expect(closing.missing, month).toEqual(['no_source_covers_period']);
    }
  });

  it('the chain starts at the first statement\'s printed opening balance and carries from there', async () => {
    const chain = await Promise.all(['2026-06-01', '2026-07-01', '2026-08-01']
      .map(async (m) => [await v(org.HISTORY, m, 'opening_cash'), await v(org.HISTORY, m, 'closing_cash')]));
    expect(chain).toEqual([['8000.00', '9500.00'], ['9500.00', '10000.00'], ['10000.00', '10300.00']]);
    const opening = (await headline(org.HISTORY, '2026-06-01', 'opening_cash'))!;
    expect((await rowOf(org.HISTORY, 'metric_snapshots', opening.snapshotId))?.assurance_level).toBe('verified');
  });
});

describe('O · evidence resolves to the figure, in the run it was computed in', () => {
  const reconcile = async (o: string, start: string, key: string) => {
    const snapshot = (await headline(o, start, key))!;
    const query = await evidenceOf(o, snapshot.snapshotId);
    expect(query.kind).toBe('leaf');
    const selection = await resolveDescriptor(ctxFor(o), query.descriptor);
    return { figure: money(snapshot.value), evidence: money(selection.total), rows: selection.count };
  };

  it('historical receivables: the invoice paid after the date is in the drill-down at its total', async () => {
    const r = await reconcile(org.INVBANK, '2026-06-01', 'receivables');
    expect(r).toMatchObject({ figure: '1200.00', evidence: '1200.00', rows: 1 });
  });

  it('receivables and overdue with a credit note', async () => {
    expect(await reconcile(org.INVBANK, '2026-08-01', 'receivables')).toMatchObject({ figure: '4400.00', evidence: '4400.00' });
    expect(await reconcile(org.INVBANK, '2026-08-01', 'receivables_overdue')).toMatchObject({ figure: '1800.00', evidence: '1800.00' });
  });

  it('a ledger balance: every period it summed', async () => {
    expect(await reconcile(org.LEDGER, '2026-08-01', 'receivables')).toMatchObject({ figure: '2500.00', evidence: '2500.00' });
    expect(await reconcile(org.LEDGER, '2026-08-01', 'payables')).toMatchObject({ figure: '2600.00', evidence: '2600.00' });
  });

  it('a trial-balance liability reads positive in its drill-down too', async () => {
    expect(await reconcile(org.TB, '2026-08-01', 'payables')).toMatchObject({ figure: '4000.00', evidence: '4000.00' });
  });
});

describe('M/N · tenant isolation', () => {
  // The fixture spreads six organisations over three owners, two each (BANK and INVBANK share one);
  // LEDGER's owner has no role in INVBANK.
  it('another organisation\'s owner reads none of these figures', async () => {
    expect(owner(org.LEDGER)).not.toBe(owner(org.INVBANK));
    const outsider = clientFor(owner(org.LEDGER));
    expect(await orgRows(outsider, org.INVBANK, 'metric_snapshots', (q) => q.where('metric_key', 'in', ['receivables', 'payables', 'working_capital'])))
      .toEqual([]);
  });

  it('the owner reads their own', async () => {
    const rows = await orgRows(clientFor(owner(org.INVBANK)), org.INVBANK, 'metric_snapshots', (q) => q.where('metric_key', '==', 'receivables'));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('a descriptor cannot be resolved into another organisation', async () => {
    const snapshot = (await headline(org.INVBANK, '2026-08-01', 'receivables'))!;
    const query = await evidenceOf(org.INVBANK, snapshot.snapshotId);
    // An outsider's session aimed at INVBANK: RLS, not the application, is what returns nothing.
    const intruder: AccessContext = { ...ctxFor(org.INVBANK), userId: owner(org.LEDGER), db: clientFor(owner(org.LEDGER)) };
    const selection = await resolveDescriptor(intruder, query.descriptor);
    expect(selection.count).toBe(0);
    expect(money(selection.total)).toBe('0.00');
  });
});

describe('Health Score and alerts: the intended consequences of ADR-120', () => {
  const rule = async (o: string, start: string, dimension: string, name: string): Promise<{ result: string; points: number } | null> => {
    const current = await rowOf(o, 'health_current', periodId(o, start));
    if (!current) return null;
    const score = await rowOf(o, 'health_scores', String(current.health_score_id));
    const dims = (score?.breakdown ?? []) as Array<{ key: string; rules?: Array<{ rule: string; result: string; points: number }> }>;
    return dims.find((d) => d.key === dimension)?.rules?.find((r) => r.rule === name) ?? null;
  };
  const alerts = async (o: string): Promise<string[]> => (await rowsOf(o, 'alerts')).map((a) => `${a.rule_key}|${a.severity}`).sort();

  it('Q3 (days to get paid) now scores instead of always skipping', async () => {
    expect(await rule(org.INVBANK, '2026-08-01', 'customer_quality', 'Q3')).toMatchObject({ result: '60 to 90 days', points: -10 });
  });

  it('C2 (runway) now scores', async () => {
    expect(await rule(org.BANK, '2026-08-01', 'cash_flow', 'C2')).toMatchObject({ result: '3 to 6 months', points: 5 });
  });

  it('B1 (balance trend) reads a carried balance', async () => {
    expect(await rule(org.BANK, '2026-08-01', 'banking_health', 'B1')).toMatchObject({ result: 'falling for 3 months', points: -15 });
  });

  it('receivables and payables deterioration now fire on real figures', async () => {
    expect(await alerts(org.INVBANK)).toEqual(expect.arrayContaining(['receivables.deterioration|medium', 'payables.deterioration|high']));
  });

  it('with a credit note present, "the top three account for" is of the overdue invoices — 100%, not 133% (ADR-123 F-10)', async () => {
    const alert = (await rowsOf(org.INVBANK, 'alerts', { rule_key: 'receivables.deterioration' }))[0]!;
    const summary = (await rowOf(org.INVBANK, 'alert_revisions', String(alert.current_revision_id)))!.threshold_summary as Record<string, string>;
    expect(summary.overdue).toBe('1800.00'); // net of the credit note, as the figure is
    expect(summary.top3_share).toBe('1.000000'); // S2 2,400 of 2,400 overdue invoices
  });

  it('and do not fire where nothing is owed or nothing is known', async () => {
    expect(await alerts(org.EMPTY)).toEqual([]);
    expect((await alerts(org.TB)).filter((a) => a.includes('deterioration'))).toEqual([]);
  });
});

describe('M/N · every role sees exactly what the matrix allows (RLS and the resolver agree)', () => {
  const roles = { admin: '', client: '', assigned: '', unassigned: '', superAdmin: '' };
  beforeAll(async () => {
    for (const name of Object.keys(roles) as Array<keyof typeof roles>) {
      roles[name] = await createAuthUser(`${name}@${TAG}.roles.itest`);
    }
    await addMember(org.INVBANK, roles.admin, 'admin');
    await addMember(org.INVBANK, roles.client, 'client');
    await addPlatformUser(roles.assigned, 'employee');
    await addPlatformUser(roles.unassigned, 'employee');
    await addPlatformUser(roles.superAdmin, 'super_admin');
    await assign(org.INVBANK, roles.assigned);
  });

  const reads = async (user: string): Promise<number> => (await orgRows(clientFor(user), org.INVBANK, 'metric_snapshots',
    (q) => q.where('metric_key', 'in', ['receivables', 'payables', 'working_capital']))).length;

  it('owner, admin and client of the organisation read its receivables family', async () => {
    expect(await reads(owner(org.INVBANK))).toBeGreaterThan(0);
    expect(await reads(roles.admin)).toBeGreaterThan(0);
    expect(await reads(roles.client)).toBeGreaterThan(0);
  });

  it('an employee reads only an ASSIGNED organisation', async () => {
    expect(await reads(roles.assigned)).toBeGreaterThan(0);
    expect(await reads(roles.unassigned)).toBe(0);
  });

  it('a super admin reads it', async () => {
    expect(await reads(roles.superAdmin)).toBeGreaterThan(0);
  });

  it('an unassigned employee\'s session cannot resolve the organisation\'s evidence', async () => {
    const snapshot = (await headline(org.INVBANK, '2026-08-01', 'receivables'))!;
    const query = await evidenceOf(org.INVBANK, snapshot.snapshotId);
    const intruder: AccessContext = { ...ctxFor(org.INVBANK), userId: roles.unassigned, db: clientFor(roles.unassigned) };
    expect((await resolveDescriptor(intruder, query.descriptor)).count).toBe(0);
    const allowed: AccessContext = { ...ctxFor(org.INVBANK), userId: roles.assigned, db: clientFor(roles.assigned) };
    expect(money((await resolveDescriptor(allowed, query.descriptor)).total)).toBe('4400.00');
  });
});
