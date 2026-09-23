/**
 * Profit-and-loss metrics (FINANCIAL_ENGINE.md §3.1).
 *
 * Pure: aggregated amounts in, `MetricResult[]` out. No Supabase, no clock, no randomness, and no
 * iteration-order dependence — categories are walked in `STANDARD_CATEGORIES` order and accounts in
 * id order, so the same inputs serialise byte-identically every time (§1.1).
 *
 * Two rules govern everything below and are worth stating before the code:
 *
 *  1. NEVER ZERO-FILL (§1.5). A figure that cannot be computed is `null` WITH a reason in
 *     `data_quality.missing`. Zero is reserved for "we know it is zero" — which is why a covering
 *     trial balance with no interest line does write `interest_expense = 0`, and why an
 *     organization with no cost-of-sales account at all writes `cost_of_sales = null` instead.
 *  2. EVERY EDGE CASE IN THE §3.1 TABLE IS THE SPECIFICATION. Negative revenue, a missing
 *     cost-of-sales account, uncategorised amounts past 5% and 25%, zero revenue under a margin —
 *     each of these is a real month in a real business, and each has its own test.
 */

import {
  Decimal,
  ZERO,
  abs,
  add,
  divide,
  subtract,
  sum,
  toMoneyString,
  toRatioString,
} from '@/core/money';
import { CATEGORY_ACCOUNT_TYPE, type StandardCategory } from '@/modules/financials';
import {
  BELOW_LINE_CATEGORIES,
  EXPENSE_BY_CATEGORY_CATEGORIES,
  OPEX_CATEGORIES,
} from './categories';
import { weakestOf } from '@/core/assurance';
import { withMergedCounterparties } from './merged';
import type {
  AccountRef,
  AssuranceLevel,
  BasisChoice,
  DataQuality,
  DataQualityMissing,
  DataQualityWarning,
  DimensionType,
  EngineContext,
  EvidenceQuery,
  LeafDescriptor,
  MetricBasis,
  MetricResult,
  MetricUnit,
  PeriodRef,
} from './types';

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/**
 * One account's already-signed total for the period.
 *
 * The amount is in REPORTING sign and has been through `sign.ts` — including cumulative
 * differencing, which is why it is nullable here: a trial-balance month with no pinned predecessor
 * produces a genuine "cannot compute", and that must survive all the way to the snapshot rather
 * than being flattened into a zero at the first summation.
 */
export interface AccountAmount {
  readonly accountId: string;
  readonly category: StandardCategory;
  readonly amount: string | null;
  readonly rowCount: number;
  readonly warnings?: readonly DataQualityWarning[];
  readonly missing?: readonly DataQualityMissing[];
}

/** What the period's uncategorised amounts look like, for the §3.1 thresholds and §5 completeness. */
export interface UncategorisedExposure {
  /** Σ |amount| sitting on `uncategorised` accounts in the period. */
  readonly absoluteAmount: string;
  /** Σ |amount| over every P&L-eligible account in the period, uncategorised included. */
  readonly totalAbsoluteAmount: string;
}

/** The VAT-fallback counts `sign.ts#foldInvoiceRows` produced, when the basis is `invoices`. */
export interface InvoiceVatExposure {
  readonly contributingRows: number;
  readonly fallbackRows: number;
}

export interface PnlInput {
  readonly period: PeriodRef;
  readonly basis: BasisChoice;
  readonly currency: string | null;
  /**
   * The chart of accounts as it stood when the run executed. Categories are resolved to concrete
   * account ids from THIS list and the ids are what the descriptor stores, never a category name
   * (ADR-034): a category is a mutable property of an account, so a stored category filter would
   * make last March's evidence follow a remap made in September.
   */
  readonly accounts: readonly AccountRef[];
  /** §3.1's "never used", asked of the organisation rather than of this month (ADR-063). */
  readonly costOfSalesEverUsed: boolean;
  readonly accountAmounts: readonly AccountAmount[];
  readonly uncategorised: UncategorisedExposure;
  readonly invoiceVat?: InvoiceVatExposure | null;
  /**
   * Invoice basis only: the counterparties whose purchase invoices were folded into each category
   * this period. An invoice has no account, so an expense figure's evidence cannot be scoped by
   * `account_ids` the way a ledger figure's is — it is scoped by the suppliers that make it up
   * (ADR-104). Without this, every expense figure re-selected every purchase in the period.
   */
  readonly invoiceCounterparties?: ReadonlyMap<StandardCategory, readonly string[]>;
  /**
   * Cost of sales exists in a source the chosen basis is not reading (purchase invoices from a
   * cost-of-sales supplier, while the P&L comes from a ledger that states none). The figure is
   * unavailable with THAT reason, not a zero and not "no such accounts" (ADR-104).
   */
  readonly costOfSalesInOtherSource?: boolean;
}

/**
 * Resolves the snapshot id a named component was written under, for derived evidence.
 *
 * A pure function cannot know a database id, so the caller supplies one. A component whose snapshot
 * does not exist resolves to `null` and the reader simply cannot descend into it — which is
 * honest, and better than a dangling id.
 */
/**
 * Resolves a component metric to the snapshot id the run will write for it (ADR-059).
 *
 * `dimensionKey` is part of the identity, not decoration: a category-dimensioned metric
 * (`expense_by_category`) carries `dimension_id = NULL` and names its subject in `dimension_key`
 * instead, because a category has no row to point at (ADR-053). A resolver keyed on
 * `(key, dimensionId)` alone therefore cannot tell one category's snapshot from another's — every
 * one of them looks like `expense_by_category::null` — so a derived metric naming a category
 * component would resolve to the wrong snapshot or to none (ADR-063).
 */
