import { describe, expect, it } from 'vitest';

import {
  KEYWORD_RULES,
  KEYWORD_RULE_SET_VERSION,
  categoriseTransaction,
  categoriseTransactions,
  descriptionSignature,
  matchKeywordRule,
  uncategorisedShare,
  type CategorisableTransaction,
  type CategoryAccountRef,
  type OrganizationCategoryRule,
} from '@/modules/banking';
import { STANDARD_CATEGORIES } from '@/modules/financials';

/**
 * Categorisation precedence (FINANCIAL_ENGINE.md §4.1).
 *
 * Two failure modes matter. A rule overwriting a person's decision destroys work silently and
 * repeats the destruction on every run. A rule that never fires leaves the bank-basis P&L empty and
 * reports a trading month as £0 of expenses. Every test below pins one side or the other.
 */

const ACCOUNTS: readonly CategoryAccountRef[] = STANDARD_CATEGORIES.map((category) => ({
  id: `acct-${category}`,
  standardCategory: category,
}));

function transaction(over: Partial<CategorisableTransaction> = {}): CategorisableTransaction {
  return {
    id: 'txn-1',
    amount: '-100.00',
    descriptionNormalized: 'something',
    counterpartyId: null,
    categoryAccountId: null,
    categorySource: 'none',
    ...over,
  };
}

const base = { organizationRules: [] as OrganizationCategoryRule[], categoryAccounts: ACCOUNTS };

describe('the keyword rule set is versioned (§4.1 point 3)', () => {
  it('exports a version, because changing the set re-categorises history on the next run', () => {
    expect(KEYWORD_RULE_SET_VERSION).toBe('banking.keywords.v1');
  });

  it('records the version on outcomes it produced, and only on those', () => {
    const keyword = categoriseTransaction(
      transaction({ descriptionNormalized: 'MONTHLY PAYROLL BACS' }),
      base,
    );
    expect(keyword.keywordRuleSetVersion).toBe(KEYWORD_RULE_SET_VERSION);
    const none = categoriseTransaction(transaction({ descriptionNormalized: 'zzz' }), base);
    expect(none.keywordRuleSetVersion).toBeNull();
  });

  it('gives every rule a unique id, so an outcome names exactly one rule', () => {
    const ids = KEYWORD_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses no global regex, which would carry lastIndex between calls', () => {
    for (const rule of KEYWORD_RULES) expect(rule.pattern.global).toBe(false);
  });

  it('answers identically when the same rule is tested twice', () => {
    const first = matchKeywordRule('HMRC VAT RETURN', 'outflow');
    const second = matchKeywordRule('HMRC VAT RETURN', 'outflow');
    expect(second?.id).toBe(first?.id);
  });
});

describe('a user override is absolute (§4.1 point 1)', () => {
  it('survives a keyword rule that would have changed it', () => {
    // "MONTHLY PAYROLL" fires the payroll rule. The user has said this is marketing.
    const result = categoriseTransaction(
      transaction({
        descriptionNormalized: 'MONTHLY PAYROLL BACS',
        categoryAccountId: 'acct-marketing',
        categorySource: 'user',
      }),
      base,
    );
    expect(result.stage).toBe('user');
    expect(result.categoryAccountId).toBe('acct-marketing');
    expect(result.standardCategory).toBe('marketing');
    expect(result.categorySource).toBe('user');
  });

  it('survives a saved organization rule that would have changed it', () => {
    const result = categoriseTransaction(
      transaction({
        descriptionNormalized: 'ACME LTD',
        counterpartyId: 'cp-acme',
        categoryAccountId: 'acct-cost_of_sales',
        categorySource: 'user',
      }),
      {
        ...base,
        organizationRules: [
          { id: 'rule-1', descriptionSignature: null, counterpartyId: 'cp-acme', categoryAccountId: 'acct-operating_expense' },
        ],
      },
    );
    expect(result.categoryAccountId).toBe('acct-cost_of_sales');
  });

  it('survives an AI suggestion that would have changed it', () => {
    const result = categoriseTransaction(
      transaction({ categoryAccountId: 'acct-payroll', categorySource: 'user' }),
      { ...base, aiSuggestions: [{ transactionId: 'txn-1', categoryAccountId: 'acct-marketing' }] },
    );
    expect(result.categoryAccountId).toBe('acct-payroll');
  });

  it('reports a null standard category when the override names an account outside the chart', () => {
    // A remapped or deleted account must not make the whole outcome collapse.
    const result = categoriseTransaction(
      transaction({ categoryAccountId: 'acct-gone', categorySource: 'user' }),
      base,
    );
    expect(result.categoryAccountId).toBe('acct-gone');
    expect(result.standardCategory).toBeNull();
  });

  it('keeps a DELIBERATELY CLEARED category cleared', () => {
    // "The user said none" is a decision, not a gap. Refilling it would overwrite judgement.
    const result = categoriseTransaction(
      transaction({
        descriptionNormalized: 'MONTHLY PAYROLL BACS',
        categoryAccountId: null,
        categorySource: 'user',
      }),
      base,
    );
    expect(result.categoryAccountId).toBeNull();
    expect(result.stage).toBe('user');
  });
});

