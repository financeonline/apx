import { describe, expect, it } from 'vitest';

import {
  SYNONYM_TABLE, TARGET_FIELDS, headerSignature, isKnownHeader, normalizeHeader, suggestColumns,
} from '../../src/modules/imports/domain/mapping/synonyms';
import {
  CATEGORY_KEYWORDS, normalizeAccountName, resolveAccountCategory, suggestCategory,
  suggestSupplierExpenseCategory, type ExistingAccount,
} from '../../src/modules/imports/domain/mapping/category-keywords';
import {
  counterpartyKindFor, findFigureInName, nameCarriesFigure, nameFigureIssue, normalizedName,
  upgradeCounterpartyKind,
} from '../../src/modules/imports/domain/mapping/counterparty';

/**
 * IMPORT_ENGINE.md §6.2, §6.3, §6.5 and §6.6.
 *
 * These are imported by their file paths rather than through `@/modules/imports` because the module
 * barrel is owned by another part of Phase 5; the suite moves to the barrel when it re-exports
 * `domain/mapping`.
 */

describe('header normalisation and the synonyms table (§6.2)', () => {
  it('lowercases, strips punctuation and collapses spaces', () => {
    expect(normalizeHeader('  Paid   Out (£) ')).toBe('paid out');
    expect(normalizeHeader('Money-In')).toBe('money in');
    expect(normalizeHeader('Inv #')).toBe('inv');
    expect(normalizeHeader('')).toBe('');
  });

  it('never lists the same source header twice', () => {
    const seen = new Set<string>();
    const repeated: string[] = [];
    for (const entry of SYNONYM_TABLE) {
      for (const header of entry.headers) {
        const key = normalizeHeader(header);
        if (seen.has(key)) repeated.push(key);
        seen.add(key);
      }
    }
    expect(repeated).toEqual([]);
  });

  it('only ever suggests declared target fields', () => {
    const fields = new Set<string>(TARGET_FIELDS);
    for (const entry of SYNONYM_TABLE) {
      for (const target of entry.targets) expect(fields.has(target)).toBe(true);
    }
  });
});

describe('isKnownHeader — the header-row detector the parsers inject (§5.1, §6.2)', () => {
  it('recognises every spelling the document lists', () => {
    for (const header of [
      'Date', 'Transaction Date', 'Description', 'Narrative', 'Amount', 'Paid Out', 'Paid In',
      'Debit', 'Credit', 'Balance', 'Account', 'Nominal Code', 'Invoice No', 'Customer', 'Supplier',
      'Due Date',
    ]) {
      expect(isKnownHeader(header)).toBe(true);
    }
  });

  it('ignores a currency qualifier on a money column', () => {
    expect(isKnownHeader('Amount (GBP)')).toBe(true);
    expect(isKnownHeader('Paid out in USD')).toBe(true);
    // "out" is not a currency code, so the column keeps its meaning.
    expect(isKnownHeader('Money out')).toBe(true);
  });

  it('refuses a preamble line, so "Account Name,Acme Ltd" cannot become the header', () => {
    expect(isKnownHeader('Account Name')).toBe(true);
    expect(isKnownHeader('Acme Ltd')).toBe(false);
    expect(isKnownHeader('Statement of account for the year ended 31 March')).toBe(false);
    expect(isKnownHeader('')).toBe(false);
    expect(isKnownHeader('   ')).toBe(false);
  });
});

