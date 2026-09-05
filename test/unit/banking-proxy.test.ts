import { describe, expect, it } from 'vitest';

import {
  NON_PNL_CATEGORIES,
  UNCATEGORISED_MISSING_THRESHOLD,
  UNCATEGORISED_WARNING_THRESHOLD,
  buildBankProxy,
  cashAccountIds,
  hasUnclassifiedCardSpend,
  isNonPnlCategory,
  netOfVat,
  proxyBankAccountIds,
  type BankProxyInput,
  type ProxyBankAccount,
  type ProxyTransaction,
  type ProxyVatSettings,
} from '@/modules/banking';
import { Decimal } from '@/core/money';

/**
 * Bank → cash accounts and the bank-basis P&L proxy (FINANCIAL_ENGINE.md §4.4; ADR-028, ADR-047.12).
 *
 * The single most expensive mistake in this file would be mixing the two account sets: cash is
 * `{current, savings}` only, while the proxy reads every active account INCLUDING the card and the
 * loan. Leaving the card out understates expenses by every card purchase; putting the card into
 * cash reports borrowed money as money in the bank.
 */

const CURRENT: ProxyBankAccount = { id: 'acc-current', accountType: 'current', isActive: true };
const SAVINGS: ProxyBankAccount = { id: 'acc-savings', accountType: 'savings', isActive: true };
const CARD: ProxyBankAccount = { id: 'acc-card', accountType: 'credit_card', isActive: true };
const LOAN: ProxyBankAccount = { id: 'acc-loan', accountType: 'loan', isActive: true };
const CLOSED: ProxyBankAccount = { id: 'acc-closed', accountType: 'current', isActive: false };

const ACCOUNTS = [CURRENT, SAVINGS, CARD, LOAN, CLOSED];

const NO_VAT: ProxyVatSettings = {
  vatRegistered: false,
  defaultVatRate: null,
  taxableCategories: ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'],
};

let counter = 0;
function txn(over: Partial<ProxyTransaction> = {}): ProxyTransaction {
  counter += 1;
  return {
    id: `t-${String(counter).padStart(3, '0')}`,
    bankAccountId: CURRENT.id,
    amount: '-100.00',
    standardCategory: 'operating_expense',
    categoryAccountId: 'acct-operating_expense',
    isTransfer: false,
    transferKind: 'none',
    ...over,
  };
}

function proxy(over: Partial<BankProxyInput> = {}) {
  return buildBankProxy({
    periodId: 'period-2026-03',
    transactions: [],
    bankAccounts: ACCOUNTS,
    cardStatementCoversPeriod: true,
    vat: NO_VAT,
    ...over,
  });
}

describe('the two account sets are different, deliberately (§4.4, ADR-028)', () => {
  it('feeds opening/closing cash from current and savings only', () => {
    expect(cashAccountIds(ACCOUNTS)).toEqual(['acc-current', 'acc-savings']);
  });

  it('excludes inactive accounts from cash', () => {
    expect(cashAccountIds(ACCOUNTS)).not.toContain('acc-closed');
  });

  it('gives the proxy every ACTIVE account, liability accounts included', () => {
    expect(proxyBankAccountIds(ACCOUNTS)).toEqual(['acc-card', 'acc-current', 'acc-loan', 'acc-savings']);
  });

  it('returns both lists sorted, so the descriptor hashes identically on two runs', () => {
    const shuffled = [LOAN, CLOSED, SAVINGS, CARD, CURRENT];
    expect(proxyBankAccountIds(shuffled)).toEqual(proxyBankAccountIds(ACCOUNTS));
    expect(cashAccountIds(shuffled)).toEqual(cashAccountIds(ACCOUNTS));
  });
});

describe('NON_PNL is derived, so it cannot drift from the P&L set (§3)', () => {
  it('holds exactly the categories the document names', () => {
    for (const category of ['transfer', 'drawings', 'equity', 'loan', 'credit_card', 'tax_liability'] as const) {
      expect(isNonPnlCategory(category)).toBe(true);
    }
  });

  it('holds no P&L category', () => {
    for (const category of ['revenue', 'cost_of_sales', 'operating_expense', 'payroll', 'marketing'] as const) {
      expect(isNonPnlCategory(category)).toBe(false);
    }
  });

  it('includes uncategorised — an unclassified movement is not evidence of profit', () => {
    expect(NON_PNL_CATEGORIES).toContain('uncategorised');
  });
});

