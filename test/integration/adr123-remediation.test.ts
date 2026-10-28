import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolveDescriptor } from '@/modules/evidence';
import type { AccessContext } from '@/modules/tenancy';
import { AS_OF, calculateAndAlert, headline } from '../fixtures/adr120-orgs';
import { seedAuditOrgs, type AuditKey } from '../fixtures/audit-orgs';
import { periodId } from '@/db/app/shared';
import { orgCollection } from '@/db/schema';
import { currentFigure, ownerOf } from '../fixtures/engine-reads';
import { removeSeeded } from '../fixtures/seed';
import { clientFor, fs } from './setup';

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
const v = async (k: AuditKey, start: string, key: string): Promise<string | null> => money((await headline(o(k), start, key))?.value);
const assurance = async (k: AuditKey, start: string, key: string): Promise<string> =>
  (await currentFigure(o(k), start, key))?.assurance ?? '';

const owners = new Map<string, string>();
const owner = (id: string): string => owners.get(id)!;
const ctxFor = (id: string): AccessContext => ({
  userId: owner(id), orgId: id, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(owner(id)), requestId: TAG, now: () => new Date(`${AS_OF}T00:00:00Z`),
  organizationStatus: 'active',
});
const drill = async (k: AuditKey, start: string, key: string) => {
  const snapshot = (await currentFigure(o(k), start, key))!;
  const query = snapshot.evidenceQuery as { descriptor: unknown };
  const selection = await resolveDescriptor(ctxFor(o(k)), query.descriptor);
  return { figure: money(snapshot.value), evidence: money(selection.total), rows: selection.count };
};
/** The organisation's alerts (fixture read), with the start of each one's period. */
const alertsOf = async (k: AuditKey, ruleKey: string) =>
  (await orgCollection(fs(), o(k), 'alerts').where('rule_key', '==', ruleKey).get()).docs.map((d) => d.data());

beforeAll(async () => {
  org = await seedAuditOrgs(TAG, KEYS);
  for (const k of KEYS) owners.set(o(k), await ownerOf(o(k)));
  for (const k of KEYS) await calculateAndAlert(o(k));
}, 3_600_000);

afterAll(async () => {
  if (!org) return;
  await removeSeeded(Object.values(org), `@${TAG}.adr123.itest`);
}, 600_000);

describe('F-1 · a missing statement month restarts the cash chain at the next statement\'s printed opening', () => {
  it('June opens at its statement\'s printed 10,000', async () => {
    expect([await v('GAP', '2026-06-01', 'opening_cash'), await v('GAP', '2026-06-01', 'closing_cash')]).toEqual(['10000.00', '9000.00']);
    expect(await assurance('GAP', '2026-06-01', 'opening_cash')).toBe('verified');
  });

  it('July, with no statement, is unknown — not 9,000 carried forward (§2.3)', async () => {
    expect((await headline(o('GAP'), '2026-07-01', 'closing_cash'))?.value).toBeNull();
    expect((await headline(o('GAP'), '2026-07-01', 'closing_cash'))?.missing).toContain('no_source_covers_period');
  });

  it('so August raises no "cash fell from 9,000" alert off an invented July', async () => {
    expect(await alertsOf('GAP', 'cash.decline')).toHaveLength(0);
  });

  it('August opens at its own statement\'s 4,000 — not the 9,000 carried across the gap — and closes at the truth', async () => {
    expect([await v('GAP', '2026-08-01', 'opening_cash'), await v('GAP', '2026-08-01', 'closing_cash')]).toEqual(['4000.00', '3500.00']);
    expect(await assurance('GAP', '2026-08-01', 'opening_cash')).toBe('verified');
    // The printed closing (3,500) now cross-checks the computed one (FU-4 wired): they agree.
    expect((await headline(o('GAP'), '2026-08-01', 'closing_cash'))?.warnings).not.toContain('statement_balance_mismatch');
  });
});

describe('F-2 · only a statement that starts ON a period start opens that period', () => {
  it('July — whose only statement began on 21 June — opens at the truth, 5,000, not a verified 10,000', async () => {
    // ADR-123 could only make July unknown. ADR-124 D-1 chains S1's printed 10,000 (the close of 31 May)
    // through S1 and S2, which together cover every day: 1 July = 5,000, July closes at 5,500.
    expect([await v('MIDSTART', '2026-07-01', 'opening_cash'), await v('MIDSTART', '2026-07-01', 'closing_cash')]).toEqual(['5000.00', '5500.00']);
  });

  it('August restarts at its own statement\'s printed 5,500 and closes at the truth, 5,600', async () => {
    expect([await v('MIDSTART', '2026-08-01', 'opening_cash'), await v('MIDSTART', '2026-08-01', 'closing_cash')]).toEqual(['5500.00', '5600.00']);
  });
});

