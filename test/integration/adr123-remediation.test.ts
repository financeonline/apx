import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolveDescriptor } from '@/modules/evidence';
import type { AccessContext } from '@/modules/tenancy';
import { AS_OF, calculateAndAlert, headline } from '../fixtures/adr120-orgs';
import { seedAuditOrgs, type AuditKey } from '../fixtures/audit-orgs';
import { adminSql, clientFor } from './setup';

/**
 * ADR-123 — every blocking finding of the ADR-120 independent audit, reproduced on the auditor's own
 * data shapes (test/fixtures/audit-orgs.ts) through the real queue, now answered with the truth the
 * auditor computed — or, where the data cannot establish the truth, with an honest NULL.
 */

const TAG = `a${Date.now().toString(36)}`;
const KEYS: readonly AuditKey[] = [
  'GAP', 'MIDSTART', 'LEDGER2', 'TBBS', 'MOVTB', 'CURRENT', 'CREDITHEAVY', 'PARTIALPD', 'LONG', 'BIGINV', 'BSREV',
];
let org: Partial<Record<AuditKey, string>>;
const o = (k: AuditKey): string => org[k]!;

const money = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Decimal(value).toFixed(2);
const v = (k: AuditKey, start: string, key: string): string | null => money(headline(o(k), start, key)?.value);
const assurance = (k: AuditKey, start: string, key: string): string => adminSql(`select s.assurance_level
  from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
  join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
  where c.organization_id = '${o(k)}' and p.period_start = '${start}' and c.metric_key = '${key}' and c.dimension_type = 'none'`).trim();

const owner = (id: string): string =>
  adminSql(`select user_id from public.organization_memberships where organization_id = '${id}' and role = 'owner' limit 1`).trim();
const ctxFor = (id: string): AccessContext => ({
  userId: owner(id), orgId: id, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(owner(id)), requestId: TAG, now: () => new Date(`${AS_OF}T00:00:00Z`),
  organizationStatus: 'active',
});
const drill = async (k: AuditKey, start: string, key: string) => {
  const snapshot = headline(o(k), start, key)!;
  const query = JSON.parse(adminSql(`select evidence_query::text from public.metric_snapshots where id = '${snapshot.snapshotId}'`).trim()) as { descriptor: unknown };
  const selection = await resolveDescriptor(ctxFor(o(k)), query.descriptor);
  return { figure: money(snapshot.value), evidence: money(selection.total), rows: selection.count };
};