describe('suggestColumns (§6.2)', () => {
  it('maps a G1 bank layout', () => {
    expect(suggestColumns(['Date', 'Description', 'Paid out', 'Paid in', 'Balance'], 'bank_statement'))
      .toEqual([
        { sourceColumn: 'Date', target: 'transaction_date', confidence: 'synonym' },
        { sourceColumn: 'Description', target: 'description', confidence: 'exact' },
        { sourceColumn: 'Paid out', target: 'money_out', confidence: 'synonym' },
        { sourceColumn: 'Paid in', target: 'money_in', confidence: 'synonym' },
        { sourceColumn: 'Balance', target: 'balance_after', confidence: 'synonym' },
      ]);
  });

  it('reads the same headers differently for a general ledger', () => {
    const suggestions = suggestColumns(['Date', 'Account', 'Debit', 'Credit'], 'general_ledger');
    expect(suggestions.map((s) => s.target)).toEqual(['entry_date', 'account', 'debit', 'credit']);
  });

  it('re-targets a bank statement that labels its columns Debit and Credit', () => {
    const suggestions = suggestColumns(['Date', 'Details', 'Debit', 'Credit'], 'bank_statement');
    expect(suggestions.map((s) => s.target)).toEqual([
      'transaction_date', 'description', 'money_out', 'money_in',
    ]);
  });

  it('gives "Payee" to the description when nothing else can be one', () => {
    expect(suggestColumns(['Date', 'Payee', 'Amount'])[1]).toEqual({
      sourceColumn: 'Payee', target: 'description', confidence: 'synonym',
    });
  });

  it('moves "Payee" to the counterparty once a description column exists', () => {
    const suggestions = suggestColumns(['Date', 'Description', 'Payee', 'Amount']);
    expect(suggestions.map((s) => s.target)).toEqual([
      'transaction_date', 'description', 'counterparty', 'amount',
    ]);
    expect(suggestions[2]?.confidence).toBe('weak');
  });

  it('gives "Reference" to the invoice number only when there is no invoice column', () => {
    expect(suggestColumns(['Reference', 'Customer', 'Total'], 'sales_invoices').map((s) => s.target))
      .toEqual(['reference', 'customer', 'total_amount']);
    expect(
      suggestColumns(['Invoice No', 'Reference', 'Customer'], 'sales_invoices').map((s) => s.target),
    ).toEqual(['invoice_number', 'reference', 'customer']);
  });

  it('maps a purchase list onto the supplier', () => {
    expect(suggestColumns(['Contact', 'Invoice number'], 'purchase_invoices').map((s) => s.target))
      .toEqual(['supplier', 'invoice_number']);
  });

  it('never gives two columns the same target', () => {
    const suggestions = suggestColumns(['Amount', 'Amount']);
    expect(suggestions.map((s) => s.target)).toEqual(['amount', 'total_amount']);
    expect(suggestions[1]?.confidence).toBe('weak');
  });

  it('matches a header that carries extra words, weakly', () => {
    expect(suggestColumns(['Customer name (billing)'])).toEqual([
      { sourceColumn: 'Customer name (billing)', target: 'customer', confidence: 'weak' },
    ]);
  });

  it('leaves an unrecognised column unmapped, to be kept in raw_data', () => {
    expect(suggestColumns(['Widget colour'])).toEqual([]);
  });
});

describe('headerSignature (§6.3)', () => {
  it('is the sha256 of the normalised headers joined by "|"', () => {
    expect(headerSignature(['Date', 'Description', 'Amount']))
      .toBe('9bf87c920b3d1899e3a2409f3fafaf3678bf3c2900e8ad4e2ec5f794a8d9be85');
  });

  it('ignores case and punctuation but not order', () => {
    expect(headerSignature(['DATE', ' description ', 'Amount!'])).toBe(headerSignature(['Date', 'Description', 'Amount']));
    expect(headerSignature(['Amount', 'Date', 'Description'])).not.toBe(headerSignature(['Date', 'Description', 'Amount']));
  });
});