describe('the proxy reads all active accounts including liability accounts (§4.4)', () => {
  it('counts a card purchase as an expense', () => {
    // The purchase exists only on the card statement. Leaving the card out would lose it.
    const result = proxy({
      transactions: [txn({ bankAccountId: CARD.id, amount: '-250.00', standardCategory: 'marketing', categoryAccountId: 'acct-marketing' })],
    });
    expect(result.expensesByCategory).toEqual([{ category: 'marketing', amount: '250.00' }]);
  });

  it('ignores a transaction on a closed account', () => {
    const result = proxy({ transactions: [txn({ bankAccountId: CLOSED.id, amount: '-500.00' })] });
    expect(result.totalExpenses).toBe('0.00');
  });

  it('maps revenue-category inflows to revenue', () => {
    const result = proxy({
      transactions: [
        txn({ amount: '2400.00', standardCategory: 'revenue', categoryAccountId: 'acct-revenue' }),
        txn({ amount: '600.00', standardCategory: 'revenue', categoryAccountId: 'acct-revenue' }),
      ],
    });
    expect(result.revenue).toBe('3000.00');
  });

  it('maps outflows by category to expenses, one entry per category, sorted', () => {
    const result = proxy({
      transactions: [
        txn({ amount: '-800.00', standardCategory: 'marketing', categoryAccountId: 'acct-marketing' }),
        txn({ amount: '-1500.00', standardCategory: 'operating_expense', categoryAccountId: 'acct-opex' }),
        txn({ amount: '-500.00', standardCategory: 'marketing', categoryAccountId: 'acct-marketing' }),
      ],
    });
    expect(result.expensesByCategory).toEqual([
      { category: 'marketing', amount: '1300.00' },
      { category: 'operating_expense', amount: '1500.00' },
    ]);
    expect(result.totalExpenses).toBe('2800.00');
  });

  it('writes no entry for a category with no rows — absence is not zero (§3.1)', () => {
    const result = proxy({ transactions: [txn({ standardCategory: 'payroll', categoryAccountId: 'acct-payroll' })] });
    expect(result.expensesByCategory.map((e) => e.category)).toEqual(['payroll']);
  });

  it('is estimated and flagged as a proxy (§2.3)', () => {
    const result = proxy({ transactions: [txn()] });
    expect(result.assurance).toBe('estimated');
    expect(result.proxy).toBe(true);
    expect(result.warnings).toContain('cash_basis_proxy');
    expect(result.warnings).toContain('vat_inclusive');
  });
});

