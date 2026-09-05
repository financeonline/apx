/**
 * Account → standard category mapping (IMPORT_ENGINE.md §6.5; CD-04, ADR-004).
 *
 * §6.5 resolves an account value in this order: exact match on `accounts.code`; exact on
 * `normalized_name`; the saved `account_map`; a keyword suggestion; else `uncategorised`. The first
 * three are lookups against rows the database holds, so they are passed in as arguments — `domain/`
 * has no I/O (ADR-022) and the service layer is where the query lives. The keyword step and the
 * normalisation are pure and live here.
 *
 * Nothing in this file decides anything on its own: §6.5 has the reviewer confirm every account
 * before `accounts.mapping_confidence` becomes `confirmed`. What it must not do is guess quietly in
 * a way nobody sees — an account that matches nothing comes back `uncategorised`, which carries its
 * own warning (`IMP-ACCT-005`) and marks every metric that touches it incomplete.
 */

import { CATEGORY_ACCOUNT_TYPE, type StandardCategory } from '@/modules/financials';

/**
 * The account-name normalisation used for the `accounts.normalized_name` comparison.
 *
 * Deliberately NOT the counterparty normalisation of §6.6: that one strips `ltd`/`limited`/`plc`,
 * which are company suffixes, not account-name noise. "Loans Ltd" and "Loans" are the same supplier
 * but need not be the same nominal account, so account names keep every word they were given.
 */
export function normalizeAccountName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

/** Account codes compare case- and padding-insensitively; "4000 " and "4000" are one account. */
export function normalizeAccountCode(code: string): string {
  return code.trim().toLowerCase();
}

interface KeywordRule {
  readonly keyword: string;
  readonly category: StandardCategory;
}

/**
 * The keyword table of §6.5, in the document's order, plus the spellings the same chart of accounts
 * produces ("amortization", "national insurance", "trade debtors").
 *
 * Matching is by LONGEST keyword, not by table order, which is how the document's parenthetical
 * "income (not 'other')" is honoured: `other income` is a longer match than `income`, so "Other
 * income" resolves to `other_income` and never to `revenue`. The same mechanism keeps "bank
 * charges" out of `cash` and "income tax" out of `revenue`.
 */
