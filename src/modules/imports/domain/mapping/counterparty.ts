/**
 * Counterparty resolution (IMPORT_ENGINE.md §6.6) and the name/figure rule (ADR-045.3, R2-C-05).
 *
 * Pure: matching an existing counterparty is a lookup on `normalized_name`, so this file produces
 * the key and the service does the query.
 */

import type { RowIssue } from '../pipeline-types';
import type { ImportType } from '../types';
import type { CounterpartyKind } from '@/modules/financials';

/**
 * §6.6: `normalized_name = lower(trim(collapse_ws(strip(name, /[^\p{L}\p{N} ]/u))))` with the
 * common company suffixes removed.
 *
 * Punctuation is REMOVED here, not replaced with a space — that is what the document's `strip`
 * says, and it is why "Acme & Co." and "Acme Co" resolve to the same counterparty. (Header
 * normalisation in `synonyms.ts` replaces punctuation with a space instead, because "money-out"
 * and "money out" are the same column but "moneyout" is not a header anyone writes.)
 */
const COMPANY_SUFFIXES: readonly string[] = ['ltd', 'limited', 'plc', 'llp', 'inc'];

export function normalizedName(name: string): string {
  const stripped = name
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, ' ');
  if (stripped === '') return '';

  // Suffixes are peeled off the end repeatedly: "Acme Holdings Ltd" and "Acme Holdings" are one
  // supplier, and so are "Acme Ltd" and "Acme Limited".
  let tokens = stripped.split(' ');
  while (tokens.length > 1 && COMPANY_SUFFIXES.includes(tokens[tokens.length - 1] as string)) {
    tokens = tokens.slice(0, -1);
  }
  return tokens.join(' ');
}

// -----------------------------------------------------------------------------------------------
// IMP-NAME-015 — names may not carry figures (ADR-045.3, R2-C-05)
// -----------------------------------------------------------------------------------------------

/**
 * Entity names are exempt from the AI grounding scan (`AI_ARCHITECTURE.md` §7.9), so a name is the
 * one place a figure could reach a rendered statement without a `NumberRef` behind it. That is the
 * whole reason this rule exists: "Acme Ltd (owed £45,000)" printed in an answer would read as a
 * MOTION-calculated figure and would never have been checked against any tool result.
 *
 * Only the currency and percentage classes of the claim grammar are refused. Digits on their own
 * are fine — §6.6 keeps "3M", "7-Eleven" and "Studio 54" — so a bare number is not enough; it takes
 * a currency mark, a currency code, or money-shaped thousands grouping.
 */

/** The symbols §7.9 lists, plus the other major ones; each is a currency mark next to a number. */
const CURRENCY_SYMBOLS = '£$€¥₹₽₩₪₦₺฿¢¤';

/**
 * ISO-4217 codes, uppercase only, as §7.9 writes the class.
 *
 * The grammar's literal `[A-Z]{3}` would refuse "ACME 100 LTD", so the class is narrowed to real
 * currency codes; the codes that are also ordinary English words (ALL, TRY, TOP, BOB, CUP, MOP,
 * SOS) are left out, because an all-capitals export would otherwise turn "TOP 10 LTD" into an
 * import error. Both narrowings are deliberate: this rule blocks a commit, so a false positive
 * costs a customer their import.
 */
const CURRENCY_CODES: readonly string[] = [
  'GBP', 'USD', 'EUR', 'AED', 'INR', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'CNY', 'HKD', 'SGD',
  'ZAR', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'RUB', 'UAH', 'BRL', 'MXN',
  'ARS', 'CLP', 'PEN', 'PKR', 'BDT', 'LKR', 'NPR', 'THB', 'MYR', 'IDR', 'PHP', 'VND', 'KRW',
  'TWD', 'ILS', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'EGP', 'NGN', 'KES', 'TZS', 'UGX',
  'GHS', 'MAD', 'TND', 'DZD', 'ISK', 'RSD', 'MKD',
];

const CODE_ALTERNATION = CURRENCY_CODES.join('|');

/** `[-]?\d+(\.\d+)?\s?(%|per ?cent|percent)` — §7.9 percentage class. */
const PERCENTAGE = /\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:%|per\s?cent|percent)(?![\p{L}])/iu;