describe('a saved organization rule beats the keyword set (§4.1 point 2)', () => {
  it('matches on the normalised description signature', () => {
    const signature = descriptionSignature('DD ACME LTD REF 4471 12MAR');
    const result = categoriseTransaction(
      transaction({ descriptionNormalized: 'DD ACME LTD REF 5522 12APR' }),
      {
        ...base,
        organizationRules: [
          { id: 'rule-1', descriptionSignature: signature, counterpartyId: null, categoryAccountId: 'acct-cost_of_sales' },
        ],
      },
    );
    expect(result.stage).toBe('organization_rule');
    expect(result.categoryAccountId).toBe('acct-cost_of_sales');
    expect(result.categorySource).toBe('rule');
    expect(result.ruleId).toBe('rule-1');
  });

  it('matches on the counterparty', () => {
    const result = categoriseTransaction(
      transaction({ counterpartyId: 'cp-acme', descriptionNormalized: 'anything at all' }),
      {
        ...base,
        organizationRules: [
          { id: 'rule-1', descriptionSignature: null, counterpartyId: 'cp-acme', categoryAccountId: 'acct-marketing' },
        ],
      },
    );
    expect(result.standardCategory).toBe('marketing');
  });

  it('requires BOTH keys when a rule carries both', () => {
    const rules: OrganizationCategoryRule[] = [
      { id: 'rule-1', descriptionSignature: 'acme ltd', counterpartyId: 'cp-acme', categoryAccountId: 'acct-marketing' },
    ];
    const wrongCounterparty = categoriseTransaction(
      transaction({ descriptionNormalized: 'ACME LTD', counterpartyId: 'cp-other' }),
      { ...base, organizationRules: rules },
    );
    expect(wrongCounterparty.stage).not.toBe('organization_rule');
    const both = categoriseTransaction(
      transaction({ descriptionNormalized: 'ACME LTD', counterpartyId: 'cp-acme' }),
      { ...base, organizationRules: rules },
    );
    expect(both.stage).toBe('organization_rule');
  });

  it('beats a keyword rule that would also have matched', () => {
    const result = categoriseTransaction(
      transaction({ descriptionNormalized: 'MONTHLY PAYROLL BACS', counterpartyId: 'cp-bureau' }),
      {
        ...base,
        organizationRules: [
          { id: 'rule-1', descriptionSignature: null, counterpartyId: 'cp-bureau', categoryAccountId: 'acct-operating_expense' },
        ],
      },
    );
    expect(result.stage).toBe('organization_rule');
    expect(result.standardCategory).toBe('operating_expense');
  });

  it('ignores a rule whose signature key is an empty string', () => {
    // An empty signature would match every transaction whose description reduces to nothing.
    const result = categoriseTransaction(
      transaction({ descriptionNormalized: 'zzz qqq' }),
      {
        ...base,
        organizationRules: [
          { id: 'rule-1', descriptionSignature: '', counterpartyId: null, categoryAccountId: 'acct-marketing' },
        ],
      },
    );
    expect(result.stage).toBe('none');
  });

  it('does not match when the signature differs but the counterparty is right', () => {
    const result = categoriseTransaction(
      transaction({ descriptionNormalized: 'BETA LTD', counterpartyId: 'cp-acme' }),
      {
        ...base,
        organizationRules: [
          { id: 'rule-1', descriptionSignature: 'acme ltd', counterpartyId: 'cp-acme', categoryAccountId: 'acct-marketing' },
        ],
      },
    );
    expect(result.stage).not.toBe('organization_rule');
  });

  it('resolves two matching rules by the lowest id, so the answer never depends on load order', () => {
    const rules: OrganizationCategoryRule[] = [
      { id: 'rule-b', descriptionSignature: null, counterpartyId: 'cp-acme', categoryAccountId: 'acct-marketing' },
      { id: 'rule-a', descriptionSignature: null, counterpartyId: 'cp-acme', categoryAccountId: 'acct-payroll' },
    ];
    const forwards = categoriseTransaction(transaction({ counterpartyId: 'cp-acme' }), { ...base, organizationRules: rules });
    const backwards = categoriseTransaction(transaction({ counterpartyId: 'cp-acme' }), { ...base, organizationRules: [...rules].reverse() });
    expect(forwards.ruleId).toBe('rule-a');
    expect(backwards.ruleId).toBe('rule-a');
  });
});