export const CATEGORY_KEYWORDS: readonly KeywordRule[] = [
  // revenue — "income (not 'other')"
  { keyword: 'sales', category: 'revenue' },
  { keyword: 'revenue', category: 'revenue' },
  { keyword: 'turnover', category: 'revenue' },
  { keyword: 'fees earned', category: 'revenue' },
  { keyword: 'income', category: 'revenue' },
  { keyword: 'sales income', category: 'revenue' },
  { keyword: 'trading income', category: 'revenue' },

  // other_income — the exclusion the table asks for, expressed as a longer match
  { keyword: 'other income', category: 'other_income' },
  { keyword: 'sundry income', category: 'other_income' },
  { keyword: 'misc income', category: 'other_income' },
  { keyword: 'miscellaneous income', category: 'other_income' },
  { keyword: 'interest received', category: 'other_income' },
  { keyword: 'interest income', category: 'other_income' },

  // cost_of_sales
  { keyword: 'cost of sales', category: 'cost_of_sales' },
  { keyword: 'cost of goods sold', category: 'cost_of_sales' },
  { keyword: 'cogs', category: 'cost_of_sales' },
  { keyword: 'purchases', category: 'cost_of_sales' },
  { keyword: 'materials', category: 'cost_of_sales' },
  { keyword: 'direct costs', category: 'cost_of_sales' },
  { keyword: 'subcontract', category: 'cost_of_sales' },
  { keyword: 'subcontractors', category: 'cost_of_sales' },
  { keyword: 'carriage', category: 'cost_of_sales' },

  // payroll
  { keyword: 'salaries', category: 'payroll' },
  { keyword: 'wages', category: 'payroll' },
  { keyword: 'payroll', category: 'payroll' },
  { keyword: 'paye', category: 'payroll' },
  { keyword: 'pension', category: 'payroll' },
  { keyword: 'ni', category: 'payroll' },
  { keyword: 'national insurance', category: 'payroll' },
  { keyword: 'employers ni', category: 'payroll' },
  { keyword: 'staff costs', category: 'payroll' },

  // marketing
  { keyword: 'marketing', category: 'marketing' },
  { keyword: 'advertising', category: 'marketing' },
  { keyword: 'ads', category: 'marketing' },
  { keyword: 'adwords', category: 'marketing' },
  { keyword: 'google', category: 'marketing' },
  { keyword: 'meta', category: 'marketing' },
  { keyword: 'promotion', category: 'marketing' },

  // operating_expense
  { keyword: 'rent', category: 'operating_expense' },
  { keyword: 'rates', category: 'operating_expense' },
  { keyword: 'utilities', category: 'operating_expense' },
  { keyword: 'insurance', category: 'operating_expense' },
  { keyword: 'software', category: 'operating_expense' },
  { keyword: 'subscriptions', category: 'operating_expense' },
  { keyword: 'subscription', category: 'operating_expense' },
  { keyword: 'travel', category: 'operating_expense' },
  { keyword: 'office', category: 'operating_expense' },
  { keyword: 'telephone', category: 'operating_expense' },
  { keyword: 'postage', category: 'operating_expense' },
  { keyword: 'stationery', category: 'operating_expense' },
  { keyword: 'light and heat', category: 'operating_expense' },
  { keyword: 'professional fees', category: 'operating_expense' },
  { keyword: 'accountancy', category: 'operating_expense' },
  { keyword: 'legal fees', category: 'operating_expense' },
  { keyword: 'repairs', category: 'operating_expense' },

  // interest_expense
  { keyword: 'interest paid', category: 'interest_expense' },
  { keyword: 'loan interest', category: 'interest_expense' },
  { keyword: 'bank charges', category: 'interest_expense' },
  { keyword: 'bank interest paid', category: 'interest_expense' },

  // tax_expense
  { keyword: 'corporation tax', category: 'tax_expense' },
  { keyword: 'income tax', category: 'tax_expense' },

  // depreciation
  { keyword: 'depreciation', category: 'depreciation' },
  { keyword: 'amortisation', category: 'depreciation' },
  { keyword: 'amortization', category: 'depreciation' },

  // cash
  { keyword: 'bank', category: 'cash' },
  { keyword: 'current account', category: 'cash' },
  { keyword: 'cash', category: 'cash' },
  { keyword: 'petty cash', category: 'cash' },
  { keyword: 'cash at bank', category: 'cash' },

  // receivables
  { keyword: 'debtors', category: 'receivables' },
  { keyword: 'trade debtors', category: 'receivables' },
  { keyword: 'receivable', category: 'receivables' },
  { keyword: 'receivables', category: 'receivables' },
  { keyword: 'accounts receivable', category: 'receivables' },

  // payables
  { keyword: 'creditors', category: 'payables' },
  { keyword: 'trade creditors', category: 'payables' },
  { keyword: 'payable', category: 'payables' },
  { keyword: 'payables', category: 'payables' },
  { keyword: 'accounts payable', category: 'payables' },

  // tax_liability
  { keyword: 'vat', category: 'tax_liability' },
  { keyword: 'gst', category: 'tax_liability' },
  { keyword: 'sales tax', category: 'tax_liability' },
  { keyword: 'vat control', category: 'tax_liability' },
  { keyword: 'paye control', category: 'tax_liability' },

  // loan
  { keyword: 'loan', category: 'loan' },
  { keyword: 'directors loan', category: 'loan' },
  { keyword: 'hp', category: 'loan' },
  { keyword: 'hire purchase', category: 'loan' },
  { keyword: 'finance lease', category: 'loan' },

  // credit_card — not in the §6.5 table, but a liability the model already has a category for
  { keyword: 'credit card', category: 'credit_card' },

  // drawings
  { keyword: 'drawings', category: 'drawings' },
  { keyword: 'dividends', category: 'drawings' },

  // transfer
  { keyword: 'transfer', category: 'transfer' },
  { keyword: 'tfr', category: 'transfer' },
];

/** How firm a keyword suggestion is. A one-word hit inside a longer name is the weakest kind. */
export type CategoryConfidence = 'exact' | 'strong' | 'weak' | 'none';

export interface CategorySuggestion {
  readonly category: StandardCategory;
  readonly confidence: CategoryConfidence;
  /** The keyword that produced the suggestion, so the confirm step can explain itself. */
  readonly matchedKeyword: string | null;
}

const UNMATCHED: CategorySuggestion = {
  category: 'uncategorised',
  confidence: 'none',
  matchedKeyword: null,
};

/**
 * Suggest a standard category from an account or supplier name (§6.5).
 *
 * Whole-token matching only: "4000 Sales Revenue" matches `sales`, while "Winsale Ltd" does not.
 * A substring rule would map "Insurance" to `ni` and "Advertising" to `ads`.
 */