export type SnapshotIdResolver = (
  key: string, dimensionId: string | null, dimensionKey?: string | null,
) => string | null;

// ---------------------------------------------------------------------------------------------
// Thresholds (§3.1)
// ---------------------------------------------------------------------------------------------

/** Above this share of |revenue|, uncategorised amounts reduce completeness and raise a warning. */
export const UNCATEGORISED_WARNING_THRESHOLD = '0.05';
/** Above this share, the value is still written but the figure is only an estimate. */
export const UNCATEGORISED_ESTIMATED_THRESHOLD = '0.25';
/** Above this share of invoice rows falling back to `total_amount`, the figure is VAT-inclusive enough to be an estimate. */
export const INVOICE_VAT_FALLBACK_THRESHOLD = '0.10';

/**
 * The weakest of two assurance levels. A derived figure is never firmer than its softest input.
 *
 * One line, because the ladder is `core/assurance` and this file used to hold a second rank table
 * ordered against the one in `modules/evidence` (ADR-094).
 */
export function minAssurance(a: AssuranceLevel, b: AssuranceLevel): AssuranceLevel {
  return weakestOf(a, b);
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------

function uniqueInOrder<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

interface Quality {
  readonly completeness: number;
  readonly proxy: boolean;
  readonly warnings: readonly DataQualityWarning[];
  readonly missing: readonly DataQualityMissing[];
}

function quality(
  completeness: number,
  proxy: boolean,
  warnings: readonly DataQualityWarning[],
  missing: readonly DataQualityMissing[],
): DataQuality {
  return {
    completeness,
    proxy,
    warnings: uniqueInOrder(warnings),
    missing: uniqueInOrder(missing),
  };
}

/**
 * Merge the quality of several inputs into a derived figure's quality (§5).
 *
 * Completeness is the MINIMUM, not the mean: a ratio built on one figure the engine could only half
 * see is only half seen, however complete the other half was.
 */
function mergeQuality(inputs: readonly Quality[]): Quality {
  return {
    completeness: inputs.reduce((lowest, q) => Math.min(lowest, q.completeness), 1),
    proxy: inputs.some((q) => q.proxy),
    warnings: uniqueInOrder(inputs.flatMap((q) => [...q.warnings])),
    missing: uniqueInOrder(inputs.flatMap((q) => [...q.missing])),
  };
}

/** A figure the engine has computed, kept in `Decimal` so downstream metrics do exact arithmetic. */
interface Figure {
  readonly value: Decimal | null;
  readonly quality: Quality;
  readonly assurance: AssuranceLevel;
}

/**
 * Completeness never goes below zero. It cannot exceed 1 either, because the share it is derived
 * from is a ratio of absolute values — but a caller that reported more uncategorised money than
 * total money would otherwise produce a negative completeness, which no consumer expects.
 */
function notBelowZero(value: number): number {
  return value < 0 ? 0 : value;
}

/** Lexicographic order, so every list the engine writes is in a fixed order (§1.1). */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

const BASIS_TABLE: Readonly<Record<MetricBasis, LeafDescriptor['table'] | null>> = {
  period_balances: 'period_balances',
  ledger: 'ledger_entries',
  invoices: 'invoices',
  bank: 'bank_transactions',
  mixed: null,
  none: null,
};

const SALES_INVOICE_TYPES = ['sales', 'sales_credit_note'] as const;
const PURCHASE_INVOICE_TYPES = ['purchase', 'purchase_credit_note'] as const;

/**
 * Build the descriptor that re-selects a leaf metric's rows.
 *
 * `account_ids` for the ledger and the balances, `category_account_ids` for the bank (a bank
 * transaction carries a category account, not an account of its own), invoice types for the invoice
 * basis. `mixed` and `none` get no descriptor at all — there is nothing single to re-select.
 */
function leafEvidence(
  input: PnlInput,
  ctx: EngineContext,
  accountIds: readonly string[],
  side: 'income' | 'expense',
): EvidenceQuery | null {
  const table = BASIS_TABLE[input.basis.basis];
  if (table === null) return null;
  const asOf = { calculation_run_id: ctx.calculationRunId, aggregated_at: ctx.aggregatedAt };
  const period_ids = [input.period.id];
  if (table === 'invoices') {
    if (side === 'income') {
      // Sales and their credit notes ARE the revenue figure: the type filter reconciles exactly.
      return {
        kind: 'leaf',
        descriptor: { v: 1, table, filters: { period_ids, invoice_types: [...SALES_INVOICE_TYPES] }, as_of: asOf },
      };
    }
    /*
     * An expense figure on the invoice basis is the purchases of the suppliers whose default
     * category is that figure's — the same rule the fold applied — so the descriptor names those
     * suppliers. A figure nobody's purchases went into gets no descriptor: one that re-selected
     * every purchase in the period would reconcile to the wrong number, which is worse than none.
     */
    const categories = new Set(
      input.accounts.filter((a) => accountIds.includes(a.id)).map((a) => a.standardCategory),
    );
    // The fold recorded SURVIVING ids; the rows carry the originals. Name both (ADR-108).
    const counterparties = withMergedCounterparties(ctx.counterparties, [...new Set(
      [...categories].flatMap((category) => [...(input.invoiceCounterparties?.get(category) ?? [])]),
    )]);
    if (counterparties.length === 0) return null;
    return {
      kind: 'leaf',
      descriptor: {
        v: 1,
        table,
        filters: { period_ids, invoice_types: [...PURCHASE_INVOICE_TYPES], counterparty_ids: counterparties },
        as_of: asOf,
      },
    };
  }
  if (table === 'bank_transactions') {
    return {
      kind: 'leaf',
      descriptor: {
        v: 1, table, filters: { period_ids, category_account_ids: accountIds }, as_of: asOf,
      },
    };
  }
  return {
    kind: 'leaf',
    descriptor: { v: 1, table, filters: { period_ids, account_ids: accountIds }, as_of: asOf },
  };
}

function derivedEvidence(
  resolve: SnapshotIdResolver,
  components: ReadonlyArray<{
    name: string; key: string; dimensionId?: string | null; dimensionKey?: string | null;
  }>,
): EvidenceQuery {
  return {
    kind: 'derived',
    components: components.map((c) => ({
      name: c.name,
      snapshot_id: resolve(c.key, c.dimensionId ?? null, c.dimensionKey ?? null),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Category totals
// ---------------------------------------------------------------------------------------------

interface CategoryTotal {
  readonly category: StandardCategory;
  /** Reporting-sign total, or null when any contributing account could not be computed. */
  readonly value: Decimal | null;
  readonly rowCount: number;
  /** True when at least one account row for this category was present in the aggregates. */
  readonly present: boolean;
  readonly warnings: readonly DataQualityWarning[];
  readonly missing: readonly DataQualityMissing[];
  /** Every account carrying the category at run time, id-sorted (ADR-034). */
  readonly accountIds: readonly string[];
}

function collectCategoryTotals(input: PnlInput): Map<StandardCategory, CategoryTotal> {
  const accountIdsByCategory = new Map<StandardCategory, string[]>();
  for (const account of input.accounts) {
    const ids = accountIdsByCategory.get(account.standardCategory) ?? [];
    ids.push(account.id);
    accountIdsByCategory.set(account.standardCategory, ids);
  }
  for (const ids of accountIdsByCategory.values()) ids.sort();

  const totals = new Map<StandardCategory, CategoryTotal>();
  const seen = new Map<StandardCategory, AccountAmount[]>();
  for (const amount of input.accountAmounts) {
    const list = seen.get(amount.category) ?? [];
    list.push(amount);
    seen.set(amount.category, list);
  }

  for (const [category, amounts] of seen) {
    // Sorted so a null-propagating union of reasons is in a fixed order whatever order the SQL
    // aggregate handed the rows over in.
    const ordered = [...amounts].sort((a, b) => compareIds(a.accountId, b.accountId));
    const missing = ordered.flatMap((a) => [...(a.missing ?? [])]);
    const warnings = ordered.flatMap((a) => [...(a.warnings ?? [])]);
    const anyNull = ordered.some((a) => a.amount === null);
    const value = anyNull
      ? null
      : sum(ordered.map((a) => a.amount as string));
    totals.set(category, {
      category,
      value,
      rowCount: ordered.reduce((n, a) => n + a.rowCount, 0),
      present: true,
      warnings,
      missing: anyNull && missing.length === 0 ? ['no_source_covers_period'] : missing,
      accountIds: accountIdsByCategory.get(category) ?? [],
    });
  }

  for (const [category, ids] of accountIdsByCategory) {
    if (totals.has(category)) continue;
    totals.set(category, {
      category, value: null, rowCount: 0, present: false, warnings: [], missing: [], accountIds: ids,
    });
  }
  return totals;
}

// ---------------------------------------------------------------------------------------------
// The metrics
// ---------------------------------------------------------------------------------------------

interface Builder {
  readonly input: PnlInput;
  readonly ctx: EngineContext;
  readonly resolve: SnapshotIdResolver;
  readonly totals: Map<StandardCategory, CategoryTotal>;
  readonly baseQuality: Quality;
  readonly baseAssurance: AssuranceLevel;
  readonly hasCostOfSalesAccount: boolean;
  readonly results: MetricResult[];
  readonly figures: Map<string, Figure>;
}

function totalOf(b: Builder, category: StandardCategory): CategoryTotal {
  return b.totals.get(category)
    ?? { category, value: null, rowCount: 0, present: false, warnings: [], missing: [], accountIds: [] };
}

/**
 * A category's contribution when it is allowed to be a known zero.
 *
 * §3.1 grants this to `other_expense`, `interest_expense` and `tax_expense` explicitly — "a covered
 * TB with no interest line means zero interest" — and the same reasoning applies to every scalar
 * P&L line once a source covers the period: the source stated the whole statement, and a line it
 * did not state is a line with nothing on it. The rule that absence is not zero governs the
 * DIMENSIONED families (`expense_by_category`, `expense_by_account`), where writing a snapshot per
 * absent category would invent rows nobody has.
 */
function coveredTotal(b: Builder, category: StandardCategory): Figure {
  const total = totalOf(b, category);
  if (!total.present) {
    return { value: ZERO, quality: b.baseQuality, assurance: b.baseAssurance };
  }
  if (total.value === null) {
    return {
      value: null,
      quality: mergeQuality([b.baseQuality, {
        completeness: b.baseQuality.completeness, proxy: b.baseQuality.proxy,
        warnings: total.warnings, missing: total.missing,
      }]),
      assurance: b.baseAssurance,
    };
  }
  return {
    value: total.value,
    quality: mergeQuality([b.baseQuality, {
      completeness: b.baseQuality.completeness, proxy: b.baseQuality.proxy,
      warnings: total.warnings, missing: [],
    }]),
    assurance: b.baseAssurance,
  };
}

function push(
  b: Builder,
  spec: {
    key: string;
    unit: MetricUnit;
    figure: Figure;
    evidence: EvidenceQuery | null;
    components: Readonly<Record<string, unknown>>;
    dimensionType?: DimensionType;
    dimensionId?: string | null;
    /** A category name, for the one dimension that is not a row (ADR-053). */
    dimensionKey?: string | null;
  },
): void {
  const isMoney = spec.unit === 'money';
  const value = spec.figure.value === null
    ? null
    : isMoney ? toMoneyString(spec.figure.value) : toRatioString(spec.figure.value);
  b.results.push({
    key: spec.key,
    value,
    unit: spec.unit,
    basis: b.input.basis.basis,
    assurance: spec.figure.assurance,
    dimensionType: spec.dimensionType ?? 'none',
    dimensionId: spec.dimensionId ?? null,
    dimensionKey: spec.dimensionKey ?? null,
    currency: isMoney ? b.input.currency : null,
    components: spec.components,
    dataQuality: quality(
      spec.figure.quality.completeness,
      spec.figure.quality.proxy,
      spec.figure.quality.warnings,
      spec.figure.quality.missing,
    ),
    evidenceQuery: spec.evidence,
  });
  b.figures.set(spec.dimensionId ? `${spec.key}::${spec.dimensionId}` : spec.key, spec.figure);
}

/** The money string a component records, or null. Components must let a reader redo the sum by hand. */
function money(value: Decimal | null): string | null {
  return value === null ? null : toMoneyString(value);
}

/**
 * A margin: `numerator / revenue`, with every way that can fail (§3.1).
 *
 * A margin over zero revenue is not 0 and not 100% — it does not exist, and the UI shows "n/a".
 * A margin over NEGATIVE revenue is worse than undefined: it is a number with the wrong sign that
 * reads as a healthy figure, so it is refused too.
 */
function marginOf(
  b: Builder,
  numerator: Figure,
  revenue: Figure,
): Figure {
  const merged = mergeQuality([numerator.quality, revenue.quality]);
  const assurance = minAssurance(numerator.assurance, revenue.assurance);
  if (revenue.value === null) {
    return {
      value: null,
      quality: { ...merged, missing: uniqueInOrder([...merged.missing, ...revenue.quality.missing]) },
      assurance,
    };
  }
  if (revenue.value.isZero()) {
    return {
      value: null,
      quality: { ...merged, missing: uniqueInOrder([...merged.missing, 'comparison_is_zero']) },
      assurance,
    };
  }
  if (revenue.value.lessThan(0)) {
    // §3.1: "Negative revenue → NULL with warning". The closed `missing` vocabulary in types.ts has
    // no code for "the denominator is negative" — `comparison_is_zero` would be a false statement —
    // so the warning carries the reason. Reported as a documentation gap.
    return {
      value: null,
      quality: { ...merged, warnings: uniqueInOrder([...merged.warnings, 'negative_revenue']) },
      assurance,
    };
  }
  if (numerator.value === null) {
    return { value: null, quality: merged, assurance };
  }
  const value = divide(numerator.value, revenue.value);
  return { value, quality: merged, assurance };
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * Compute every §3.1 metric for one period.
 *
 * Results come back in a fixed order: the scalar statement lines in statement order, then
 * `expense_by_category` in `STANDARD_CATEGORIES` order, then `expense_by_account` in account-id
 * order. Ordering is part of the determinism guarantee, not a convenience.
 */
export function computePnl(
  input: PnlInput,
  ctx: EngineContext,
  resolve: SnapshotIdResolver,
): readonly MetricResult[] {
  if (input.basis.basis === 'none') return noSourceResults(input, ctx);

  const totals = collectCategoryTotals(input);
  const uncategorisedAbs = abs(input.uncategorised.absoluteAmount);
  const totalAbs = abs(input.uncategorised.totalAbsoluteAmount);
  // `divide` returns null only when the period had no amounts at all, in which case there is
  // nothing uncategorised either and the share is zero.
  const shareOfTotal = divide(uncategorisedAbs, totalAbs) ?? ZERO;
  const baseCompleteness = notBelowZero(1 - shareOfTotal.toNumber());

  const b: Builder = {
    input, ctx, resolve, totals,
    baseQuality: {
      completeness: baseCompleteness,
      proxy: input.basis.proxy,
      warnings: input.basis.warnings,
      missing: [],
    },
    baseAssurance: input.basis.assurance,
    hasCostOfSalesAccount: hasUsableCostOfSalesAccount(input),
    results: [],
    figures: new Map(),
  };

  const revenue = buildRevenue(b, uncategorisedAbs);
  const otherIncome = buildOtherIncome(b);
  const costOfSales = buildCostOfSales(b);
  const grossProfit = buildGrossProfit(b, revenue, costOfSales);
  buildGrossMargin(b, grossProfit, revenue, costOfSales);
  const operatingExpenses = buildOperatingExpenses(b);
  const operatingProfit = buildOperatingProfit(b, grossProfit, operatingExpenses);
  buildMargin(b, 'operating_margin', 'operating_profit', operatingProfit, revenue);
  const belowLine = buildBelowLine(b);
  const netProfit = buildNetProfit(b, operatingProfit, otherIncome, belowLine);
  buildMargin(b, 'net_margin', 'net_profit', netProfit, revenue);
  const contribution = buildContributionMargin(b, revenue, costOfSales);
  buildMargin(b, 'contribution_margin_ratio', 'contribution_margin', contribution, revenue);
  buildExpenseByCategory(b);
  buildExpenseByAccount(b);

  return b.results;
}

/** The whole family when nothing covers the period (§2.3): NULL everywhere, one honest reason. */
function noSourceResults(input: PnlInput, _ctx: EngineContext): readonly MetricResult[] {
  const keys: ReadonlyArray<[string, MetricUnit]> = [
    ['revenue', 'money'], ['other_income', 'money'], ['cost_of_sales', 'money'],
    ['gross_profit', 'money'], ['gross_margin', 'ratio'], ['operating_expenses', 'money'],
    ['operating_profit', 'money'], ['operating_margin', 'ratio'], ['other_expense', 'money'],
    ['interest_expense', 'money'], ['tax_expense', 'money'], ['net_profit', 'money'],
    ['net_margin', 'ratio'], ['contribution_margin', 'money'], ['contribution_margin_ratio', 'ratio'],
  ];
  return keys.map(([key, unit]) => ({
    key,
    value: null,
    unit,
    basis: 'none' as MetricBasis,
    assurance: input.basis.assurance,
    dimensionType: 'none' as DimensionType,
    dimensionId: null,
    currency: unit === 'money' ? input.currency : null,
    components: { period_id: input.period.id },
    dataQuality: quality(0, false, input.basis.warnings, ['no_source_covers_period']),
    evidenceQuery: null,
  }));
}

/**
 * Does the organization actually have a cost-of-sales account? (CD-05.)
 *
 * A seeded SYSTEM account exists for every category, so "is there an account" is the wrong
 * question: the distinction is between an organisation that tracks cost of sales and one that does
 * not. An account the customer created counts on its own; a system account counts once it has ever
 * carried a figure.
 *
 * "Ever" is the whole point, and it is a fact about the ORGANISATION, resolved once per run
 * (`loadCostOfSalesEverUsed`). This used to be answered from the period being computed, which meant
 * a shop that bought no stock in August was told it does not track cost of sales: `cost_of_sales`
 * went NULL, `gross_profit` silently became revenue with a `no_cost_of_sales` warning, and
 * `gross_margin` showed "n/a" for a month it could have shown. CD-05's exception describes a chart,
 * not a month (ADR-063).
 */
function hasUsableCostOfSalesAccount(input: PnlInput): boolean {
  return input.costOfSalesEverUsed
    || input.accounts.some((a) => a.standardCategory === 'cost_of_sales' && !a.isSystem);
}

function buildRevenue(b: Builder, uncategorisedAbs: Decimal): Figure {
  const base = coveredTotal(b, 'revenue');
  const warnings: DataQualityWarning[] = [...base.quality.warnings];
  const missing: DataQualityMissing[] = [...base.quality.missing];
  let assurance = base.assurance;

  // §3.1: a refund-heavy month is a real month. It is reported as the negative number it is, with a
  // warning — never clamped to zero, which would hide the refunds entirely.
  if (base.value !== null && base.value.lessThan(0)) warnings.push('negative_revenue');

  // Uncategorised amounts are measured against |revenue|, not against the total, because "5% of
  // revenue unexplained" is what a reader can judge. Revenue of exactly zero with unexplained money
  // in the period exceeds any share there is, so both thresholds bite.
  const revenueScale = base.value === null ? null : abs(base.value);
  // `divide` is null exactly when revenue is zero: any unexplained money at all then exceeds every
  // share there is, and none at all exceeds none.
  const revenueShare = revenueScale === null ? null : divide(uncategorisedAbs, revenueScale);
  const exceeds = (threshold: string): boolean => {
    if (revenueScale === null) return false;
    if (revenueShare === null) return uncategorisedAbs.greaterThan(0);
    return revenueShare.greaterThan(threshold);
  };
  if (exceeds(UNCATEGORISED_WARNING_THRESHOLD)) warnings.push('uncategorised_amounts');
  if (exceeds(UNCATEGORISED_ESTIMATED_THRESHOLD)) {
    missing.push('uncategorised_amounts_exceed_threshold');
    assurance = minAssurance(assurance, 'estimated');
  }

  // A VAT-inclusive invoice figure standing in for a net one is an overstatement of revenue, so it
  // is surfaced on the metric rather than left in the import log (§3).
  const vat = invoiceVatSignals(b);
  warnings.push(...vat.warnings);
  if (vat.estimated) assurance = minAssurance(assurance, 'estimated');

  const total = totalOf(b, 'revenue');
  const figure: Figure = {
    value: base.value,
    quality: { ...base.quality, warnings, missing },
    assurance,
  };
  push(b, {
    key: 'revenue',
    unit: 'money',
    figure,
    evidence: leafEvidence(b.input, b.ctx, total.accountIds, 'income'),
    components: {
      categories: ['revenue'],
      account_ids: total.accountIds,
      row_count: total.rowCount,
      uncategorised_amount: toMoneyString(uncategorisedAbs),
    },
  });
  return figure;
}

function invoiceVatSignals(b: Builder): { warnings: DataQualityWarning[]; estimated: boolean } {
  const vat = b.input.invoiceVat;
  if (!vat || vat.fallbackRows === 0) return { warnings: [], estimated: false };
  const share = divide(vat.fallbackRows, vat.contributingRows);
  return {
    warnings: ['vat_inclusive'],
    estimated: share !== null && share.greaterThan(INVOICE_VAT_FALLBACK_THRESHOLD),
  };
}

function buildOtherIncome(b: Builder): Figure {
  const figure = coveredTotal(b, 'other_income');
  const total = totalOf(b, 'other_income');
  push(b, {
    key: 'other_income',
    unit: 'money',
    figure,
    evidence: leafEvidence(b.input, b.ctx, total.accountIds, 'income'),
    components: { categories: ['other_income'], account_ids: total.accountIds, row_count: total.rowCount },
  });
  return figure;
}

function buildCostOfSales(b: Builder): Figure {
  const total = totalOf(b, 'cost_of_sales');
  // CD-05: an organization with no cost-of-sales account does not have a zero cost of sales; it has
  // an unknown one. Reporting zero would hand it a 100% gross margin.
  const figure: Figure = b.hasCostOfSalesAccount
    ? coveredTotal(b, 'cost_of_sales')
    : {
      value: null,
      // ADR-104: when the organisation's purchase invoices DO carry cost of sales but the chosen
      // basis does not, the reason is that mismatch — not the absence of an account.
      quality: {
        ...b.baseQuality,
        missing: [b.input.costOfSalesInOtherSource ? 'cost_of_sales_in_other_source' : 'no_cost_of_sales_accounts'],
      },
      assurance: b.baseAssurance,
    };
  push(b, {
    key: 'cost_of_sales',
    unit: 'money',
    figure,
    evidence: b.hasCostOfSalesAccount
      ? leafEvidence(b.input, b.ctx, total.accountIds, 'expense')
      : null,
    components: {
      categories: ['cost_of_sales'],
      account_ids: total.accountIds,
      row_count: total.rowCount,
      has_cost_of_sales_account: b.hasCostOfSalesAccount,
    },
  });
  return figure;
}

/** True when cost of sales is NULL specifically because the organization has no such account. */
const COST_OF_SALES_ABSENT_CODES: readonly DataQualityMissing[] = ['no_cost_of_sales_accounts', 'cost_of_sales_in_other_source'];

function costOfSalesAbsentByDesign(costOfSales: Figure): boolean {
  return costOfSales.value === null
    && costOfSales.quality.missing.some((m) => COST_OF_SALES_ABSENT_CODES.includes(m));
}

function buildGrossProfit(b: Builder, revenue: Figure, costOfSales: Figure): Figure {
  const merged = mergeQuality([revenue.quality, costOfSales.quality]);
  const assurance = minAssurance(revenue.assurance, costOfSales.assurance);
  let figure: Figure;
  if (revenue.value === null) {
    figure = { value: null, quality: merged, assurance };
  } else if (costOfSalesAbsentByDesign(costOfSales)) {
    // §3.1: with no cost-of-sales account, gross profit IS revenue — stated with a warning so the
    // reader knows the line is missing rather than zero. `no_cost_of_sales_accounts` is dropped
    // from `missing` because this value is not missing.
    figure = {
      value: revenue.value,
      quality: {
        ...merged,
        warnings: uniqueInOrder([...merged.warnings, 'no_cost_of_sales']),
        missing: merged.missing.filter((m) => !COST_OF_SALES_ABSENT_CODES.includes(m)),
      },
      assurance,
    };
  } else if (costOfSales.value === null) {
    figure = { value: null, quality: merged, assurance };
  } else {
    figure = { value: subtract(revenue.value, costOfSales.value), quality: merged, assurance };
  }
  push(b, {
    key: 'gross_profit',
    unit: 'money',
    figure,
    evidence: derivedEvidence(b.resolve, [
      { name: 'revenue', key: 'revenue' },
      { name: 'cost_of_sales', key: 'cost_of_sales' },
    ]),
    components: { revenue: money(revenue.value), cost_of_sales: money(costOfSales.value) },
  });
  return figure;
}

function buildGrossMargin(
  b: Builder, grossProfit: Figure, revenue: Figure, costOfSales: Figure,
): Figure {
  // The "n/a, never 100%" case. Gross profit equals revenue here only because cost of sales is
  // unknown; dividing the two would publish a 100% margin for a business that simply never mapped
  // its costs.
  const figure: Figure = costOfSalesAbsentByDesign(costOfSales)
    ? {
      value: null,
      quality: {
        ...mergeQuality([grossProfit.quality, revenue.quality]),
        missing: ['no_cost_of_sales_accounts'],
      },
      assurance: minAssurance(grossProfit.assurance, revenue.assurance),
    }
    : marginOf(b, grossProfit, revenue);
  push(b, {
    key: 'gross_margin',
    unit: 'ratio',
    figure,
    evidence: derivedEvidence(b.resolve, [
      { name: 'gross_profit', key: 'gross_profit' },
      { name: 'revenue', key: 'revenue' },
    ]),
    components: { gross_profit: money(grossProfit.value), revenue: money(revenue.value) },
  });
  return figure;
}

function buildOperatingExpenses(b: Builder): Figure {
  const parts = OPEX_CATEGORIES.map((c) => ({ category: c, figure: coveredTotal(b, c) }));
  const merged = mergeQuality(parts.map((p) => p.figure.quality));
  const anyNull = parts.some((p) => p.figure.value === null);
  const value = anyNull ? null : sum(parts.map((p) => p.figure.value as Decimal));
  const figure: Figure = { value, quality: merged, assurance: b.baseAssurance };
  const accountIds = uniqueInOrder(
    OPEX_CATEGORIES.flatMap((c) => [...totalOf(b, c).accountIds]),
  ).sort();
  push(b, {
    key: 'operating_expenses',
    unit: 'money',
    figure,
    evidence: leafEvidence(b.input, b.ctx, accountIds, 'expense'),
    components: {
      categories: [...OPEX_CATEGORIES],
      account_ids: accountIds,
      ...Object.fromEntries(parts.map((p) => [p.category, money(p.figure.value)])),
    },
  });
  return figure;
}

function buildOperatingProfit(b: Builder, grossProfit: Figure, opex: Figure): Figure {
  const merged = mergeQuality([grossProfit.quality, opex.quality]);
  const value = grossProfit.value === null || opex.value === null
    ? null
    : subtract(grossProfit.value, opex.value);
  const figure: Figure = {
    value, quality: merged, assurance: minAssurance(grossProfit.assurance, opex.assurance),
  };
  push(b, {
    key: 'operating_profit',
    unit: 'money',
    figure,
    evidence: derivedEvidence(b.resolve, [
      { name: 'gross_profit', key: 'gross_profit' },
      { name: 'operating_expenses', key: 'operating_expenses' },
    ]),
    components: { gross_profit: money(grossProfit.value), operating_expenses: money(opex.value) },
  });
  return figure;
}

function buildMargin(
  b: Builder, key: string, numeratorKey: string, numerator: Figure, revenue: Figure,
): Figure {
  const figure = marginOf(b, numerator, revenue);
  push(b, {
    key,
    unit: 'ratio',
    figure,
    evidence: derivedEvidence(b.resolve, [
      { name: numeratorKey, key: numeratorKey },
      { name: 'revenue', key: 'revenue' },
    ]),
    components: { [numeratorKey]: money(numerator.value), revenue: money(revenue.value) },
  });
  return figure;
}

/** `other_expense`, `interest_expense`, `tax_expense` — the three lines below operating profit. */
function buildBelowLine(b: Builder): Readonly<Record<string, Figure>> {
  const out: Record<string, Figure> = {};
  for (const category of BELOW_LINE_CATEGORIES) {
    if (category === 'other_income') continue; // written by buildOtherIncome, above the line here.
    const figure = coveredTotal(b, category);
    const total = totalOf(b, category);
    push(b, {
      key: category,
      unit: 'money',
      figure,
      evidence: leafEvidence(b.input, b.ctx, total.accountIds, 'expense'),
      components: { categories: [category], account_ids: total.accountIds, row_count: total.rowCount },
    });
    out[category] = figure;
  }
  return out;
}

function buildNetProfit(
  b: Builder,
  operatingProfit: Figure,
  otherIncome: Figure,
  belowLine: Readonly<Record<string, Figure>>,
): Figure {
  const otherExpense = belowLine.other_expense as Figure;
  const interest = belowLine.interest_expense as Figure;
  const tax = belowLine.tax_expense as Figure;
  const inputs = [operatingProfit, otherIncome, otherExpense, interest, tax];
  const merged = mergeQuality(inputs.map((f) => f.quality));
  const anyNull = inputs.some((f) => f.value === null);
  const value = anyNull
    ? null
    : subtract(
      subtract(
        subtract(add(operatingProfit.value as Decimal, otherIncome.value as Decimal),
          otherExpense.value as Decimal),
        interest.value as Decimal),
      tax.value as Decimal,
    );
  // §3.1: a bank-basis P&L rarely sees a tax line at all, so net profit on that basis is a cash
  // proxy and says so.
  const warnings = b.input.basis.basis === 'bank'
    ? uniqueInOrder([...merged.warnings, 'cash_basis_proxy' as DataQualityWarning])
    : merged.warnings;
  const figure: Figure = {
    value,
    quality: { ...merged, warnings },
    assurance: inputs.reduce<AssuranceLevel>((a, f) => minAssurance(a, f.assurance), 'verified'),
  };
  push(b, {
    key: 'net_profit',
    unit: 'money',
    figure,
    evidence: derivedEvidence(b.resolve, [
      { name: 'operating_profit', key: 'operating_profit' },
      { name: 'other_income', key: 'other_income' },
      { name: 'other_expense', key: 'other_expense' },
      { name: 'interest_expense', key: 'interest_expense' },
      { name: 'tax_expense', key: 'tax_expense' },
    ]),
    components: {
      operating_profit: money(operatingProfit.value),
      other_income: money(otherIncome.value),
      other_expense: money(otherExpense.value),
      interest_expense: money(interest.value),
      tax_expense: money(tax.value),
    },
  });
  return figure;
}

/**
 * `contribution_margin = revenue − cost_of_sales − marketing`.
 *
 * DOCUMENTED SIMPLIFICATION (§3.1): marketing is treated as the only variable operating cost. A
 * proper contribution margin needs a variable/fixed split the product does not yet collect, so this
 * is the MVP stand-in and is pending product sign-off — not a definition to copy elsewhere.
 */
function buildContributionMargin(b: Builder, revenue: Figure, costOfSales: Figure): Figure {
  const marketing = coveredTotal(b, 'marketing');
  const absentByDesign = costOfSalesAbsentByDesign(costOfSales);
  const merged = mergeQuality([revenue.quality, costOfSales.quality, marketing.quality]);
  const warnings = absentByDesign
    ? uniqueInOrder([...merged.warnings, 'no_cost_of_sales' as DataQualityWarning])
    : merged.warnings;
  const missing = absentByDesign
    ? merged.missing.filter((m) => m !== 'no_cost_of_sales_accounts')
    : merged.missing;
  const cost = absentByDesign ? ZERO : costOfSales.value;
  const value = revenue.value === null || cost === null || marketing.value === null
    ? null
    : subtract(subtract(revenue.value, cost), marketing.value);
  const figure: Figure = {
    value,
    quality: { ...merged, warnings, missing },
    assurance: minAssurance(minAssurance(revenue.assurance, costOfSales.assurance), marketing.assurance),
  };
  push(b, {
    key: 'contribution_margin',
    unit: 'money',
    figure,
    evidence: derivedEvidence(b.resolve, [
      { name: 'revenue', key: 'revenue' },
      { name: 'cost_of_sales', key: 'cost_of_sales' },
      { name: 'marketing', key: 'expense_by_category', dimensionId: 'marketing' },
    ]),
    components: {
      revenue: money(revenue.value),
      cost_of_sales: money(cost),
      marketing: money(marketing.value),
      definition: 'revenue - cost_of_sales - marketing (MVP simplification, FINANCIAL_ENGINE.md §3.1)',
    },
  });
  return figure;
}

/**
 * One snapshot per category that HAS rows (§3.1). A category with no rows is not written: absence is
 * not zero, and a dashboard listing every category the platform knows about at £0 would bury the
 * four a reader cares about.
 */
function buildExpenseByCategory(b: Builder): void {
  for (const category of EXPENSE_BY_CATEGORY_CATEGORIES) {
    const total = totalOf(b, category);
    if (!total.present) continue;
    const figure: Figure = {
      value: total.value,
      quality: {
        completeness: b.baseQuality.completeness,
        proxy: b.baseQuality.proxy,
        warnings: uniqueInOrder([...b.baseQuality.warnings, ...total.warnings]),
        missing: total.value === null ? uniqueInOrder([...total.missing]) : [],
      },
      assurance: b.baseAssurance,
    };
    push(b, {
      key: 'expense_by_category',
      unit: 'money',
      figure,
      dimensionType: 'standard_category',
      // A category is a name, not a row: it travels in `dimensionKey` (ADR-053).
      dimensionId: null,
      dimensionKey: category,
      evidence: leafEvidence(
        b.input, b.ctx, total.accountIds,
        CATEGORY_ACCOUNT_TYPE[category] === 'income' ? 'income' : 'expense',
      ),
      components: { category, account_ids: total.accountIds, row_count: total.rowCount },
    });
  }
}

/**
 * One snapshot per expense-type account (§3.1), and only on a basis that HAS accounts.
 *
 * The bank basis categorises a transaction, it does not post it to a nominal account, so per-account
 * figures there would be an invention. It writes per category only.
 */
function buildExpenseByAccount(b: Builder): void {
  const basis = b.input.basis.basis;
  if (basis !== 'ledger' && basis !== 'period_balances') return;
  const accountType = new Map(b.input.accounts.map((a) => [a.id, a.accountType]));
  const byAccount = new Map<string, { category: StandardCategory; rows: AccountAmount[] }>();
  for (const amount of b.input.accountAmounts) {
    // An amount for an account the chart of accounts does not list falls back to the category's
    // type: the figure is real and must not silently disappear from the breakdown.
    const type = accountType.get(amount.accountId) ?? CATEGORY_ACCOUNT_TYPE[amount.category];
    if (type !== 'expense') continue;
    const group = byAccount.get(amount.accountId) ?? { category: amount.category, rows: [] };
    group.rows.push(amount);
    byAccount.set(amount.accountId, group);
  }
  const grouped = [...byAccount.entries()].sort((a, b2) => compareIds(a[0], b2[0]));
  for (const [accountId, group] of grouped) {
    const rows = group.rows;
    const anyNull = rows.some((r) => r.amount === null);
    const value = anyNull ? null : sum(rows.map((r) => r.amount as string));
    const rowMissing = rows.flatMap((r) => [...(r.missing ?? [])]);
    const figure: Figure = {
      value,
      quality: {
        completeness: b.baseQuality.completeness,
        proxy: b.baseQuality.proxy,
        warnings: uniqueInOrder([...b.baseQuality.warnings, ...rows.flatMap((r) => [...(r.warnings ?? [])])]),
        missing: anyNull
          ? uniqueInOrder(rowMissing.length > 0 ? rowMissing : ['no_source_covers_period'])
          : [],
      },
      assurance: b.baseAssurance,
    };
    push(b, {
      key: 'expense_by_account',
      unit: 'money',
      figure,
      dimensionType: 'account',
      dimensionId: accountId,
      evidence: leafEvidence(b.input, b.ctx, [accountId], 'expense'),
      components: {
        account_id: accountId,
        category: group.category,
        row_count: rows.reduce((n, r) => n + r.rowCount, 0),
      },
    });
  }
}