describe('the keyword rule set (§4.1 point 3)', () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    // The four examples named in the document itself.
    ['MONTHLY PAYROLL BACS', '-8400.00', 'payroll'],
    ['SALARY J SMITH', '-2100.00', 'payroll'],
    ['HMRC PAYE MONTH 4', '-3200.00', 'payroll'],
    ['STRIPE PAYOUT', '2400.00', 'revenue'],
    ['SHOPIFY PAYOUT MAR', '1800.00', 'revenue'],
    ['INVOICE 1042 ACME LTD', '950.00', 'revenue'],
    ['HMRC VAT RETURN Q1', '-4100.00', 'tax_liability'],
    ['LOAN REPAYMENT FUNDING', '-620.00', 'loan'],
    // The rest of the UK-oriented set.
    ['HMRC CORPORATION TAX', '-9000.00', 'tax_liability'],
    ['HMRC CUMBERNAULD', '-500.00', 'tax_liability'],
    ['NEST PENSIONS DD', '-410.00', 'payroll'],
    ['CREDIT CARD PAYMENT', '-1200.00', 'credit_card'],
    ['BARCLAYCARD', '-300.00', 'credit_card'],
    ['RENT MARCH UNIT 4', '-1500.00', 'operating_expense'],
    ['HISCOX INSURANCE DD', '-88.00', 'operating_expense'],
    ['BRITISH GAS BUSINESS', '-240.00', 'operating_expense'],
    ['VODAFONE LTD', '-45.00', 'operating_expense'],
    ['BANK CHARGES', '-12.00', 'operating_expense'],
    ['GOOGLE ADS', '-800.00', 'marketing'],
    ['MAILCHIMP', '-59.00', 'marketing'],
    ['INTEREST CHARGED', '-31.00', 'interest_expense'],
    ['DRAWINGS', '-2000.00', 'drawings'],
  ];

  for (const [description, amount, category] of cases) {
    it(`maps "${description}" to ${category}`, () => {
      const result = categoriseTransaction(transaction({ descriptionNormalized: description, amount }), base);
      expect(result.standardCategory).toBe(category);
      expect(result.categorySource).toBe('rule');
      expect(result.stage).toBe('keyword_rule');
    });
  }

  it('applies the revenue rule to inflows only (the document\'s own direction constraint)', () => {
    const inflow = categoriseTransaction(transaction({ descriptionNormalized: 'STRIPE', amount: '500.00' }), base);
    expect(inflow.standardCategory).toBe('revenue');
    const outflow = categoriseTransaction(transaction({ descriptionNormalized: 'STRIPE', amount: '-500.00' }), base);
    expect(outflow.standardCategory).not.toBe('revenue');
  });

  it('prefers the specific HMRC rules over the catch-all, because order is precedence', () => {
    expect(matchKeywordRule('hmrc paye month 4', 'outflow')?.id).toBe('hmrc_paye');
    expect(matchKeywordRule('hmrc vat return', 'outflow')?.id).toBe('hmrc_vat');
    expect(matchKeywordRule('hmrc payment', 'outflow')?.id).toBe('hmrc_other');
  });

  it('does NOT treat an ordinary card purchase as a card repayment', () => {
    // On a current account "CARD PAYMENT TO ACME" is a purchase. Calling it `credit_card` would
    // move a real expense into a NON_PNL category and understate costs.
    const result = categoriseTransaction(
      transaction({ descriptionNormalized: 'CARD PAYMENT TO ACME LTD', amount: '-64.00' }),
      base,
    );
    expect(result.standardCategory).not.toBe('credit_card');
  });

  it('does NOT categorise a transfer-looking row, because pairing is §4.2\'s job', () => {
    // A keyword rule here would park an UNPAIRED transfer in the NON_PNL `transfer` category and
    // remove a real movement from the figures.
    const result = categoriseTransaction(
      transaction({ descriptionNormalized: 'TRANSFER TO SAVINGS', amount: '-5000.00' }),
      base,
    );
    expect(result.standardCategory).toBeNull();
    expect(result.stage).toBe('none');
  });

  it('falls through to none when the organization has no account for the rule\'s category', () => {
    const result = categoriseTransaction(
      transaction({ descriptionNormalized: 'MONTHLY PAYROLL' }),
      { ...base, categoryAccounts: [{ id: 'acct-revenue', standardCategory: 'revenue' }] },
    );
    expect(result.stage).toBe('none');
    expect(result.categoryAccountId).toBeNull();
  });

  it('never touches assurance_level — categorisation sets category_source only (§4.1 note)', () => {
    // The self-correction in §4.1 point 3 is authoritative: a keyword rule may not downgrade a
    // reconciled statement line to `inferred`.
    const result = categoriseTransaction(transaction({ descriptionNormalized: 'MONTHLY PAYROLL' }), base);
    expect(Object.keys(result)).not.toContain('assuranceLevel');
    expect(Object.keys(result)).not.toContain('assurance');
  });
});