describe('the proxy excludes transfers of EVERY kind (§4.4, ADR-047.12)', () => {
  const kinds = ['cash_transfer', 'card_repayment', 'loan_repayment', 'loan_drawdown', 'other_transfer'] as const;

  for (const transferKind of kinds) {
    it(`excludes a ${transferKind} row`, () => {
      const result = proxy({
        transactions: [txn({ amount: '-1200.00', isTransfer: true, transferKind, standardCategory: 'credit_card', categoryAccountId: 'acct-credit_card' })],
      });
      expect(result.totalExpenses).toBe('0.00');
      expect(result.components.excluded_transfer_rows).toBe(1);
    });
  }

  it('excludes the card REPAYMENT while keeping the card PURCHASE', () => {
    // The repayment moves money between two of the company's own balances; the purchase is the cost.
    const result = proxy({
      transactions: [
        txn({ bankAccountId: CURRENT.id, amount: '-1200.00', isTransfer: true, transferKind: 'card_repayment', standardCategory: 'credit_card', categoryAccountId: 'acct-credit_card' }),
        txn({ bankAccountId: CARD.id, amount: '-250.00', standardCategory: 'marketing', categoryAccountId: 'acct-marketing' }),
      ],
    });
    expect(result.totalExpenses).toBe('250.00');
  });

  it('excludes every NON_PNL category even when the row is not a transfer', () => {
    const result = proxy({
      transactions: [
        txn({ amount: '-2000.00', standardCategory: 'drawings', categoryAccountId: 'acct-drawings' }),
        txn({ amount: '-620.00', standardCategory: 'loan', categoryAccountId: 'acct-loan' }),
        txn({ amount: '-4100.00', standardCategory: 'tax_liability', categoryAccountId: 'acct-tax_liability' }),
      ],
    });
    expect(result.totalExpenses).toBe('0.00');
    expect(result.components.excluded_non_pnl_rows).toBe(3);
  });

  it('carries a descriptor naming all active accounts and exclude_transfers: all', () => {
    const result = proxy({ transactions: [txn()] });
    expect(result.descriptor).toEqual({
      period_ids: ['period-2026-03'],
      bank_account_ids: ['acc-card', 'acc-current', 'acc-loan', 'acc-savings'],
      exclude_transfers: 'all',
    });
  });

  it('records the same account list in components, so the drawer reconciles to the same set', () => {
    const result = proxy({ transactions: [txn()] });
    expect(result.components.bank_account_ids).toEqual(result.descriptor.bank_account_ids);
  });

  it('records a revenue-category OUTFLOW (a refund) instead of netting it off revenue', () => {
    // §4.4 maps only revenue INFLOWS to revenue. Netting a refund here would be an accounting rule
    // the document does not state, so the amount is disclosed rather than assumed.
    const result = proxy({
      transactions: [
        txn({ amount: '2400.00', standardCategory: 'revenue', categoryAccountId: 'acct-revenue' }),
        txn({ amount: '-400.00', standardCategory: 'revenue', categoryAccountId: 'acct-revenue' }),
      ],
    });
    expect(result.revenue).toBe('2400.00');
    expect(result.totalExpenses).toBe('0.00');
    expect(result.components.inflows_in_expense_categories).toBe('400.00');
  });

  it('records an inflow sitting in an expense category rather than letting it disappear', () => {
    const result = proxy({
      transactions: [txn({ amount: '120.00', standardCategory: 'operating_expense', categoryAccountId: 'acct-opex' })],
    });
    expect(result.totalExpenses).toBe('0.00');
    expect(result.components.inflows_in_expense_categories).toBe('120.00');
  });
});

describe('card_spend_unclassified (§4.4 last sentence, ADR-047.12)', () => {
  const cardRepaymentFromCurrent = txn({
    bankAccountId: CURRENT.id,
    amount: '-1200.00',
    standardCategory: 'credit_card',
    categoryAccountId: 'acct-credit_card',
  });

  it('is set when a cash-like account shows credit_card outflows and NO card statement covers P', () => {
    const result = proxy({ transactions: [cardRepaymentFromCurrent], cardStatementCoversPeriod: false });
    expect(result.warnings).toContain('card_spend_unclassified');
  });

  it('is NOT set when a card statement covers P', () => {
    const result = proxy({ transactions: [cardRepaymentFromCurrent], cardStatementCoversPeriod: true });
    expect(result.warnings).not.toContain('card_spend_unclassified');
  });

  it('is NOT set when there are no credit_card outflows from a cash-like account', () => {
    const result = proxy({
      transactions: [txn({ bankAccountId: CURRENT.id, amount: '-500.00', standardCategory: 'marketing', categoryAccountId: 'acct-marketing' })],
      cardStatementCoversPeriod: false,
    });
    expect(result.warnings).not.toContain('card_spend_unclassified');
  });

  it('is NOT set by a credit_card INFLOW on a cash-like account', () => {
    // Money coming back off a card is a refund, not evidence of unseen spend.
    expect(hasUnclassifiedCardSpend({
      transactions: [txn({ bankAccountId: CURRENT.id, amount: '1200.00', standardCategory: 'credit_card', categoryAccountId: 'acct-credit_card' })],
      bankAccounts: ACCOUNTS,
      cardStatementCoversPeriod: false,
    })).toBe(false);
  });

  it('is NOT set by a credit_card outflow on the CARD account itself', () => {
    // A row on the card statement is exactly the spend we can see; it proves nothing is missing.
    expect(hasUnclassifiedCardSpend({
      transactions: [txn({ bankAccountId: CARD.id, amount: '-250.00', standardCategory: 'credit_card', categoryAccountId: 'acct-credit_card' })],
      bankAccounts: ACCOUNTS,
      cardStatementCoversPeriod: false,
    })).toBe(false);
  });

  it('is set from a SAVINGS account too, since savings is cash-like', () => {
    expect(hasUnclassifiedCardSpend({
      transactions: [txn({ bankAccountId: SAVINGS.id, amount: '-1200.00', standardCategory: 'credit_card', categoryAccountId: 'acct-credit_card' })],
      bankAccounts: ACCOUNTS,
      cardStatementCoversPeriod: false,
    })).toBe(true);
  });
});