beforeAll(async () => {
  org = await seedAuditOrgs(TAG, KEYS);
  for (const k of KEYS) await calculateAndAlert(o(k));
}, 1_500_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id in (${Object.values(org).map((id) => `'${id}'`).join(',')});
            delete from auth.users where email like '%@${TAG}.adr123.itest';`);
});

describe('F-1 · a missing statement month restarts the cash chain at the next statement\'s printed opening', () => {
  it('June opens at its statement\'s printed 10,000', () => {
    expect([v('GAP', '2026-06-01', 'opening_cash'), v('GAP', '2026-06-01', 'closing_cash')]).toEqual(['10000.00', '9000.00']);
    expect(assurance('GAP', '2026-06-01', 'opening_cash')).toBe('verified');
  });

  it('July, with no statement, is unknown — not 9,000 carried forward (§2.3)', () => {
    expect(headline(o('GAP'), '2026-07-01', 'closing_cash')?.value).toBeNull();
    expect(headline(o('GAP'), '2026-07-01', 'closing_cash')?.missing).toContain('no_source_covers_period');
  });

  it('so August raises no "cash fell from 9,000" alert off an invented July', () => {
    const declines = adminSql(`select count(*) from public.alerts where organization_id = '${o('GAP')}' and rule_key = 'cash.decline'`).trim();
    expect(Number(declines)).toBe(0);
  });

  it('August opens at its own statement\'s 4,000 — not the 9,000 carried across the gap — and closes at the truth', () => {
    expect([v('GAP', '2026-08-01', 'opening_cash'), v('GAP', '2026-08-01', 'closing_cash')]).toEqual(['4000.00', '3500.00']);
    expect(assurance('GAP', '2026-08-01', 'opening_cash')).toBe('verified');
    // The printed closing (3,500) now cross-checks the computed one (FU-4 wired): they agree.
    expect(headline(o('GAP'), '2026-08-01', 'closing_cash')?.warnings).not.toContain('statement_balance_mismatch');
  });
});

describe('F-2 · only a statement that starts ON a period start opens that period', () => {
  it('July — whose only statement began on 21 June — opens at the truth, 5,000, not a verified 10,000', () => {
    // ADR-123 could only make July unknown. ADR-124 D-1 chains S1's printed 10,000 (the close of 31 May)
    // through S1 and S2, which together cover every day: 1 July = 5,000, July closes at 5,500.
    expect([v('MIDSTART', '2026-07-01', 'opening_cash'), v('MIDSTART', '2026-07-01', 'closing_cash')]).toEqual(['5000.00', '5500.00']);
  });

  it('August restarts at its own statement\'s printed 5,500 and closes at the truth, 5,600', () => {
    expect([v('MIDSTART', '2026-08-01', 'opening_cash'), v('MIDSTART', '2026-08-01', 'closing_cash')]).toEqual(['5500.00', '5600.00']);
  });
});

describe('F-3 · two opening journals: the latest one at or before P', () => {
  it('June 6,000 · July 7,000 · August 5,000 (was 13,000 / 11,000)', () => {
    expect(['2026-06-01', '2026-07-01', '2026-08-01'].map((m) => v('LEDGER2', m, 'receivables')))
      .toEqual(['6000.00', '7000.00', '5000.00']);
  });

  it('and its drill-down reconciles to the true balance', async () => {
    expect(await drill('LEDGER2', '2026-08-01', 'receivables')).toMatchObject({ figure: '5000.00', evidence: '5000.00' });
  });
});

describe('F-4 · a list whose range starts after a month states nothing about it', () => {
  it('February is unknown (stale_invoice_data), not a verified 0.00', () => {
    const feb = headline(o('BSREV'), '2026-02-01', 'receivables')!;
    expect(feb.value).toBeNull();
    expect(feb.missing).toContain('stale_invoice_data');
  });
});

describe('F-5 · days to get paid never divides by revenue no source stated', () => {
  it('April and May: unknown, not 91 days', () => {
    for (const month of ['2026-04-01', '2026-05-01']) {
      expect(v('BSREV', month, 'receivables'), month).toBe('3000.00');
      expect(headline(o('BSREV'), month, 'receivables_days')?.value, month).toBeNull();
    }
  });
});

describe('F-6 · a trial balance and a balance sheet for the same month: one statement, one drill-down', () => {
  it('receivables 9,000 drills down to 9,000 (was 18,000); payables 4,000 to 4,000', async () => {
    expect(await drill('TBBS', '2026-08-01', 'receivables')).toMatchObject({ figure: '9000.00', evidence: '9000.00' });
    expect(await drill('TBBS', '2026-08-01', 'payables')).toMatchObject({ figure: '4000.00', evidence: '4000.00' });
  });

  it('L-3 · a movement-basis trial balance gives way to the cumulative balance sheet', async () => {
    expect(await drill('MOVTB', '2026-08-01', 'receivables')).toMatchObject({ figure: '9000.00', evidence: '9000.00' });
    expect(v('MOVTB', '2026-08-01', 'payables')).toBe('4000.00');
  });
});

describe('F-7 · a part-paid invoice with a payment date stays in its drill-down', () => {
  it('July receivables 600 drill down to 600 in one row (was 0.00, 0 rows)', async () => {
    expect(await drill('PARTIALPD', '2026-07-01', 'receivables')).toEqual({ figure: '600.00', evidence: '600.00', rows: 1 });
    expect(await drill('PARTIALPD', '2026-07-01', 'receivables_overdue')).toMatchObject({ figure: '600.00', evidence: '600.00' });
  });
});

describe('F-8 · a drill-down over a thousand invoices opens', () => {
  it('BIGINV August receivables 10,500 resolves to 10,500 (was HTTP 414)', async () => {
    expect(await drill('BIGINV', '2026-08-01', 'receivables')).toMatchObject({ figure: '10500.00', evidence: '10500.00', rows: 1050 });
  });
});

describe('F-9 · the current month is aged from a list uploaded during it', () => {
  it('September (as of 15 Sep) from a list committed 10 Sep: 1,500 owed, 1,000 overdue', () => {
    expect(v('CURRENT', '2026-09-01', 'receivables')).toBe('1500.00');
    expect(v('CURRENT', '2026-09-01', 'receivables_overdue')).toBe('1000.00');
  });
});

describe('F-10 · the deterioration alerts state possible facts', () => {
  const revisions = (k: AuditKey) => adminSql(`select r.threshold_summary::text from public.alerts a
    join public.alert_revisions r on r.alert_id = a.id and r.organization_id = a.organization_id
    where a.organization_id = '${o(k)}' and a.rule_key = 'receivables.deterioration'`)
    .split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as Record<string, string | null>);

  it('a net credit (receivables −700) is not "700 owed and overdue": no open alert in August', () => {
    expect(v('CREDITHEAVY', '2026-08-01', 'receivables')).toBe('-700.00');
    const open = adminSql(`select count(*) from public.alerts a join public.fiscal_periods p on p.id = a.period_id
      where a.organization_id = '${o('CREDITHEAVY')}' and a.rule_key = 'receivables.deterioration'
        and a.status = 'open' and p.period_start = '2026-08-01'`).trim();
    expect(Number(open)).toBe(0);
  });

  it('"the top three account for" never exceeds 100%, and no total is shown unsigned', () => {
    for (const summary of [...revisions('CREDITHEAVY'), ...revisions('BIGINV')]) {
      if (summary.top3_share !== null && summary.top3_share !== undefined) {
        expect(new Decimal(summary.top3_share).lessThanOrEqualTo(1)).toBe(true);
      }
      expect(new Decimal(summary.total!).greaterThan(0)).toBe(true);
    }
  });
});

describe('the chain across a 12-month chunk boundary (LONG, 15 months)', () => {
  it('every month opens at the one before\'s close', () => {
    const months = adminSql(`select p.period_start from public.fiscal_periods p where p.organization_id = '${o('LONG')}'
      and p.period_start between '2025-06-01' and '2026-08-01' order by 1`).split('\n').map((l) => l.trim()).filter(Boolean);
    expect(months.length).toBe(15);
    for (let i = 1; i < months.length; i += 1) {
      expect(v('LONG', months[i]!, 'opening_cash'), months[i]).toBe(v('LONG', months[i - 1]!, 'closing_cash'));
    }
  });
});