describe('an AI suggestion stays a suggestion (§4.1 point 4)', () => {
  it('applies only when nothing above it matched', () => {
    const result = categoriseTransaction(
      transaction({ descriptionNormalized: 'unknown payee' }),
      { ...base, aiSuggestions: [{ transactionId: 'txn-1', categoryAccountId: 'acct-marketing' }] },
    );
    expect(result.stage).toBe('ai_suggestion');
    expect(result.categorySource).toBe('ai_suggested');
    expect(result.standardCategory).toBe('marketing');
  });

  it('loses to a keyword rule', () => {
    const result = categoriseTransaction(
      transaction({ descriptionNormalized: 'MONTHLY PAYROLL' }),
      { ...base, aiSuggestions: [{ transactionId: 'txn-1', categoryAccountId: 'acct-marketing' }] },
    );
    expect(result.stage).toBe('keyword_rule');
  });
});

describe('nothing matched (§4.1 point 5)', () => {
  it('leaves the category null with source none', () => {
    const result = categoriseTransaction(transaction({ descriptionNormalized: 'zzz qqq' }), base);
    expect(result.categoryAccountId).toBeNull();
    expect(result.standardCategory).toBeNull();
    expect(result.categorySource).toBe('none');
  });

  it('leaves an empty description uncategorised rather than guessing', () => {
    const result = categoriseTransaction(transaction({ descriptionNormalized: null }), base);
    expect(result.stage).toBe('none');
  });
});

