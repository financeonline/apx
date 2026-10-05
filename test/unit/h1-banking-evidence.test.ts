import { describe, expect, it } from 'vitest';

import { computeCoverage, type BankAccountRef, type CoverageBatch, type PeriodRef } from '@/modules/financial-engine';
import { DIMENSION_WEIGHTS, computeHealthScore } from '@/modules/health';
import { healthInput } from '../fixtures/health';

/**
 * H-1 (independent audit of step0d-review-frozen): an organisation with no bank data was scored
 * Banking Health 60 with B4 "full coverage +10", because the completeness ratio — 1 when there is no
 * cash-like account to wait for — was handed to Health as if it were a fact about banking.
 *
 * Coverage now states two things: `bankCoverageRatio` (completeness, unchanged) and
 * `bankEvidenceRatio` (what is known about banking: NULL when no cash-like account is in scope). Health
 * reads the second. Every account shape the brief names is here.
 */

const aug: PeriodRef = {
  id: 'p-aug', periodStart: '2026-08-01', periodEnd: '2026-08-31', fiscalYear: 2026, fiscalQuarter: 3, label: 'Aug 2026', isComplete: true,
};
const account = (id: string, over: Partial<BankAccountRef> = {}): BankAccountRef => ({
  id, name: id, accountType: 'current', openingBalance: null, openingBalanceDate: null, isActive: true, ...over,
});
const statement = (bankAccountId: string, periodStart: string, periodEnd: string): CoverageBatch => ({
  id: `st-${bankAccountId}-${periodStart}`, targetTable: 'bank_transactions', balanceKind: null, balanceBasis: null,
  bankAccountId, invoiceListKind: null, importType: 'bank_statement', periodStart, periodEnd, committedAt: '2026-09-10T10:00:00Z',
});
const coverage = (bankAccounts: BankAccountRef[], batches: CoverageBatch[] = []) =>
  computeCoverage({ period: aug, batches, bankAccounts, rowCounts: {}, asOf: '2026-09-15' });

describe('H-1 · bank evidence is stated separately from completeness', () => {
  it.each([
    ['no bank account at all', [], [], 1, null],
    ['only a credit card and a loan (not cash-like)', [account('card', { accountType: 'credit_card' }), account('loan', { accountType: 'loan' })], [], 1, null],
    ['only a closed account whose last statement ended in June', [account('old', { isActive: false })], [statement('old', '2026-06-01', '2026-06-30')], 1, null],
    ['an active account with no statement', [account('a')], [], 0, 0],
    ['two accounts, one covered', [account('a'), account('b')], [statement('a', '2026-08-01', '2026-08-31')], 0.5, 0.5],
    ['every account covered', [account('a')], [statement('a', '2026-08-01', '2026-08-31')], 1, 1],
  ] as const)('%s', (_name, accounts, batches, completeness, evidence) => {
    const c = coverage([...accounts], [...batches]);
    expect(c.bankCoverageRatio).toBe(completeness);
    expect(c.bankEvidenceRatio).toBe(evidence);
  });
});

describe('H-1 · Health with no bank evidence', () => {
  const included = (ratio: number | null) => computeHealthScore(healthInput({ bankCoverageRatio: ratio }))!;
  const banking = (ratio: number | null) => included(ratio).breakdown.find((d) => d.key === 'banking_health')!;

  it('no bank data: banking_health is excluded (no_bank_coverage), never scored full or poor', () => {
    const d = banking(null);
    expect(d.included).toBe(false);
    expect(d.exclusion_reason).toBe('no_bank_coverage');
    expect(d.rules.find((r) => r.rule === 'B4')).toMatchObject({ points: 0 });
    expect(d.rules.find((r) => r.rule === 'B4')!.result).toBe('skipped');
  });

  it('accounts with no covered statement: also excluded, with no penalty', () => {
    expect(banking(0)).toMatchObject({ included: false, exclusion_reason: 'no_bank_coverage' });
  });

  it('partial and complete coverage: included, B4 partial and full', () => {
    expect(banking(0.5).included).toBe(true);
    expect(banking(0.5).rules.find((r) => r.rule === 'B4')!.result).toBe('partial');
    expect(banking(1).rules.find((r) => r.rule === 'B4')!.result).toBe('full');
  });

  it('the total renormalises over the remaining dimensions by the established rule', () => {
    const score = included(null);
    const rest = score.breakdown.filter((d) => d.included);
    expect(rest.map((d) => d.key)).not.toContain('banking_health');
    // Independent of the scorer's own arithmetic: Σ score × config weight ÷ Σ config weight, rounded.
    const total = rest.reduce((t, d) => t + (d.score as number) * DIMENSION_WEIGHTS[d.key as keyof typeof DIMENSION_WEIGHTS], 0)
      / rest.reduce((t, d) => t + DIMENSION_WEIGHTS[d.key as keyof typeof DIMENSION_WEIGHTS], 0);
    expect(score.score).toBe(Math.round(total));
    expect(score.dimensionsUsed).toBe(rest.length);
  });
});
