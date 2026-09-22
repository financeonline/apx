import { describe, expect, it } from 'vitest';
import {
  BANKING_PASS_VERSION,
  KEYWORD_RULE_SET_VERSION,
  RECURRING_DETECTOR_VERSION,
  applyPlanInMemory,
  bankingRuleVersions,
  planBankingPass,
  transferKindFor,
  type PassBankAccount,
  type PassTransaction,
} from '@/modules/banking';

/**
 * The banking pass (FINANCIAL_ENGINE.md §2.4 step 5; Phase 13, ADR-101): the three pure banking
 * rules composed into one plan of writes. What is asserted here is the composition, not the rules —
 * each rule has its own suite — and above all the three properties the calculation run relies on:
 * determinism, idempotence, and that a person's decision is never overwritten.
 */

const ORG = '00000000-0000-4000-8000-00000000aaaa';
const CURRENT = '00000000-0000-4000-8000-0000000000c1';
const SAVINGS = '00000000-0000-4000-8000-0000000000c2';
const CARD = '00000000-0000-4000-8000-0000000000c3';

const ACCOUNTS: PassBankAccount[] = [
  { id: CURRENT, name: 'Main current', accountType: 'current', isActive: true },
  { id: SAVINGS, name: 'Savings pot', accountType: 'savings', isActive: true },
  { id: CARD, name: 'Company card', accountType: 'credit_card', isActive: true },
];

const A_PAYROLL = '00000000-0000-4000-8000-0000000000a1';
const A_TRANSFER = '00000000-0000-4000-8000-0000000000a2';
const A_CARD = '00000000-0000-4000-8000-0000000000a3';
const A_OPEX = '00000000-0000-4000-8000-0000000000a4';
const A_UNCAT = '00000000-0000-4000-8000-0000000000a5';
const CATEGORY_ACCOUNTS = [
  { id: A_PAYROLL, standardCategory: 'payroll' as const },
  { id: A_TRANSFER, standardCategory: 'transfer' as const },
  { id: A_CARD, standardCategory: 'credit_card' as const },
  { id: A_OPEX, standardCategory: 'operating_expense' as const },
  { id: A_UNCAT, standardCategory: 'uncategorised' as const },
];

let seq = 0;
function row(over: Partial<PassTransaction> & Pick<PassTransaction, 'amount' | 'transactionDate'>): PassTransaction {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    bankAccountId: CURRENT,
    descriptionNormalized: null,
    counterpartyId: null,
    categoryAccountId: null,
    categorySource: 'none',
    isTransfer: false,
    transferKind: 'none',
    transferPairId: null,
    ...over,
  };
}

/** Twelve monthly wage runs, a transfer to savings and back, a card repayment, and a one-off. */
function fixture(): PassTransaction[] {
  seq = 0;
  const wages = Array.from({ length: 12 }, (_, i) =>
    row({
      amount: '-2500.00',
      transactionDate: `2026-${String(i + 1).padStart(2, '0')}-28`,
      descriptionNormalized: 'PAYROLL ACME LTD',
    }));
  const out = row({ amount: '-1000.00', transactionDate: '2026-08-10', descriptionNormalized: 'TRANSFER TO SAVINGS' });
  const inn = row({ amount: '1000.00', transactionDate: '2026-08-10', bankAccountId: SAVINGS, descriptionNormalized: 'TRANSFER FROM CURRENT' });
  const cardPay = row({ amount: '-420.00', transactionDate: '2026-08-15', descriptionNormalized: 'CARD PAYMENT TO COMPANY CARD' });
  const cardIn = row({ amount: '420.00', transactionDate: '2026-08-16', bankAccountId: CARD, descriptionNormalized: 'PAYMENT RECEIVED THANK YOU TRANSFER' });
  const oneOff = row({ amount: '-89.99', transactionDate: '2026-08-20', descriptionNormalized: 'SOME SHOP 1234' });
  return [...wages, out, inn, cardPay, cardIn, oneOff];
}

// After the last wage run, so every member is inside the detector's window and the group is still active.
const AS_OF = '2027-01-15';
const plan = (transactions: PassTransaction[]) =>
  planBankingPass({ organizationId: ORG, asOf: AS_OF, transactions, bankAccounts: ACCOUNTS, categoryAccounts: CATEGORY_ACCOUNTS });