/** The digits that belong to the mark, so the error message can quote the whole figure. */
const NUMBER_BODY = '\\d(?:[\\d,.]*\\d)?';

/** A currency symbol immediately before or after a number: "£45,000", "45,000£", "$1", "€5". */
const SYMBOL_BEFORE_NUMBER = new RegExp(`[${CURRENCY_SYMBOLS}]\\s?${NUMBER_BODY}`, 'u');
const SYMBOL_AFTER_NUMBER = new RegExp(`${NUMBER_BODY}\\s?[${CURRENCY_SYMBOLS}]`, 'u');

/** An ISO code immediately before or after a number: "GBP 45,000", "45000 USD". */
const CODE_BEFORE_NUMBER = new RegExp(`\\b(?:${CODE_ALTERNATION})\\s?${NUMBER_BODY}`, 'u');
const CODE_AFTER_NUMBER = new RegExp(`${NUMBER_BODY}\\s?(?:${CODE_ALTERNATION})\\b`, 'u');

/**
 * A money-shaped number with no mark at all: thousands grouping, in either convention.
 * "45,000.00" and "45.000,00" are amounts; "3M", "54" and "2026" are not.
 */
const GROUPED_AMOUNT = /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?/u;

export type NameFigureKind = 'currency_amount' | 'percentage';

export interface NameFigureFinding {
  readonly kind: NameFigureKind;
  /** What the rule saw, for the reviewer's error message. */
  readonly matched: string;
}

/**
 * Normalisation §7.9 applies before the grammar runs: NFKC, thin and no-break spaces to a plain
 * space, and the minus and en-dash characters to a hyphen. Without it "£ 45,000" written with a
 * no-break space, or a full-width "￥", would walk straight past the rule.
 */
function normalizeForClaimGrammar(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\u00a0\u2007\u2009\u200a\u202f]/gu, ' ')
    .replace(/[\u2212\u2013]/gu, '-');
}

/** The figure a name carries, or `null` when it carries none. */
export function findFigureInName(name: string): NameFigureFinding | null {
  const text = normalizeForClaimGrammar(name);

  const percentage = PERCENTAGE.exec(text);
  if (percentage !== null) return { kind: 'percentage', matched: percentage[0].trim() };

  for (const pattern of [
    SYMBOL_BEFORE_NUMBER, SYMBOL_AFTER_NUMBER, CODE_BEFORE_NUMBER, CODE_AFTER_NUMBER, GROUPED_AMOUNT,
  ]) {
    const match = pattern.exec(text);
    if (match !== null) return { kind: 'currency_amount', matched: match[0].trim() };
  }
  return null;
}

export function nameCarriesFigure(name: string): boolean {
  return findFigureInName(name) !== null;
}

/**
 * `IMP-NAME-015` (error). Applied to counterparty AND account names at import mapping, and to the
 * same names in `api.update_counterparty` and `api.merge_counterparties` (§6.6).
 */
export function nameFigureIssue(name: string, field: string): RowIssue | null {
  const finding = findFigureInName(name);
  if (finding === null) return null;
  return {
    code: 'IMP-NAME-015',
    severity: 'error',
    field,
    message: 'Names cannot contain amounts; edit the name or map to an existing customer',
    suggestion: `Remove "${finding.matched}" from the name.`,
  };
}

// -----------------------------------------------------------------------------------------------
// Kind (§6.6)
// -----------------------------------------------------------------------------------------------

/** A new counterparty takes its kind from the import type; a GL or bank name is `unknown`. */
export function counterpartyKindFor(importType: ImportType): CounterpartyKind {
  switch (importType) {
    case 'sales_invoices':
    case 'sales_report':
      return 'customer';
    case 'purchase_invoices':
    case 'purchase_report':
      return 'supplier';
    default:
      return 'unknown';
  }
}

/** "`kind` is upgraded to `both` when the same counterparty appears on both sides" (§6.6). */
export function upgradeCounterpartyKind(
  existing: CounterpartyKind,
  incoming: CounterpartyKind,
): CounterpartyKind {
  if (incoming === 'unknown') return existing;
  if (existing === 'unknown') return incoming;
  if (existing === incoming) return existing;
  return 'both';
}