describe('keyword suggestions (§6.5)', () => {
  it('maps every keyword in the table to the category the table gives it', () => {
    for (const rule of CATEGORY_KEYWORDS) {
      expect(suggestCategory(rule.keyword).category).toBe(rule.category);
    }
  });

  it('reads "income" as revenue but "other income" as other_income', () => {
    expect(suggestCategory('Income').category).toBe('revenue');
    expect(suggestCategory('Sales income').category).toBe('revenue');
    expect(suggestCategory('Other income').category).toBe('other_income');
    expect(suggestCategory('4900 Other Income').category).toBe('other_income');
    expect(suggestCategory('Sundry income').category).toBe('other_income');
  });

  it('prefers the longer keyword, so the table\'s specific rows win', () => {
    expect(suggestCategory('Bank charges').category).toBe('interest_expense');
    expect(suggestCategory('Bank current account').category).toBe('cash');
    expect(suggestCategory('Income tax').category).toBe('tax_expense');
    expect(suggestCategory('Sales tax').category).toBe('tax_liability');
    expect(suggestCategory("Director's loan").category).toBe('loan');
    expect(suggestCategory('Loan interest').category).toBe('interest_expense');
  });

  it('matches whole tokens only', () => {
    expect(suggestCategory('Insurance').category).toBe('operating_expense');
    expect(suggestCategory('Winsales Trading').category).toBe('uncategorised');
    expect(suggestCategory('Widget handling').category).toBe('uncategorised');
    expect(suggestCategory('').category).toBe('uncategorised');
  });

  it('reports how firm the suggestion is', () => {
    expect(suggestCategory('Sales')).toMatchObject({ confidence: 'exact', matchedKeyword: 'sales' });
    expect(suggestCategory('Cost of sales')).toMatchObject({ confidence: 'exact' });
    expect(suggestCategory('7100 Bank charges')).toMatchObject({ confidence: 'strong' });
    expect(suggestCategory('4000 Sales')).toMatchObject({ confidence: 'weak' });
    expect(suggestCategory('Widget')).toMatchObject({ confidence: 'none', matchedKeyword: null });
  });
});

describe('the account resolution order (§6.5)', () => {
  const accounts: readonly ExistingAccount[] = [
    { code: '4000', name: 'Sales Revenue', standardCategory: 'revenue' },
    { code: '7100', name: 'Rent', standardCategory: 'operating_expense' },
    { code: null, name: 'Sundry', standardCategory: 'other_expense' },
  ];

  it('takes an exact account code first, even when the name suggests otherwise', () => {
    expect(resolveAccountCategory({ value: 'Marketing spend', code: '7100', accounts })).toMatchObject({
      category: 'operating_expense', source: 'account_code', confidence: 'exact',
    });
  });

  it('falls to an exact normalized_name match', () => {
    expect(resolveAccountCategory({ value: 'sales   revenue', accounts })).toMatchObject({
      category: 'revenue', source: 'account_name',
    });
  });

  it('then the saved account_map', () => {
    expect(
      resolveAccountCategory({
        value: 'Widget handling',
        accounts,
        savedCategories: { 'widget handling': 'cost_of_sales' },
      }),
    ).toMatchObject({ category: 'cost_of_sales', source: 'account_map' });
  });

  it('then a keyword suggestion', () => {
    expect(resolveAccountCategory({ value: '6000 Advertising', accounts })).toMatchObject({
      category: 'marketing', source: 'keyword', matchedKeyword: 'advertising',
    });
  });

  it('else uncategorised, which is allowed but warned about (IMP-ACCT-005)', () => {
    expect(resolveAccountCategory({ value: 'Widget handling', accounts })).toMatchObject({
      category: 'uncategorised', source: 'uncategorised', confidence: 'none',
    });
  });

  it('normalises account names without stripping company suffixes', () => {
    expect(normalizeAccountName('  4000 — Sales/Revenue ')).toBe('4000 sales revenue');
    expect(normalizeAccountName('Loans Ltd')).toBe('loans ltd');
  });
});

describe("a supplier's default expense category (§6.5, ADR-027.4)", () => {
  it('uses the keyword table when it names an expense', () => {
    expect(suggestSupplierExpenseCategory('Acme Marketing Ltd').category).toBe('marketing');
    expect(suggestSupplierExpenseCategory('City Insurance Brokers').category).toBe('operating_expense');
  });

  it('falls back to cost_of_sales, and never to a non-expense category', () => {
    expect(suggestSupplierExpenseCategory('Sales Force Ltd').category).toBe('cost_of_sales');
    expect(suggestSupplierExpenseCategory('Barclays Bank plc').category).toBe('cost_of_sales');
    expect(suggestSupplierExpenseCategory('Widget Supplies').category).toBe('cost_of_sales');
  });
});

