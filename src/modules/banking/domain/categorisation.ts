/**
 * Bank transaction categorisation (FINANCIAL_ENGINE.md §4.1).
 *
 * Pure. No Supabase, no clock, no randomness: the same transactions, the same saved rules and the
 * same keyword-rule version must produce byte-identical outcomes, because these outcomes feed the
 * bank-basis P&L proxy (§4.4) and therefore land in `metric_snapshots` (§1.1).
 *
 * The precedence is a strict ladder — user override, saved organization rule, platform keyword rule,
 * AI suggestion, none — and the first rung that matches wins. Nothing lower can disturb a decision a
 * higher rung already made.
 *
 * NOTE ON `assurance_level`. §4.1 point 3 contains a self-correction in the source text: it first
 * says the keyword stage sets `category_source = 'rule'` AND `assurance_level = 'inferred'`, then
 * corrects itself — "no: categorisation does not alter record assurance; it sets
 * `bank_transactions.category_source` only". The corrected reading is authoritative and is what this
 * module implements: NOTHING here touches `assurance_level`. Assurance describes how much the
 * *record* can be relied upon (where it came from, whether it reconciled); guessing which expense
 * bucket a payment belongs in says nothing about that, and letting a keyword rule downgrade a
 * reconciled statement line to `inferred` would make verified bank data look like an estimate.
 */

import {
  Decimal, abs, cashDirection, divide, roundRatio, toMoneyString, toRatioString,
  type CashDirection,
} from '@/core/money';
import type { StandardCategory } from '@/modules/financials';
import type { CategorySource } from './types';

/**
 * The platform keyword set is VERSIONED, and the version is part of the calculation run fingerprint
 * (ADR-047.11 does the same for `detector_version`).
 *
 * The reason is that this set is retroactive: rules run over the whole history on every calculation
 * run, so editing a pattern silently re-categorises transactions that were categorised differently
 * last month, and every bank-basis figure derived from them moves. A reader who cannot see which
 * rule set produced a figure cannot explain why last month's number changed. Bump this constant on
 * any change to `KEYWORD_RULES` — adding, removing, reordering or editing a pattern.
 */
export const KEYWORD_RULE_SET_VERSION = 'banking.keywords.v1';

// ---------------------------------------------------------------------------------------------
// Description signatures
// ---------------------------------------------------------------------------------------------

/**
 * The description reduced to the part that identifies the payee rather than the payment.
 *
 * The input is `description_normalized`, which is ALREADY masked of 6–8 digit account numbers and
 * sort codes (ADR-038.4); this module never sees `description_raw`. What is stripped here on top is
 * everything that varies between two instances of the same standing payment — dates, reference
 * codes and remaining digit runs — so that "DD ACME LTD REF 4471 12MAR" and
 * "DD ACME LTD REF 5522 12APR" reduce to one signature and one saved rule covers both.
 */