describe('the banking pass composes the three rules into one plan', () => {
  it('categorises keyword matches, pairs the transfers, and finds the standing order', () => {
    const p = plan(fixture());
    // Every wage run goes to payroll by the keyword rule; the one-off matches nothing and stays as
    // it is (no write for "none → none").
    const payroll = p.categorisations.filter((c) => c.categoryAccountId === A_PAYROLL);
    expect(payroll).toHaveLength(12);
    expect(payroll.every((c) => c.categorySource === 'rule' && c.ruleId === 'payroll')).toBe(true);
    expect(p.categorisations.some((c) => c.categoryAccountId === null)).toBe(false);
    // Two pairs: current↔savings and current↔card. The kind is NOT in the plan (ADR-028).
    expect(p.pairs).toHaveLength(2);
    expect(Object.keys(p.pairs[0]!)).toEqual(['outflowTransactionId', 'inflowTransactionId', 'gateReason']);
    // One recurring group, monthly, twelve members, active.
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]).toMatchObject({ cadence: 'monthly', occurrenceCount: 12, status: 'active', direction: 'outflow', expectedAmount: '2500.00' });
    expect(p.versions).toEqual({ keywordRuleSet: KEYWORD_RULE_SET_VERSION, recurringDetector: RECURRING_DETECTOR_VERSION, pass: BANKING_PASS_VERSION });
  });

  it('is independent of input order', () => {
    const rows = fixture();
    const forwards = plan(rows);
    const backwards = plan([...rows].reverse());
    const shuffled = plan([...rows].sort((a, b) => a.amount.localeCompare(b.amount)));
    expect(backwards).toEqual(forwards);
    expect(shuffled).toEqual(forwards);
  });

  it('plans nothing on a second pass over the applied result (idempotence)', () => {
    const rows = fixture();
    const first = plan(rows);
    const applied = applyPlanInMemory(rows, ACCOUNTS, first, transferKindFor, CATEGORY_ACCOUNTS);
    const second = plan(applied);
    expect(second.categorisations).toEqual([]);
    expect(second.pairs).toEqual([]);
    // Groups are recomputed every run and upserted on their key; the plan is the same plan.
    expect(second.groups).toEqual(first.groups);
  });

  it('never touches a row a person decided, and never pairs one', () => {
    const rows = fixture();
    // A wage run somebody moved to operating expenses by hand, and the savings leg they left alone
    // on purpose (category chosen, so it is a decision).
    const decidedWage = { ...rows[0]!, categoryAccountId: A_OPEX, categorySource: 'user' as const };
    const decidedLeg = { ...rows[12]!, categoryAccountId: A_OPEX, categorySource: 'user' as const };
    const p = plan([decidedWage, decidedLeg, ...rows.slice(1, 12), ...rows.slice(13)]);
    expect(p.categorisations.find((c) => c.transactionId === decidedWage.id)).toBeUndefined();
    expect(p.categorisations.find((c) => c.transactionId === decidedLeg.id)).toBeUndefined();
    // The savings pair is gone (its outflow leg is decided); the card pair remains.
    expect(p.pairs).toHaveLength(1);
    expect(p.pairs[0]!.inflowTransactionId).toBe(rows[15]!.id);
  });

  it('leaves existing transfer legs alone and keeps them out of recurring detection', () => {
    seq = 0;
    const sweeps = Array.from({ length: 6 }, (_, i) => {
      const out = row({ amount: '-500.00', transactionDate: `2026-0${i + 3}-01`, descriptionNormalized: 'TRANSFER TO SAVINGS' });
      const inn = row({ amount: '500.00', transactionDate: `2026-0${i + 3}-01`, bankAccountId: SAVINGS, descriptionNormalized: 'TRANSFER FROM CURRENT' });
      return [
        { ...out, isTransfer: true, transferKind: 'cash_transfer' as const, transferPairId: inn.id, categoryAccountId: A_TRANSFER, categorySource: 'rule' as const },
        { ...inn, isTransfer: true, transferKind: 'cash_transfer' as const, transferPairId: out.id, categoryAccountId: A_TRANSFER, categorySource: 'rule' as const },
      ];
    }).flat();
    const p = plan(sweeps);
    expect(p.pairs).toEqual([]);
    expect(p.categorisations).toEqual([]);
    expect(p.groups).toEqual([]);
  });

  it('gives a hand-marked transfer leg the category its kind implies, once', () => {
    seq = 0;
    const out = row({ amount: '-300.00', transactionDate: '2026-08-01', descriptionNormalized: 'TFR' });
    const inn = row({ amount: '300.00', transactionDate: '2026-08-01', bankAccountId: SAVINGS, descriptionNormalized: 'TFR' });
    const marked = [
      { ...out, isTransfer: true, transferKind: 'cash_transfer' as const, transferPairId: inn.id },
      { ...inn, isTransfer: true, transferKind: 'cash_transfer' as const, transferPairId: out.id },
    ];
    const p = plan(marked);
    expect(p.categorisations).toEqual([
      { transactionId: out.id, categoryAccountId: A_TRANSFER, categorySource: 'rule', ruleId: null },
      { transactionId: inn.id, categoryAccountId: A_TRANSFER, categorySource: 'rule', ruleId: null },
    ]);
    const again = plan(applyPlanInMemory(marked, ACCOUNTS, p, transferKindFor, CATEGORY_ACCOUNTS));
    expect(again.categorisations).toEqual([]);
  });

  it('withdraws a rule category the rules no longer support, but never a person’s', () => {
    seq = 0;
    // A row a previous rule set categorised as payroll whose description no longer matches anything.
    const stale = row({ amount: '-50.00', transactionDate: '2026-08-02', descriptionNormalized: 'SOMETHING ELSE', categoryAccountId: A_PAYROLL, categorySource: 'rule' });
    const p = plan([stale]);
    expect(p.categorisations).toEqual([
      { transactionId: stale.id, categoryAccountId: null, categorySource: 'none', ruleId: null },
    ]);
  });

  it('reports transfer look-alikes it refused to pair, and the rule versions it applied', () => {
    seq = 0;
    // Same amount, two days apart, different accounts — but no transfer wording on either leg.
    const receipt = row({ amount: '4800.00', transactionDate: '2026-08-10', descriptionNormalized: 'ACME INVOICE 1001' });
    const payment = row({ amount: '-4800.00', transactionDate: '2026-08-12', bankAccountId: SAVINGS, descriptionNormalized: 'BETA SUPPLIES' });
    const p = plan([receipt, payment]);
    expect(p.pairs).toEqual([]);
    expect(p.unpairedCandidates.map((c) => c.reason)).toContain('description_gate_failed');
    expect(bankingRuleVersions()).toBe(`${KEYWORD_RULE_SET_VERSION}|${RECURRING_DETECTOR_VERSION}|${BANKING_PASS_VERSION}`);
  });
});