describe('VAT netting (§2.3, ADR-027.4, CD-33)', () => {
  const VAT: ProxyVatSettings = {
    vatRegistered: true,
    defaultVatRate: '0.20',
    taxableCategories: ['revenue', 'cost_of_sales', 'operating_expense', 'marketing'],
  };

  it('divides by (1 + rate) rather than multiplying by (1 − rate)', () => {
    expect(netOfVat(new Decimal('120.00'), new Decimal('0.20')).toFixed(2)).toBe('100.00');
  });

  it('refuses to divide by zero if a rate of −1 is ever configured', () => {
    expect(netOfVat(new Decimal('120.00'), new Decimal('-1')).toFixed(2)).toBe('120.00');
  });

  it('nets revenue down when the organization is VAT-registered', () => {
    const result = proxy({
      transactions: [txn({ amount: '1200.00', standardCategory: 'revenue', categoryAccountId: 'acct-revenue' })],
      vat: VAT,
    });
    expect(result.revenue).toBe('1000.00');
  });

  it('nets only the categories in taxable_categories', () => {
    const result = proxy({
      transactions: [
        txn({ amount: '-1200.00', standardCategory: 'marketing', categoryAccountId: 'acct-marketing' }),
        txn({ amount: '-1200.00', standardCategory: 'payroll', categoryAccountId: 'acct-payroll' }),
      ],
      vat: VAT,
    });
    expect(result.expensesByCategory).toEqual([
      { category: 'marketing', amount: '1000.00' },   // taxable
      { category: 'payroll', amount: '1200.00' },     // payroll carries no VAT
    ]);
  });

  it('records components.vat_rate_applied', () => {
    const result = proxy({ transactions: [txn()], vat: VAT });
    expect(result.components.vat_rate_applied).toBe('0.200000');
    expect(result.components.taxable_categories).toEqual(['cost_of_sales', 'marketing', 'operating_expense', 'revenue']);
  });

  it('nets nothing when the organization is not registered', () => {
    const result = proxy({
      transactions: [txn({ amount: '1200.00', standardCategory: 'revenue', categoryAccountId: 'acct-revenue' })],
      vat: NO_VAT,
    });
    expect(result.revenue).toBe('1200.00');
    expect(result.components.vat_rate_applied).toBeNull();
  });

  it('nets nothing when registered but no default rate is configured', () => {
    const result = proxy({
      transactions: [txn({ amount: '1200.00', standardCategory: 'revenue', categoryAccountId: 'acct-revenue' })],
      vat: { ...VAT, defaultVatRate: null },
    });
    expect(result.revenue).toBe('1200.00');
  });

  it('stays estimated after netting — a single default rate is itself an estimate', () => {
    const result = proxy({ transactions: [txn()], vat: VAT });
    expect(result.assurance).toBe('estimated');
    expect(result.warnings).toContain('vat_inclusive');
  });
});