export function descriptionSignature(description: string | null | undefined): string {
  return (description ?? '')
    .normalize('NFKC')
    .toLowerCase()
    // Reference codes first, so `ref 4471` leaves nothing behind rather than a stray `ref`.
    .replace(/\b(?:ref|reference|refno|mandate|bgc|ftr)\s*[:#.-]?\s*[a-z0-9]{2,}\b/g, ' ')
    // Dates in the shapes UK statements use: 12/03/26, 12-03-2026, 12mar, 12 mar 26.
    .replace(/\b\d{1,2}[/\-.]\d{1,2}(?:[/\-.]\d{2,4})?\b/g, ' ')
    .replace(/\b\d{1,2}\s?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s?\d{0,4}\b/g, ' ')
    // Any remaining digit run: card suffixes, sequence numbers, statement line numbers.
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The text keyword patterns are tested against.
 *
 * Deliberately NOT `descriptionSignature`: the signature throws away digits, and patterns such as
 * `hmrc vat` or `google ads` live in the words. Case and unicode form are the only things flattened.
 */
function matchText(description: string | null | undefined): string {
  return (description ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------------------------
// Stage 3: the platform keyword rule set (§4.1 point 3)
// ---------------------------------------------------------------------------------------------

/** `any` means the rule applies to a movement in either direction. */
export type KeywordRuleDirection = CashDirection | 'any';

export interface KeywordRule {
  /** Stable id, recorded on the outcome so a reader can see WHICH rule fired. */
  readonly id: string;
  readonly pattern: RegExp;
  readonly category: StandardCategory;
  readonly direction: KeywordRuleDirection;
}

/**
 * The UK-oriented platform rule set. ORDER IS PRECEDENCE: the first rule that matches wins, so the
 * specific patterns sit above the general ones (`hmrc paye` before the catch-all `hmrc`).
 *
 * No `g` flag on any pattern. A global regex carries `lastIndex` between calls, so the same rule
 * tested against the same string twice would give different answers — the exact class of bug this
 * module exists to make impossible.
 *
 * Two deliberate absences:
 *  - There is NO `/transfer|tfr/ → transfer` rule. Transfer classification is §4.2's job and only
 *    happens on a confirmed PAIR; a keyword rule here would park a lone transfer-looking row in the
 *    `transfer` category, and since `transfer` is NON_PNL that would remove a real, unpaired
 *    movement from the figures — the precise failure the description gate exists to prevent.
 *  - There is NO `/card payment/ → credit_card` rule. On a UK current account "CARD PAYMENT TO
 *    ACME" is an ordinary purchase, not a repayment of a card balance.
 */
export const KEYWORD_RULES: readonly KeywordRule[] = [
  // --- Tax (specific first) ---
  { id: 'hmrc_vat', pattern: /\bhmrc\s*vat\b|\bvat\s*(?:return|payment|quarter)\b|\bhmrc\s*ndds\b/, category: 'tax_liability', direction: 'any' },
  { id: 'hmrc_paye', pattern: /\bhmrc\s*paye\b|\bpaye\b|\bp32\b/, category: 'payroll', direction: 'any' },
  { id: 'hmrc_corporation_tax', pattern: /\bcorporation\s*tax\b|\bhmrc\s*cotax\b|\bct600\b|\bhmrc\s*(?:shipley|cumbernauld)\b/, category: 'tax_liability', direction: 'any' },
  { id: 'hmrc_other', pattern: /\bhmrc\b/, category: 'tax_liability', direction: 'any' },

  // --- Payroll ---
  { id: 'payroll', pattern: /\bpayroll\b|\bsalar(?:y|ies)\b|\bwages\b|\bstaff\s*pay\b|\bnest\s*pensions?\b|\bpension\s*contribution\b/, category: 'payroll', direction: 'any' },

  // --- Revenue: only ever on an INFLOW (§4.1 point 3's own example). The same words on an outflow
  // are a payout fee or a supplier invoice being paid, which is not revenue.
  { id: 'revenue_platform_inflow', pattern: /\bstripe\b|\bshopify\s*payout\b|\binvoice\b|\bpaypal\b|\bsumup\b|\bsquare\s*up\b|\bworldpay\b|\bgocardless\b|\b(?:i)?zettle\b|\btakepayments\b/, category: 'revenue', direction: 'inflow' },

  // --- Debt ---
  { id: 'loan', pattern: /\bloan\s*repayment\b|\bloan\b|\bfunding\s*circle\b|\biwoca\b|\bbounce\s*back\b|\bcbils\b/, category: 'loan', direction: 'any' },
  { id: 'credit_card_repayment', pattern: /\bcredit\s*card\s*(?:payment|repayment|bill)\b|\bcard\s*repayment\b|\bbarclaycard\b|\bamex\s*payment\b/, category: 'credit_card', direction: 'any' },

  // --- Operating costs ---
  { id: 'rent_and_rates', pattern: /\brent\b|\brental\b|\blandlord\b|\bbusiness\s*rates\b/, category: 'operating_expense', direction: 'outflow' },
  { id: 'insurance', pattern: /\binsurance\b|\bhiscox\b|\baviva\b|\bsimply\s*business\b/, category: 'operating_expense', direction: 'outflow' },
  { id: 'utilities', pattern: /\bbritish\s*gas\b|\bedf\s*energy\b|\boctopus\s*energy\b|\be\.?on\s*next\b|\bscottish\s*power\b|\bthames\s*water\b|\bwater\s*(?:plc|board)\b|\bcouncil\b/, category: 'operating_expense', direction: 'outflow' },
  { id: 'telecoms', pattern: /\bvodafone\b|\bvirgin\s*media\b|\bbt\s*(?:group|business)\b|\bthree\s*uk\b|\bplusnet\b/, category: 'operating_expense', direction: 'outflow' },
  { id: 'bank_charges', pattern: /\bbank\s*charges?\b|\bservice\s*charge\b|\baccount\s*fee\b|\bnon\s*sterling\s*(?:transaction\s*)?fee\b/, category: 'operating_expense', direction: 'outflow' },

  // --- Marketing ---
  { id: 'marketing', pattern: /\bgoogle\s*ads\b|\badwords\b|\bfacebook\s*ad|\bmeta\s*platforms\b|\blinkedin\s*ads\b|\btiktok\s*ads\b|\bmailchimp\b|\bhubspot\b/, category: 'marketing', direction: 'outflow' },

  // --- Below the line ---
  { id: 'interest', pattern: /\binterest\s*(?:charge|charged|paid)\b|\boverdraft\s*interest\b/, category: 'interest_expense', direction: 'outflow' },
  { id: 'drawings', pattern: /\bdrawings\b|\bowners?\s*draw\b|\bdividend\b/, category: 'drawings', direction: 'outflow' },
];

/** The keyword rule that fires for a description and direction, or `null`. */
export function matchKeywordRule(
  description: string | null | undefined,
  direction: CashDirection | null,
): KeywordRule | null {
  const text = matchText(description);
  if (text === '') return null;
  for (const rule of KEYWORD_RULES) {
    if (rule.direction !== 'any' && rule.direction !== direction) continue;
    if (rule.pattern.test(text)) return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The precedence ladder
// ---------------------------------------------------------------------------------------------

/** The rung of §4.1 that decided a transaction's category. */
export type CategorisationStage =
  | 'user' | 'organization_rule' | 'keyword_rule' | 'ai_suggestion' | 'none';

/**
 * What this module needs to know about a transaction. Structurally a subset of `BankTransaction`,
 * so a repository row can be passed straight in.
 */
export interface CategorisableTransaction {
  readonly id: string;
  /** Signed: positive is an inflow (DATABASE_ARCHITECTURE.md §3). */
  readonly amount: string;
  readonly descriptionNormalized: string | null;
  readonly counterpartyId: string | null;
  readonly categoryAccountId: string | null;
  readonly categorySource: CategorySource;
}

/**
 * A rule the organization saved when a user categorised and confirmed "apply to similar" (§4.1
 * point 2). Exactly one of the two keys is used; a rule with both matches only when both agree,
 * which is how a user can say "Acme, but only the direct debits".
 */
export interface OrganizationCategoryRule {
  readonly id: string;
  readonly descriptionSignature: string | null;
  readonly counterpartyId: string | null;
  readonly categoryAccountId: string;
}

/** Post-MVP (§4.1 point 4). Modelled in the ladder; nothing in this module generates one. */
export interface AiCategorySuggestion {
  readonly transactionId: string;
  readonly categoryAccountId: string;
}

/** A category account of the organization's chart, as the ladder needs it. */
export interface CategoryAccountRef {
  readonly id: string;
  readonly standardCategory: StandardCategory;
}

export interface CategorisationInput {
  readonly transactions: readonly CategorisableTransaction[];
  readonly organizationRules: readonly OrganizationCategoryRule[];
  /** The chart of accounts, used to resolve a keyword rule's category to a concrete account id. */
  readonly categoryAccounts: readonly CategoryAccountRef[];
  readonly aiSuggestions?: readonly AiCategorySuggestion[];
}

export interface CategorisationResult {
  readonly transactionId: string;
  readonly categoryAccountId: string | null;
  /** The standard category of the chosen account, when it could be resolved. */
  readonly standardCategory: StandardCategory | null;
  readonly categorySource: CategorySource;
  readonly stage: CategorisationStage;
  /** The organization rule id or keyword rule id that fired, for explainability. */
  readonly ruleId: string | null;
  /** The keyword set that produced a `keyword_rule` outcome, else null. */
  readonly keywordRuleSetVersion: string | null;
}

/**
 * Resolve `standard_category → account_id`.
 *
 * When an organization has several accounts carrying one standard category, the lowest id wins.
 * Any deterministic choice would do; what matters is that it is the SAME choice on every run, so a
 * figure does not move because a map iterated in a different order.
 */
function categoryAccountIndex(
  accounts: readonly CategoryAccountRef[],
): Readonly<Record<string, string>> {
  const byCategory: Record<string, string> = {};
  const sorted = [...accounts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const account of sorted) {
    if (byCategory[account.standardCategory] === undefined) {
      byCategory[account.standardCategory] = account.id;
    }
  }
  return byCategory;
}

function accountCategoryIndex(
  accounts: readonly CategoryAccountRef[],
): Readonly<Map<string, StandardCategory>> {
  const byId = new Map<string, StandardCategory>();
  for (const account of accounts) byId.set(account.id, account.standardCategory);
  return byId;
}

/**
 * Run the §4.1 ladder over one transaction.
 *
 * Stage 1 is absolute. A user override is returned EXACTLY as it stands, including when the user
 * deliberately cleared the category — "the user said none" is a decision, not a gap, and a rule that
 * refilled it would overwrite a person's judgement on the next run with no trace.
 */
export function categoriseTransaction(
  transaction: CategorisableTransaction,
  input: Omit<CategorisationInput, 'transactions'>,
): CategorisationResult {
  const byCategory = categoryAccountIndex(input.categoryAccounts);
  const byAccount = accountCategoryIndex(input.categoryAccounts);
  return categoriseOne(transaction, input, byCategory, byAccount);
}

function categoriseOne(
  transaction: CategorisableTransaction,
  input: Omit<CategorisationInput, 'transactions'>,
  byCategory: Readonly<Record<string, string>>,
  byAccount: Readonly<Map<string, StandardCategory>>,
): CategorisationResult {
  const resolved = (accountId: string | null): StandardCategory | null =>
    accountId === null ? null : (byAccount.get(accountId) ?? null);

  // ---- 1. User override: never changed by a rule (§4.1 point 1). ----
  if (transaction.categorySource === 'user') {
    return {
      transactionId: transaction.id,
      categoryAccountId: transaction.categoryAccountId,
      standardCategory: resolved(transaction.categoryAccountId),
      categorySource: 'user',
      stage: 'user',
      ruleId: null,
      keywordRuleSetVersion: null,
    };
  }

  // ---- 2. Saved organization rule (§4.1 point 2). ----
  const signature = descriptionSignature(transaction.descriptionNormalized);
  // Sorted by id so two rules matching the same transaction always resolve the same way.
  const orgRules = [...input.organizationRules].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const rule of orgRules) {
    const signatureMatches =
      rule.descriptionSignature !== null && rule.descriptionSignature !== ''
        ? rule.descriptionSignature === signature
        : null;
    const counterpartyMatches =
      rule.counterpartyId !== null
        ? rule.counterpartyId === transaction.counterpartyId
        : null;
    if (signatureMatches === null && counterpartyMatches === null) continue;
    if (signatureMatches === false || counterpartyMatches === false) continue;
    return {
      transactionId: transaction.id,
      categoryAccountId: rule.categoryAccountId,
      standardCategory: resolved(rule.categoryAccountId),
      categorySource: 'rule',
      stage: 'organization_rule',
      ruleId: rule.id,
      keywordRuleSetVersion: null,
    };
  }

  // ---- 3. Platform keyword rule set (§4.1 point 3). ----
  const direction = cashDirection(transaction.amount);
  const keyword = matchKeywordRule(transaction.descriptionNormalized, direction);
  if (keyword !== null) {
    const accountId = byCategory[keyword.category] ?? null;
    if (accountId !== null) {
      return {
        transactionId: transaction.id,
        categoryAccountId: accountId,
        standardCategory: keyword.category,
        // Sets `category_source` and NOTHING ELSE — see the module note on `assurance_level`.
        categorySource: 'rule',
        stage: 'keyword_rule',
        ruleId: keyword.id,
        keywordRuleSetVersion: KEYWORD_RULE_SET_VERSION,
      };
    }
    // The organization has no account carrying that category. Falling through to `none` is right:
    // inventing an account id here would write a category account that does not exist.
  }

  // ---- 4. AI suggestion (§4.1 point 4), post-MVP. ----
  // Present in the ladder so the order is fixed now rather than argued about later. The outcome
  // stays `ai_suggested`: a suggestion is not a decision until a person confirms it, and no
  // bank-basis figure treats it as one.
  const suggestion = (input.aiSuggestions ?? []).find((s) => s.transactionId === transaction.id);
  if (suggestion !== undefined) {
    return {
      transactionId: transaction.id,
      categoryAccountId: suggestion.categoryAccountId,
      standardCategory: resolved(suggestion.categoryAccountId),
      categorySource: 'ai_suggested',
      stage: 'ai_suggestion',
      ruleId: null,
      keywordRuleSetVersion: null,
    };
  }

  // ---- 5. None (§4.1 point 5): counted as `uncategorised`. ----
  return {
    transactionId: transaction.id,
    categoryAccountId: null,
    standardCategory: null,
    categorySource: 'none',
    stage: 'none',
    ruleId: null,
    keywordRuleSetVersion: null,
  };
}

/** The ladder over a whole set. Output order follows input order; each row is independent. */
export function categoriseTransactions(input: CategorisationInput): CategorisationResult[] {
  const byCategory = categoryAccountIndex(input.categoryAccounts);
  const byAccount = accountCategoryIndex(input.categoryAccounts);
  return input.transactions.map((t) => categoriseOne(t, input, byCategory, byAccount));
}

// ---------------------------------------------------------------------------------------------
// Uncategorised share → `completeness` for bank-basis metrics (§5)
// ---------------------------------------------------------------------------------------------

/** The `uncategorised` standard category, named once (§4.1 point 5). */
export const UNCATEGORISED_CATEGORY: StandardCategory = 'uncategorised';

export interface CategorisedAmount {
  /** Signed. Only the magnitude is used: a share is about size, not direction. */
  readonly amount: string;
  readonly categoryAccountId: string | null;
}

export interface UncategorisedShare {
  /** Σ|amount| with no category, as a money string. */
  readonly uncategorisedAmount: string;
  /** Σ|amount| over every row considered, as a money string. */
  readonly totalAmount: string;
  /** `uncategorised / total`, 6 dp, as a ratio string. */
  readonly share: string;
  /** `1 − share`, the `completeness` a bank-basis metric records (§5). */
  readonly completeness: number;
}

/**
 * The uncategorised share, and the `completeness` it drives for bank-basis metrics (§5).
 *
 * With nothing to categorise the share is 0 and completeness is 1: "we saw everything there was to
 * see" is genuinely complete, and reporting 0 completeness for an empty month would make a quiet
 * month look like missing data (§1.5 — zero means we know it is zero).
 */
export function uncategorisedShare(rows: readonly CategorisedAmount[]): UncategorisedShare {
  let total = new Decimal(0);
  let uncategorised = new Decimal(0);
  for (const row of rows) {
    const magnitude = abs(row.amount);
    total = total.plus(magnitude);
    if (row.categoryAccountId === null) uncategorised = uncategorised.plus(magnitude);
  }
  const ratio = divide(uncategorised, total);
  const share = ratio === null ? new Decimal(0) : roundRatio(ratio);
  return {
    uncategorisedAmount: toMoneyString(uncategorised),
    totalAmount: toMoneyString(total),
    share: toRatioString(share),
    completeness: new Decimal(1).minus(share).toNumber(),
  };
}