describe('the description signature identifies the payee, not the payment', () => {
  it('collapses reference codes and dates that change every month', () => {
    expect(descriptionSignature('DD ACME LTD REF 4471 12MAR'))
      .toBe(descriptionSignature('DD ACME LTD REF 5522 12APR'));
  });

  it('collapses slashed dates', () => {
    expect(descriptionSignature('RENT 01/03/2026')).toBe(descriptionSignature('RENT 01/04/2026'));
  });

  it('keeps different payees apart', () => {
    expect(descriptionSignature('DD ACME LTD')).not.toBe(descriptionSignature('DD BETA LTD'));
  });

  it('is empty for an empty description, so no rule can key on nothing', () => {
    expect(descriptionSignature(null)).toBe('');
    expect(descriptionSignature('12345')).toBe('');
  });
});

describe('uncategorised share drives completeness for bank-basis metrics (§5)', () => {
  it('is the magnitude share, ignoring direction', () => {
    const share = uncategorisedShare([
      { amount: '900.00', categoryAccountId: 'acct-revenue' },
      { amount: '-100.00', categoryAccountId: null },
    ]);
    expect(share.uncategorisedAmount).toBe('100.00');
    expect(share.totalAmount).toBe('1000.00');
    expect(share.share).toBe('0.100000');
    expect(share.completeness).toBeCloseTo(0.9, 10);
  });

  it('is complete when everything is categorised', () => {
    const share = uncategorisedShare([{ amount: '500.00', categoryAccountId: 'acct-revenue' }]);
    expect(share.share).toBe('0.000000');
    expect(share.completeness).toBe(1);
  });

  it('reports an empty set as complete, not as missing data (§1.5)', () => {
    const share = uncategorisedShare([]);
    expect(share.completeness).toBe(1);
    expect(share.totalAmount).toBe('0.00');
  });

  it('is 0 completeness when nothing was categorised at all', () => {
    const share = uncategorisedShare([
      { amount: '-100.00', categoryAccountId: null },
      { amount: '-300.00', categoryAccountId: null },
    ]);
    expect(share.share).toBe('1.000000');
    expect(share.completeness).toBe(0);
  });
});

describe('the chart of accounts index', () => {
  it('takes the lowest id when two accounts carry the same standard category', () => {
    const accounts = [
      { id: 'acct-z', standardCategory: 'payroll' as const },
      { id: 'acct-a', standardCategory: 'payroll' as const },
    ];
    const forwards = categoriseTransaction(
      transaction({ descriptionNormalized: 'MONTHLY PAYROLL' }),
      { ...base, categoryAccounts: accounts },
    );
    const backwards = categoriseTransaction(
      transaction({ descriptionNormalized: 'MONTHLY PAYROLL' }),
      { ...base, categoryAccounts: [...accounts].reverse() },
    );
    expect(forwards.categoryAccountId).toBe('acct-a');
    expect(backwards.categoryAccountId).toBe('acct-a');
  });

  it('tolerates the same account appearing twice', () => {
    const accounts = [
      { id: 'acct-payroll', standardCategory: 'payroll' as const },
      { id: 'acct-payroll', standardCategory: 'payroll' as const },
    ];
    const result = categoriseTransaction(
      transaction({ descriptionNormalized: 'MONTHLY PAYROLL' }),
      { ...base, categoryAccounts: accounts },
    );
    expect(result.categoryAccountId).toBe('acct-payroll');
  });
});

describe('determinism', () => {
  it('gives the same answers whatever order the transactions arrive in', () => {
    const rows: CategorisableTransaction[] = [
      transaction({ id: 'a', descriptionNormalized: 'MONTHLY PAYROLL' }),
      transaction({ id: 'b', descriptionNormalized: 'STRIPE', amount: '500.00' }),
      transaction({ id: 'c', descriptionNormalized: 'GOOGLE ADS' }),
    ];
    const forwards = categoriseTransactions({ ...base, transactions: rows });
    const backwards = categoriseTransactions({ ...base, transactions: [...rows].reverse() });
    const key = (r: { transactionId: string; standardCategory: string | null }) =>
      `${r.transactionId}:${r.standardCategory}`;
    expect([...backwards].map(key).sort()).toEqual([...forwards].map(key).sort());
  });
});