describe('completeness and the uncategorised thresholds (§5, §3.1)', () => {
  it('is 1 when everything in scope is categorised', () => {
    const result = proxy({ transactions: [txn(), txn({ amount: '-200.00' })] });
    expect(result.completeness).toBe(1);
    expect(result.warnings).not.toContain('uncategorised_amounts');
  });

  it('measures the uncategorised share over the rows that survived the transfer filter', () => {
    // A transfer nobody categorised is not a hole in the P&L.
    const result = proxy({
      transactions: [
        txn({ amount: '-900.00' }),
        txn({ amount: '-5000.00', isTransfer: true, transferKind: 'cash_transfer', standardCategory: null, categoryAccountId: null }),
      ],
    });
    expect(result.completeness).toBe(1);
    expect(result.uncategorisedAmount).toBe('0.00');
  });

  it('warns above 5% uncategorised', () => {
    const result = proxy({
      transactions: [
        txn({ amount: '-900.00' }),
        txn({ amount: '-100.00', standardCategory: null, categoryAccountId: null }),
      ],
    });
    expect(result.uncategorisedShare).toBe('0.100000');
    expect(result.warnings).toContain('uncategorised_amounts');
    expect(result.missing).toHaveLength(0);
    expect(UNCATEGORISED_WARNING_THRESHOLD).toBe('0.05');
  });

  it('records the missing reason above 25% uncategorised, and still writes the value', () => {
    const result = proxy({
      transactions: [
        txn({ amount: '-600.00' }),
        txn({ amount: '-400.00', standardCategory: null, categoryAccountId: null }),
      ],
    });
    expect(result.missing).toEqual(['uncategorised_amounts_exceed_threshold']);
    expect(result.totalExpenses).toBe('600.00');
    expect(UNCATEGORISED_MISSING_THRESHOLD).toBe('0.25');
  });

  it('reports an empty period as complete rather than as missing data (§1.5)', () => {
    const result = proxy({ transactions: [] });
    expect(result.completeness).toBe(1);
    expect(result.revenue).toBe('0.00');
    expect(result.totalExpenses).toBe('0.00');
  });

  it('keeps an uncategorised amount out of every figure while counting it for completeness', () => {
    const result = proxy({
      transactions: [txn({ amount: '-400.00', standardCategory: null, categoryAccountId: null })],
    });
    expect(result.totalExpenses).toBe('0.00');
    expect(result.uncategorisedAmount).toBe('400.00');
    expect(result.completeness).toBe(0);
  });

  it('ignores a zero-amount row, which is in neither direction (§3.3)', () => {
    const result = proxy({ transactions: [txn({ amount: '0.00' })] });
    expect(result.totalExpenses).toBe('0.00');
  });
});

describe('determinism', () => {
  const transactions: ProxyTransaction[] = [
    txn({ amount: '2400.00', standardCategory: 'revenue', categoryAccountId: 'acct-revenue' }),
    txn({ amount: '-1500.00', standardCategory: 'operating_expense', categoryAccountId: 'acct-opex' }),
    txn({ bankAccountId: CARD.id, amount: '-250.00', standardCategory: 'marketing', categoryAccountId: 'acct-marketing' }),
    txn({ amount: '-1200.00', isTransfer: true, transferKind: 'card_repayment', standardCategory: 'credit_card', categoryAccountId: 'acct-credit_card' }),
    txn({ amount: '-90.00', standardCategory: null, categoryAccountId: null }),
    txn({ bankAccountId: LOAN.id, amount: '620.00', standardCategory: 'loan', categoryAccountId: 'acct-loan' }),
  ];

  function rotate<T>(items: readonly T[], by: number): T[] {
    return [...items.slice(by), ...items.slice(0, by)];
  }

  it('produces an identical result under every rotation and under reversal', () => {
    const expected = proxy({ transactions });
    for (let by = 0; by < transactions.length; by += 1) {
      expect(proxy({ transactions: rotate(transactions, by) })).toEqual(expected);
    }
    expect(proxy({ transactions: [...transactions].reverse() })).toEqual(expected);
  });

  it('produces an identical result when the account list is reordered', () => {
    const expected = proxy({ transactions });
    expect(proxy({ transactions, bankAccounts: [...ACCOUNTS].reverse() })).toEqual(expected);
  });
});
