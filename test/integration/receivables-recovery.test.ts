import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolveDescriptor } from '@/modules/evidence';
import type { AccessContext } from '@/modules/tenancy';
import {
  AS_OF, calculateAndAlert, headline, seedAdr120Orgs, type FixtureKey,
} from '../fixtures/adr120-orgs';
import { adminSql, clientFor } from './setup';

/**
 * ADR-120 — receivables, payables and working capital recovered; the cash chain carried.
 *
 * Six organisations (test/fixtures/adr120-orgs.ts, every expected figure hand-computed there) are
 * seeded as raw accepted records under committed batches and computed ONLY by the real
 * `calculation.run` job and the `alerts.evaluate` job it enqueues. This file never writes a
 * `metric_snapshots` row: the figures below are the engine's, not the test's.
 */

const TAG = `r${Date.now().toString(36)}`;
let org: Record<FixtureKey, string>;

const owner = (o: string): string =>
  adminSql(`select user_id from public.organization_memberships where organization_id = '${o}' and role = 'owner' limit 1`).trim();

const ctxFor = (o: string): AccessContext => ({
  userId: owner(o), orgId: o, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(owner(o)), requestId: TAG, now: () => new Date(`${AS_OF}T00:00:00Z`),
  organizationStatus: 'active',
});

const money = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Decimal(value).toFixed(2);

const v = (o: string, start: string, key: string): string | null => money(headline(o, start, key)?.value);