describe('counterparty normalisation (§6.6)', () => {
  it('lowercases, strips punctuation, collapses whitespace and removes company suffixes', () => {
    expect(normalizedName('Acme Holdings Ltd.')).toBe('acme holdings');
    expect(normalizedName('  ACME  &  Co. Limited ')).toBe('acme co');
    expect(normalizedName('Acme PLC')).toBe('acme');
    expect(normalizedName('Acme LLP')).toBe('acme');
    expect(normalizedName('Acme Inc')).toBe('acme');
  });

  it('matches the same company written two ways', () => {
    expect(normalizedName('Acme Ltd')).toBe(normalizedName('ACME LIMITED'));
  });

  it('keeps a name that is only a suffix', () => {
    expect(normalizedName('Ltd')).toBe('ltd');
    expect(normalizedName('   ')).toBe('');
  });

  it('takes the kind from the import type and upgrades to both', () => {
    expect(counterpartyKindFor('sales_invoices')).toBe('customer');
    expect(counterpartyKindFor('purchase_report')).toBe('supplier');
    expect(counterpartyKindFor('general_ledger')).toBe('unknown');
    expect(counterpartyKindFor('bank_statement')).toBe('unknown');
    expect(upgradeCounterpartyKind('customer', 'supplier')).toBe('both');
    expect(upgradeCounterpartyKind('customer', 'customer')).toBe('customer');
    expect(upgradeCounterpartyKind('unknown', 'supplier')).toBe('supplier');
    expect(upgradeCounterpartyKind('supplier', 'unknown')).toBe('supplier');
    expect(upgradeCounterpartyKind('both', 'customer')).toBe('both');
  });
});

describe('IMP-NAME-015 — names may not carry figures (§6.6, ADR-045.3, R2-C-05)', () => {
  it('rejects the two names fixture 25 contains', () => {
    expect(nameCarriesFigure('Acme Ltd (owed £45,000)')).toBe(true);
    expect(nameCarriesFigure('Beta 12% Ltd')).toBe(true);
  });

  it('rejects every currency mark', () => {
    for (const name of [
      'Acme £45,000', 'Acme $500 Ltd', 'Acme €1.200 Ltd', 'Acme ¥900', 'Acme 500$',
      'Acme GBP 45,000', 'Acme 45000 USD', 'Delta EUR1.50',
    ]) {
      expect(nameCarriesFigure(name), name).toBe(true);
    }
  });

  it('rejects a money-shaped number with no mark at all', () => {
    expect(nameCarriesFigure('Acme 45,000.00 Ltd')).toBe(true);
    expect(nameCarriesFigure('Acme 45.000,00 Ltd')).toBe(true);
    expect(nameCarriesFigure('Acme 1,234 Ltd')).toBe(true);
  });

  it('rejects every spelling of a percentage', () => {
    for (const name of ['Beta 12% Ltd', 'Beta 12 % Ltd', 'Beta 12.5% Ltd', 'Beta 12 percent Ltd', 'Beta 12 per cent Ltd']) {
      expect(nameCarriesFigure(name), name).toBe(true);
    }
  });

  it('sees through the normalisation the claim grammar applies first', () => {
    expect(nameCarriesFigure('Acme £ 45,000')).toBe(true);
    expect(nameCarriesFigure('Beta −12%')).toBe(true);
  });

  it('allows digits on their own', () => {
    for (const name of [
      '3M', '7-Eleven', 'Studio 54', 'Route 66 Ltd', 'Acme Ltd', '24/7 Logistics', 'Unit 4 Trading',
      'TOP 10 LTD', 'Acme 2026 Ltd',
    ]) {
      expect(nameCarriesFigure(name), name).toBe(false);
    }
  });

  it('reports the figure it found, and raises the error the document specifies', () => {
    expect(findFigureInName('Acme Ltd (owed £45,000)')).toEqual({
      kind: 'currency_amount', matched: '£45,000',
    });
    expect(findFigureInName('Beta 12% Ltd')).toEqual({ kind: 'percentage', matched: '12%' });
    expect(findFigureInName('3M')).toBeNull();

    const issue = nameFigureIssue('Acme Ltd (owed £45,000)', 'customer');
    expect(issue).toMatchObject({
      code: 'IMP-NAME-015',
      severity: 'error',
      field: 'customer',
      message: 'Names cannot contain amounts; edit the name or map to an existing customer',
    });
    expect(nameFigureIssue('3M', 'customer')).toBeNull();
  });
});