export function suggestCategory(name: string): CategorySuggestion {
  const normalized = normalizeAccountName(name);
  if (normalized === '') return UNMATCHED;
  const tokens = normalized.split(' ');

  let best: KeywordRule | null = null;
  let bestTokens = 0;
  for (const rule of CATEGORY_KEYWORDS) {
    const keywordTokens = rule.keyword.split(' ');
    if (keywordTokens.length > tokens.length) continue;
    if (keywordTokens.length < bestTokens) continue;
    for (let start = 0; start + keywordTokens.length <= tokens.length; start += 1) {
      let hit = true;
      for (let offset = 0; offset < keywordTokens.length; offset += 1) {
        if (tokens[start + offset] !== keywordTokens[offset]) { hit = false; break; }
      }
      if (!hit) continue;
      // Longest keyword wins; on a tie the earlier table row wins, so the document's order still
      // decides between two equally specific keywords.
      if (keywordTokens.length > bestTokens) {
        best = rule;
        bestTokens = keywordTokens.length;
      }
      break;
    }
  }

  if (best === null) return UNMATCHED;
  const confidence: CategoryConfidence =
    normalized === best.keyword ? 'exact' : bestTokens > 1 ? 'strong' : 'weak';
  return { category: best.category, confidence, matchedKeyword: best.keyword };
}

/**
 * A supplier's `default_expense_category` (§6.5, ADR-027.4, finding F-B-05): the keyword table
 * applied to the supplier name, else `cost_of_sales`.
 *
 * A suggestion that is not an expense is discarded rather than used. "Sales Force Ltd" matching
 * `revenue` would otherwise make every purchase invoice from that supplier increase income.
 */
export function suggestSupplierExpenseCategory(supplierName: string): CategorySuggestion {
  const suggestion = suggestCategory(supplierName);
  if (
    suggestion.confidence !== 'none' &&
    CATEGORY_ACCOUNT_TYPE[suggestion.category] === 'expense'
  ) {
    return suggestion;
  }
  return { category: 'cost_of_sales', confidence: 'none', matchedKeyword: null };
}

/** An `accounts` row as the resolution needs it — the shape the service layer selects. */
export interface ExistingAccount {
  readonly code: string | null;
  readonly name: string;
  readonly standardCategory: StandardCategory;
}

export interface AccountResolutionInput {
  /** The account label as it appears in the file. */
  readonly value: string;
  /** A separately mapped `code` column, when the file has one (§6.1). */
  readonly code?: string | null;
  /** The organization's existing accounts, for the code and normalized-name steps. */
  readonly accounts: readonly ExistingAccount[];
  /**
   * The saved mapping's `account_map`, already resolved to standard categories by the service.
   * `MappingSnapshot.accountMap` is typed `Record<string, string>`; whether its values are account
   * ids or categories is not stated in §6.3, so the translation is left to the caller who knows.
   */
  readonly savedCategories?: Readonly<Record<string, StandardCategory>>;
}

export type AccountResolutionSource =
  | 'account_code' | 'account_name' | 'account_map' | 'keyword' | 'uncategorised';

export interface AccountResolution {
  readonly category: StandardCategory;
  readonly source: AccountResolutionSource;
  readonly confidence: CategoryConfidence;
  readonly matchedKeyword: string | null;
  readonly normalizedName: string;
}

/**
 * The §6.5 resolution order, over data the caller has already fetched.
 *
 * An existing account is `exact` because a human confirmed it once already; only the keyword step
 * produces a suggestion the reviewer still has to look at.
 */
export function resolveAccountCategory(input: AccountResolutionInput): AccountResolution {
  const normalizedName = normalizeAccountName(input.value);
  const code = input.code?.trim() ?? '';

  if (code !== '') {
    const wanted = normalizeAccountCode(code);
    const byCode = input.accounts.find(
      (account) => account.code !== null && normalizeAccountCode(account.code) === wanted,
    );
    if (byCode !== undefined) {
      return {
        category: byCode.standardCategory,
        source: 'account_code',
        confidence: 'exact',
        matchedKeyword: null,
        normalizedName,
      };
    }
  }

  if (normalizedName !== '') {
    const byName = input.accounts.find(
      (account) => normalizeAccountName(account.name) === normalizedName,
    );
    if (byName !== undefined) {
      return {
        category: byName.standardCategory,
        source: 'account_name',
        confidence: 'exact',
        matchedKeyword: null,
        normalizedName,
      };
    }
  }

  const saved = input.savedCategories?.[normalizedName];
  if (saved !== undefined) {
    return {
      category: saved,
      source: 'account_map',
      confidence: 'exact',
      matchedKeyword: null,
      normalizedName,
    };
  }

  const suggestion = suggestCategory(input.value);
  if (suggestion.confidence === 'none') {
    return {
      category: 'uncategorised',
      source: 'uncategorised',
      confidence: 'none',
      matchedKeyword: null,
      normalizedName,
    };
  }
  return {
    category: suggestion.category,
    source: 'keyword',
    confidence: suggestion.confidence,
    matchedKeyword: suggestion.matchedKeyword,
    normalizedName,
  };
}