beforeAll(async () => {
  org = await seedAdr120Orgs(TAG);
  for (const key of Object.keys(org) as FixtureKey[]) await calculateAndAlert(org[key]);
}, 900_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id in (${Object.values(org).map((id) => `'${id}'`).join(',')});
            delete from auth.users where email like '%@${TAG}.adr120.itest';`);
});

describe('K/L · the figures come from a real calculation run, not from inserted rows', () => {
  it('every receivables snapshot belongs to a succeeded run of the current engine', () => {
    const rows = adminSql(`select distinct r.status || '|' || r.engine_version
      from public.metric_snapshots s join public.calculation_runs r on r.id = s.calculation_run_id and r.organization_id = s.organization_id
      where s.organization_id = '${org.INVBANK}' and s.metric_key in ('receivables', 'payables', 'working_capital')`).trim();
    expect(rows).toBe('succeeded|2.0.0');
  });
});

describe('receivables and payables on the invoice basis (INVBANK)', () => {
  it('A · positive receivables, aged at each period end — a later payment still counts', () => {
    expect(v(org.INVBANK, '2026-06-01', 'receivables')).toBe('1200.00'); // S1 paid 07-01, after 06-30
    expect(v(org.INVBANK, '2026-07-01', 'receivables')).toBe('2400.00');
    expect(v(org.INVBANK, '2026-08-01', 'receivables')).toBe('4400.00'); // credit note subtracts, void excluded
    expect(v(org.INVBANK, '2026-08-01', 'receivables_overdue')).toBe('1800.00');
    expect(headline(org.INVBANK, '2026-08-01', 'receivables')?.basis).toBe('invoices');
  });

  it('the current period is aged as at the run\'s as-of date', () => {
    expect(v(org.INVBANK, '2026-09-01', 'receivables_overdue')).toBe('4400.00');
  });

  it('D/E · payables: positive, then a genuine zero when everything was paid', () => {
    expect(v(org.INVBANK, '2026-06-01', 'payables')).toBe('600.00');
    expect(v(org.INVBANK, '2026-07-01', 'payables')).toBe('0.00');
    expect(v(org.INVBANK, '2026-08-01', 'payables')).toBe('900.00');
    expect(v(org.INVBANK, '2026-08-01', 'payables_overdue')).toBe('900.00');
  });

  it('days to get paid uses three months of gross invoice totals', () => {
    expect(money(headline(org.INVBANK, '2026-08-01', 'receivables_days')?.value)).toBe('61.00'); // 4,400 / 6,600 × 91.25 → 61
    expect(headline(org.INVBANK, '2026-07-01', 'receivables_days')?.missing).toContain('insufficient_history');
  });

  it('G · working capital from carried cash, receivables and payables', () => {
    expect(v(org.INVBANK, '2026-08-01', 'working_capital')).toBe('8300.00'); // 4,800 + 4,400 − 900
    expect(headline(org.INVBANK, '2026-08-01', 'working_capital')?.warnings).toContain('partial_working_capital');
  });
});

describe('F/H/J · missing data is unavailable, never zero', () => {
  it('a sales-only organisation has unknown payables and unknown working capital', () => {
    expect(v(org.INVONLY, '2026-08-01', 'receivables')).toBe('4400.00');
    expect(headline(org.INVONLY, '2026-08-01', 'payables')?.value).toBeNull();
    expect(headline(org.INVONLY, '2026-08-01', 'payables')?.missing).toContain('no_source_covers_period');
    expect(headline(org.INVONLY, '2026-08-01', 'working_capital')?.value).toBeNull();
    expect(headline(org.INVONLY, '2026-08-01', 'working_capital')?.missing).toEqual(
      expect.arrayContaining(['no_bank_accounts', 'no_source_covers_period']),
    );
  });

  it('I · an empty organisation manufactures no zero anywhere', () => {
    const zeros = adminSql(`select c.metric_key || '@' || p.period_start
      from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
      join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
      where c.organization_id = '${org.EMPTY}' and c.dimension_type = 'none'
        and c.metric_key in ('receivables', 'receivables_overdue', 'receivables_days', 'payables', 'payables_overdue',
                             'payables_days', 'working_capital', 'opening_cash', 'closing_cash', 'cash_runway_months')
        and s.value is not null`).trim();
    expect(zeros).toBe('');
    expect(headline(org.EMPTY, '2026-08-01', 'receivables')?.missing).toContain('no_source_covers_period');
  });

  it('a month before any source reports its reason', () => {
    expect(headline(org.INVBANK, '2026-05-01', 'receivables')?.value).toBeNull();
    expect(headline(org.INVBANK, '2026-05-01', 'receivables')?.missing).toContain('stale_invoice_data');
  });
});

describe('the ledger and trial-balance bases', () => {
  it('ledger: opening journal plus movements (ADR-027.3 item 3)', () => {
    expect([v(org.LEDGER, '2026-06-01', 'receivables'), v(org.LEDGER, '2026-07-01', 'receivables'), v(org.LEDGER, '2026-08-01', 'receivables')])
      .toEqual(['6000.00', '6500.00', '2500.00']);
    expect([v(org.LEDGER, '2026-06-01', 'payables'), v(org.LEDGER, '2026-07-01', 'payables'), v(org.LEDGER, '2026-08-01', 'payables')])
      .toEqual(['2200.00', '2400.00', '2600.00']);
    expect(headline(org.LEDGER, '2026-08-01', 'receivables')?.basis).toBe('ledger');
    expect(headline(org.LEDGER, '2026-08-01', 'receivables_overdue')?.value).toBeNull(); // a ledger has no due dates
  });

  it('trial balance: balances, and a stated zero for an account it does not list', () => {
    expect([v(org.TB, '2026-06-01', 'receivables'), v(org.TB, '2026-07-01', 'receivables'), v(org.TB, '2026-08-01', 'receivables')])
      .toEqual(['7000.00', '8000.00', '9000.00']);
    expect([v(org.TB, '2026-06-01', 'payables'), v(org.TB, '2026-07-01', 'payables'), v(org.TB, '2026-08-01', 'payables')])
      .toEqual(['3000.00', '0.00', '4000.00']);
    expect(v(org.TB, '2026-08-01', 'working_capital')).toBe('10400.00'); // 3,400 + 9,000 + 2,000 − 4,000
  });
});

describe('the cash chain (§3.3): each month opens at the last one\'s close', () => {
  it('carries cash forward', () => {
    const chain = ['2026-06-01', '2026-07-01', '2026-08-01']
      .map((m) => [v(org.BANK, m, 'opening_cash'), v(org.BANK, m, 'closing_cash')]);
    expect(chain).toEqual([['20000.00', '17000.00'], ['17000.00', '14000.00'], ['14000.00', '11000.00']]);
  });

  it('gives a runway only over three months a statement fully stated', () => {
    expect(headline(org.BANK, '2026-08-01', 'cash_runway_months')?.value).toBe('3.666667');
    for (const month of ['2026-06-01', '2026-07-01', '2026-09-01']) {
      expect(headline(org.BANK, month, 'cash_runway_months')?.value, month).toBeNull();
      expect(headline(org.BANK, month, 'cash_runway_months')?.missing, month).toContain('insufficient_history');
    }
  });

  it('a month without a statement says so rather than claiming a complete balance', () => {
    const sep = headline(org.BANK, '2026-09-01', 'closing_cash')!;
    expect(sep.warnings).toContain('bank_coverage_partial');
  });
});

describe('O · evidence resolves to the figure, in the run it was computed in', () => {
  const reconcile = async (o: string, start: string, key: string) => {
    const snapshot = headline(o, start, key)!;
    const query = JSON.parse(adminSql(`select evidence_query::text from public.metric_snapshots where id = '${snapshot.snapshotId}'`).trim()) as { kind: string; descriptor: unknown };
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
    const { data, error } = await outsider.from('metric_snapshots').select('id')
      .eq('organization_id', org.INVBANK).in('metric_key', ['receivables', 'payables', 'working_capital']);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('the owner reads their own', async () => {
    const { data } = await clientFor(owner(org.INVBANK)).from('metric_snapshots').select('id')
      .eq('organization_id', org.INVBANK).eq('metric_key', 'receivables');
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it('a descriptor cannot be resolved into another organisation', async () => {
    const snapshot = headline(org.INVBANK, '2026-08-01', 'receivables')!;
    const query = JSON.parse(adminSql(`select evidence_query::text from public.metric_snapshots where id = '${snapshot.snapshotId}'`).trim()) as { descriptor: unknown };
    // An outsider's session aimed at INVBANK: RLS, not the application, is what returns nothing.
    const intruder: AccessContext = { ...ctxFor(org.INVBANK), userId: owner(org.LEDGER), db: clientFor(owner(org.LEDGER)) };
    const selection = await resolveDescriptor(intruder, query.descriptor);
    expect(selection.count).toBe(0);
    expect(money(selection.total)).toBe('0.00');
  });
});

describe('Health Score and alerts: the intended consequences of ADR-120', () => {
  const rule = (o: string, start: string, dimension: string, name: string): { result: string; points: number } | null => {
    const raw = adminSql(`select r::text from public.health_current hc
      join public.health_scores h on h.id = hc.health_score_id and h.organization_id = hc.organization_id
      join public.fiscal_periods p on p.id = hc.period_id and p.organization_id = hc.organization_id,
      jsonb_array_elements(h.breakdown) d, jsonb_array_elements(d->'rules') r
      where hc.organization_id = '${o}' and p.period_start = '${start}' and d->>'key' = '${dimension}' and r->>'rule' = '${name}'`).trim();
    return raw === '' ? null : JSON.parse(raw) as { result: string; points: number };
  };
  const alerts = (o: string): string[] => adminSql(`select rule_key || '|' || severity from public.alerts where organization_id = '${o}' order by 1`)
    .split('\n').map((l) => l.trim()).filter(Boolean);

  it('Q3 (days to get paid) now scores instead of always skipping', () => {
    expect(rule(org.INVBANK, '2026-08-01', 'customer_quality', 'Q3')).toMatchObject({ result: '60 to 90 days', points: -10 });
  });

  it('C2 (runway) now scores', () => {
    expect(rule(org.BANK, '2026-08-01', 'cash_flow', 'C2')).toMatchObject({ result: '3 to 6 months', points: 5 });
  });

  it('B1 (balance trend) reads a carried balance', () => {
    expect(rule(org.BANK, '2026-08-01', 'banking_health', 'B1')).toMatchObject({ result: 'falling for 3 months', points: -15 });
  });

  it('receivables and payables deterioration now fire on real figures', () => {
    expect(alerts(org.INVBANK)).toEqual(expect.arrayContaining(['receivables.deterioration|medium', 'payables.deterioration|high']));
  });

  it('and do not fire where nothing is owed or nothing is known', () => {
    expect(alerts(org.EMPTY)).toEqual([]);
    expect(alerts(org.TB).filter((a) => a.includes('deterioration'))).toEqual([]);
  });
});