describe('F-3 · two opening journals: the latest one at or before P', () => {
  it('June 6,000 · July 7,000 · August 5,000 (was 13,000 / 11,000)', async () => {
    expect(await Promise.all(['2026-06-01', '2026-07-01', '2026-08-01'].map((m) => v('LEDGER2', m, 'receivables'))))
      .toEqual(['6000.00', '7000.00', '5000.00']);
  });

  it('and its drill-down reconciles to the true balance', async () => {
    expect(await drill('LEDGER2', '2026-08-01', 'receivables')).toMatchObject({ figure: '5000.00', evidence: '5000.00' });
  });
});

describe('F-4 · a list whose range starts after a month states nothing about it', () => {
  it('February is unknown (stale_invoice_data), not a verified 0.00', async () => {
    const feb = (await headline(o('BSREV'), '2026-02-01', 'receivables'))!;
    expect(feb.value).toBeNull();
    expect(feb.missing).toContain('stale_invoice_data');
  });
});

describe('F-5 · days to get paid never divides by revenue no source stated', () => {
  it('April and May: unknown, not 91 days', async () => {
    for (const month of ['2026-04-01', '2026-05-01']) {
      expect(await v('BSREV', month, 'receivables'), month).toBe('3000.00');
      expect((await headline(o('BSREV'), month, 'receivables_days'))?.value, month).toBeNull();
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
    expect(await v('MOVTB', '2026-08-01', 'payables')).toBe('4000.00');
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
  it('September (as of 15 Sep) from a list committed 10 Sep: 1,500 owed, 1,000 overdue', async () => {
    expect(await v('CURRENT', '2026-09-01', 'receivables')).toBe('1500.00');
    expect(await v('CURRENT', '2026-09-01', 'receivables_overdue')).toBe('1000.00');
  });
});

describe('F-10 · the deterioration alerts state possible facts', () => {
  const revisions = async (k: AuditKey): Promise<Array<Record<string, string | null>>> => {
    const ids = new Set((await alertsOf(k, 'receivables.deterioration')).map((a) => String(a.id)));
    const all = await orgCollection(fs(), o(k), 'alert_revisions').get();
    return all.docs.filter((r) => ids.has(String(r.get('alert_id'))))
      .map((r) => (r.get('threshold_summary') ?? {}) as Record<string, string | null>);
  };

  it('a net credit (receivables −700) is not "700 owed and overdue": no open alert in August', async () => {
    expect(await v('CREDITHEAVY', '2026-08-01', 'receivables')).toBe('-700.00');
    const open = (await alertsOf('CREDITHEAVY', 'receivables.deterioration'))
      .filter((a) => a.status === 'open' && a.period_id === periodId(o('CREDITHEAVY'), '2026-08-01'));
    expect(open).toHaveLength(0);
  });

  it('"the top three account for" never exceeds 100%, and no total is shown unsigned', async () => {
    for (const summary of [...await revisions('CREDITHEAVY'), ...await revisions('BIGINV')]) {
      if (summary.top3_share !== null && summary.top3_share !== undefined) {
        expect(new Decimal(summary.top3_share).lessThanOrEqualTo(1)).toBe(true);
      }
      expect(new Decimal(summary.total!).greaterThan(0)).toBe(true);
    }
  });
});

describe('the chain across a 12-month chunk boundary (LONG, 15 months)', () => {
  it('every month opens at the one before\'s close', async () => {
    const months = (await orgCollection(fs(), o('LONG'), 'fiscal_periods').get()).docs.map((d) => String(d.get('period_start')))
      .filter((m) => m >= '2025-06-01' && m <= '2026-08-01').sort();
    expect(months.length).toBe(15);
    for (let i = 1; i < months.length; i += 1) {
      expect(await v('LONG', months[i]!, 'opening_cash'), months[i]).toBe(await v('LONG', months[i - 1]!, 'closing_cash'));
    }
  });
});
