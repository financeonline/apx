/**
 * Receivables, payables and working capital (FINANCIAL_ENGINE.md §3.4, ADR-027.3/.4, ADR-047.5/.10).
 *
 * Seven keys: `receivables`, `receivables_overdue`, `receivables_days`, `payables`,
 * `payables_overdue`, `payables_days`, `working_capital`.
 *
 * Three decisions carry most of the weight:
 *
 *  1. **Aging is as at an explicit date.** `asOf` is `P.period_end` for a historical period and the
 *     run's `asOf` for the current one, and which of the two was used is written into
 *     `components.as_of`. Nothing here reads a clock (§1.1).
 *  2. **Always the current invoice row** (ADR-047.10). There is no "row current at a historical
 *     `asOf`": a corrected total flows to every period, which is what makes receivables reconcile
 *     with revenue instead of drifting away from it. Time enters only through `paid_date`.
 *  3. **A days figure needs a gross-consistent denominator** (ADR-027.4). Receivables include VAT;
 *     revenue does not. Dividing one by the other without saying so overstates DSO by the VAT rate,
 *     so the choice is made explicitly and recorded in `components.denominator_basis`.
 */

import {
  Decimal,
  ROUND_HALF_UP,
  add,
  divide,
  isPositive,
  multiply,
  parseDecimal,
  sum,
  toMoneyString,
} from '@/core/money';
import { monthsBetween, yearMonthOf } from '@/core/periods';
import { weakestOf } from '@/core/assurance';
import type { InvoiceStatus, InvoiceType, StandardCategory } from '@/modules/financials';
import {
  combineBasis,
  dedupeCodes,
  derivedEvidence,
  leafEvidence,
  metricQuality,
  weakerAssurance,
  type PeriodMetrics,
} from './cash';
import type {
  AssuranceLevel,
  BasisChoice,
  DataQualityMissing,
  DataQualityWarning,
  EngineContext,
  EvidenceQuery,
  LeafDescriptor,
  MetricBasis,
  MetricResult,
  PeriodRef,
} from './types';

/** `365 / 4`: the number of days the three-month window of §3.4 stands for. */
export const DAYS_PER_QUARTER = '91.25';

const SALES_TYPES: readonly InvoiceType[] = ['sales', 'sales_credit_note'];
const PURCHASE_TYPES: readonly InvoiceType[] = ['purchase', 'purchase_credit_note'];

/** ADR-047.5: credit notes are stored positive and subtracted by type. */
const CREDIT_NOTE_TYPES: readonly InvoiceType[] = ['sales_credit_note', 'purchase_credit_note'];

/** §3.4: the balance-sheet terms of working capital, beyond cash, receivables and payables. */
export const WORKING_CAPITAL_ASSETS: readonly StandardCategory[] = ['inventory', 'other_current_asset'];
export const WORKING_CAPITAL_LIABILITIES: readonly StandardCategory[] = [
  'credit_card', 'tax_liability', 'other_current_liability',
];

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/**
 * The invoice fields aging needs. `Invoice` (`@/modules/financials`) satisfies it structurally; the
 * narrower shape keeps the domain function honest about what it actually reads, and keeps a test
 * fixture down to the ten fields that matter.
 *
 * The loader has already filtered to `record_status = 'accepted'` and `superseded_by IS NULL` (§1.3).
 */
export interface AgingInvoice {
  readonly id: string;
  readonly invoiceType: InvoiceType;
  readonly counterpartyId: string | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly totalAmount: string;
  readonly amountPaid: string;
  readonly balanceDue: string;
  readonly paidDate: string | null;
  readonly status: InvoiceStatus;
}

/** ADR-047.10: only a `full` list defines revenue and the DSO denominator. */
export type InvoiceListKind = 'full' | 'open_items';

/**
 * The two fallbacks of §3.4 when the invoice basis is unavailable, in precedence order.
 *
 * The ledger branch is deliberately gated on an opening balance: "the ledger family never reports
 * movements-since-import as a balance" (ADR-027.3). A GL exported from March does not know what was
 * owed in February, and summing its movements would present a fragment as a total.
 */
export interface CategoryBalanceFallback {
  /** Accounts carrying the category when the run executed, for the evidence descriptor (ADR-034). */
  readonly accountIds: readonly string[];
  /** `period_balances` closing balance of the category, in reporting sign. */
  readonly periodBalanceClosing?: string | null;
  /** The statement kind the closing came from; its descriptor pins it (ADR-123, audit F-6). */
  readonly periodBalanceKind?: 'trial_balance' | 'balance_sheet';
  readonly ledger?: { readonly openingBalance: string | null; readonly movements: string } | null;
  /**
   * Every period whose ledger rows the ledger figure summed (ADR-120). The ledger branch is
   * cumulative — opening journal plus every movement to P — so a descriptor naming only P re-selected
   * one month of a balance built from many and could never reconcile to it.
   */
  readonly ledgerPeriodIds?: readonly string[];
  /** The opening journal's date when it falls inside a month: the drill-down's first day (ADR-124 D-4). */
  readonly ledgerEntryDateFrom?: string;
  /** D-6 (FU-5): the statement month that anchors a ledger with no opening journal, and its kind. */
  readonly ledgerAnchor?: { readonly periodId: string; readonly kind: 'trial_balance' | 'balance_sheet' };
}

/** One balance-sheet term of `working_capital`, as `closing(P)` in reporting sign. */
export interface BalanceSheetTerm {
  readonly value: string;
  readonly basis: MetricBasis;
  readonly accountIds?: readonly string[];
}

/** The three-period denominators of §3.4, so a chunk boundary does not lose the window. */
export interface DenominatorInputs {
  /** Net `revenue` for the period (§3.1). */
  readonly revenue: string | null;
  /** ADR-133: the P&L basis revenue was stated on, which fixes its VAT footing. */
  readonly revenueBasis?: MetricBasis | null;
  /** Σ invoice `total_amount` net of credit notes, from `full` lists only (ADR-047.10). */
  readonly invoiceSalesTotal: string | null;
  /** `cost_of_sales + operating_expense + marketing` — payroll and depreciation never pass through AP. */
  readonly payablesExpenseBase: string | null;
  /** FU-9: the P&L basis the expense base was stated on, which fixes its VAT footing. */
  readonly payablesExpenseBasis?: MetricBasis | null;
  /**
   * FU-9: Σ purchase invoice GROSS totals (net + recorded tax, credit notes subtracted) from full
   * purchase lists establishing the period — the payables twin of `invoiceSalesTotal`.
   */
  readonly purchaseInvoiceGross?: string | null;
  /** An `open_items` invoice list covering the period makes the DSO denominator meaningless. */
  readonly hasOpenItemsList: boolean;
}

export interface ReceivablesPeriodInput extends DenominatorInputs {
  readonly period: PeriodRef;
  /** The AR/AP family's precedence outcome for this period (§2.3). */
  readonly basis: BasisChoice;
  /**
   * `false` for the current period, where aging is as at the run's `asOf` rather than the period end
   * (§3.4). The run decides which period is current; the domain never asks a clock.
   */
  readonly asOfIsPeriodEnd: boolean;
  /** The current rows of every non-void invoice, or null when the invoice basis does not cover P. */
  readonly invoices: readonly AgingInvoice[] | null;
  /**
   * Per-side overrides (ADR-120). A sales list and a purchase list are separate imports, so the
   * invoice basis can cover receivables and not payables: answering payables from a sales-only
   * upload would report a £0 nobody stated. When set, these replace `invoices` for their side.
   */
  readonly salesInvoices?: readonly AgingInvoice[] | null;
  readonly purchaseInvoices?: readonly AgingInvoice[] | null;
  /** Why each side's invoice basis is unavailable, when the caller knows. */
  readonly receivablesUnavailableReason?: DataQualityMissing;
  readonly payablesUnavailableReason?: DataQualityMissing;
  readonly receivablesFallback: CategoryBalanceFallback;
  readonly payablesFallback: CategoryBalanceFallback;
  /** Present only where a cumulative TB/BS covers P (§3.4). */
  readonly balanceSheetClosings: Readonly<Partial<Record<StandardCategory, BalanceSheetTerm>>>;
  /** `closing_cash` for the same period, from `computeCash`. */
  readonly closingCash: MetricResult | null;
  /** Why the invoice basis is unavailable, when the caller knows (e.g. `stale_invoice_data`). */
  readonly invoiceBasisUnavailableReason?: DataQualityMissing;
}

export interface ReceivablesSeriesOptions {
  /** Denominator inputs for the periods before the first input, oldest first. */
  readonly priorDenominators?: readonly DenominatorInputs[];
}

// ---------------------------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------------------------

interface BalanceResolution {
  readonly value: Decimal | null;
  readonly overdue: Decimal | null;
  readonly basis: MetricBasis;
  readonly assurance: AssuranceLevel;
  readonly warnings: readonly DataQualityWarning[];
  readonly missing: readonly DataQualityMissing[];
  readonly completeness: number;
  readonly components: Readonly<Record<string, unknown>>;
  readonly evidence: EvidenceQuery | null;
  readonly overdueEvidence: EvidenceQuery | null;
  /** True when aging is available at all — the balance fallbacks cannot age (§3.4). */
  readonly aged: boolean;
}

/**
 * What one invoice still owed at `asOf`.
 *
 * `paid_date > asOf` means the payment had not happened yet, so the whole invoice was outstanding.
 * A partial payment with no `paid_date` cannot be placed in time at all; §3.4 treats it as paid at
 * `asOf` — the alternative, treating it as unpaid, would inflate receivables on every invoice
 * somebody part-paid — and raises `payment_date_unknown` so the figure is not read as exact.
 */
function outstandingAt(
  invoice: Pick<AgingInvoice, 'paidDate' | 'totalAmount' | 'balanceDue'>,
  asOf: string,
): Decimal {
  if (invoice.paidDate !== null && invoice.paidDate > asOf) {
    return parseDecimal(invoice.totalAmount, 'total_amount');
  }
  return parseDecimal(invoice.balanceDue, 'balance_due');
}

function paymentDateUnknown(invoice: AgingInvoice): boolean {
  return invoice.paidDate === null && !parseDecimal(invoice.amountPaid, 'amount_paid').isZero();
}

/**
 * ADR-047.5: `Σ balance_due(sales) − Σ balance_due(sales_credit_note)`.
 *
 * Exported because it is THE rule for what one invoice contributes to receivables or payables at a
 * date, and the evidence resolver must total a drill-down on exactly this rule (ADR-120) — a second
 * copy there would be the second financial truth §1 forbids.
 */
export function invoiceOutstandingAt(
  invoice: Pick<AgingInvoice, 'invoiceType' | 'paidDate' | 'totalAmount' | 'balanceDue'>,
  asOf: string,
): Decimal {
  const outstanding = outstandingAt(invoice, asOf);
  return CREDIT_NOTE_TYPES.includes(invoice.invoiceType) ? outstanding.negated() : outstanding;
}

function signedOutstanding(invoice: AgingInvoice, asOf: string): Decimal {
  return invoiceOutstandingAt(invoice, asOf);
}

function fromInvoices(
  ctx: EngineContext,
  invoices: readonly AgingInvoice[],
  types: readonly InvoiceType[],
  asOf: string,
  basis: BasisChoice,
): BalanceResolution {
  // Sorted by id so the sum, the counts and the components never depend on row order (§1.1).
  const contributing = invoices
    .filter(
      (invoice) =>
        types.includes(invoice.invoiceType) &&
        invoice.status !== 'void' &&
        invoice.issueDate <= asOf,
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  let total = new Decimal(0);
  let overdue = new Decimal(0);
  let withoutDueDate = 0;
  let paymentDateUnknownCount = 0;
  /*
   * R-3 (owner decision): a payment with no date may or may not have happened by `asOf`. The figure
   * keeps §3.4's reading (paid), but it is `estimated` and states the range it could be in: an unpaid
   * sale would add what was paid back; an unrefunded credit note would take it off.
   */
  let couldBeHigher = new Decimal(0);
  let couldBeLower = new Decimal(0);
  let overdueCouldBeHigher = new Decimal(0);
  let overdueCouldBeLower = new Decimal(0);

  for (const invoice of contributing) {
    const signed = signedOutstanding(invoice, asOf);
    total = total.plus(signed);
    if (paymentDateUnknown(invoice)) {
      paymentDateUnknownCount += 1;
      const unplaced = parseDecimal(invoice.totalAmount, 'total_amount').minus(parseDecimal(invoice.balanceDue, 'balance_due'));
      const isCredit = CREDIT_NOTE_TYPES.includes(invoice.invoiceType);
      if (isCredit) couldBeLower = couldBeLower.plus(unplaced); else couldBeHigher = couldBeHigher.plus(unplaced);
      if (invoice.dueDate !== null && invoice.dueDate < asOf) {
        if (isCredit) overdueCouldBeLower = overdueCouldBeLower.plus(unplaced);
        else overdueCouldBeHigher = overdueCouldBeHigher.plus(unplaced);
      }
    }
    if (invoice.dueDate === null) {
      // §3.4: excluded from overdue and counted, never guessed at. An invoice with no due date is
      // not "not overdue" — it is unknown, and the count is what says so.
      withoutDueDate += 1;
      continue;
    }
    if (invoice.dueDate < asOf) overdue = overdue.plus(signed);
  }

  const warnings: DataQualityWarning[] = [...basis.warnings];
  if (withoutDueDate > 0) warnings.push('no_due_dates');
  if (paymentDateUnknownCount > 0) warnings.push('payment_date_unknown');

  const invoiceTypes = [...types].sort();
  return {
    value: total,
    overdue,
    basis: 'invoices',
    // R-3: an unplaced payment makes the figure an estimate, never `verified`.
    assurance: paymentDateUnknownCount > 0 ? weakestOf(basis.assurance, 'estimated') : basis.assurance,
    warnings,
    missing: [],
    // §5, AR/AP (invoices): `1 − (invoices without due_date / invoices)`.
    completeness: contributing.length === 0 ? 1 : 1 - withoutDueDate / contributing.length,
    components: {
      as_of: asOf,
      invoice_count: contributing.length,
      invoices_without_due_date: withoutDueDate,
      invoices_with_unknown_payment_date: paymentDateUnknownCount,
      // R-3: the range the figure could be in, had the undated payments not happened by `asOf`.
      ...(paymentDateUnknownCount > 0 ? {
        range_low: toMoneyString(total.minus(couldBeLower)),
        range_high: toMoneyString(total.plus(couldBeHigher)),
        overdue_range_low: toMoneyString(overdue.minus(overdueCouldBeLower)),
        overdue_range_high: toMoneyString(overdue.plus(overdueCouldBeHigher)),
      } : {}),
    },
    evidence: leafEvidence(ctx, 'invoices', { invoice_types: invoiceTypes, open_as_of: asOf }),
    overdueEvidence: leafEvidence(ctx, 'invoices', {
      invoice_types: invoiceTypes,
      overdue_as_of: asOf,
    }),
    aged: true,
  };
}

/**
 * The `period_balances` → `ledger` fallback (§3.4, §2.3).
 *
 * Both give a total and no aging, so `assurance = calculated` and the two overdue metrics are NULL.
 * When neither is available the answer is NULL with `no_opening_balance`, never zero.
 */
function fromBalances(
  ctx: EngineContext,
  fallback: CategoryBalanceFallback,
  period: PeriodRef,
  unavailableReason: DataQualityMissing | undefined,
): BalanceResolution {
  const base = {
    overdue: null,
    assurance: 'calculated' as AssuranceLevel,
    warnings: [] as readonly DataQualityWarning[],
    overdueEvidence: null,
    aged: false,
  };
  const accountIds = [...fallback.accountIds].sort();
  const descriptorFilters =
    accountIds.length > 0 ? { period_ids: [period.id], account_ids: accountIds } : { period_ids: [period.id] };

  const closing = fallback.periodBalanceClosing;
  if (closing !== null && closing !== undefined) {
    return {
      ...base,
      value: parseDecimal(closing, 'closing_balance'),
      basis: 'period_balances',
      missing: [],
      // §5, AR/AP (balances): a total with no aging behind it.
      completeness: 0.7,
      components: { source: 'period_balances', closing_balance: toMoneyString(closing), balance_kind: fallback.periodBalanceKind ?? null },
      evidence: leafEvidence(ctx, 'period_balances', fallback.periodBalanceKind === undefined
        ? descriptorFilters
        : { ...descriptorFilters, balance_kind: fallback.periodBalanceKind }),
    };
  }

  const ledger = fallback.ledger ?? null;
  if (ledger !== null && ledger.openingBalance !== null) {
    return {
      ...base,
      value: add(ledger.openingBalance, ledger.movements),
      basis: 'ledger',
      missing: [],
      completeness: 0.7,
      components: {
        source: 'ledger',
        opening_balance: toMoneyString(ledger.openingBalance),
        movements: toMoneyString(ledger.movements),
      },
      evidence: fallback.ledgerAnchor !== undefined
        // D-6 (FU-5): two selections — the anchoring statement's lines, and the ledger rows since —
        // whose totals add to the figure; each reconciles to its own part, then the sum.
        ? {
          kind: 'difference',
          formula: 'opening_balance + movements',
          terms: [
            {
              name: 'opening_balance', sign: 1, period_id: fallback.ledgerAnchor.periodId, unavailable: null,
              expected: toMoneyString(ledger.openingBalance),
              descriptor: (leafEvidence(ctx, 'period_balances', {
                period_ids: [fallback.ledgerAnchor.periodId], ...(accountIds.length > 0 ? { account_ids: accountIds } : {}),
                balance_kind: fallback.ledgerAnchor.kind,
              }) as { descriptor: LeafDescriptor }).descriptor,
            },
            {
              name: 'movements', sign: 1, period_id: null, unavailable: null,
              expected: toMoneyString(ledger.movements),
              descriptor: (leafEvidence(ctx, 'ledger_entries', {
                ...descriptorFilters,
                period_ids: [...(fallback.ledgerPeriodIds ?? [period.id])].sort(),
              }) as { descriptor: LeafDescriptor }).descriptor,
            },
          ],
        }
        : leafEvidence(ctx, 'ledger_entries', {
          ...descriptorFilters,
          period_ids: [...(fallback.ledgerPeriodIds ?? [period.id])].sort(),
          ...(fallback.ledgerEntryDateFrom ? { entry_date_from: fallback.ledgerEntryDateFrom } : {}),
        }),
    };
  }

  return {
    ...base,
    value: null,
    basis: 'none',
    missing: [unavailableReason ?? 'no_opening_balance'],
    completeness: 0,
    components: {
      source: 'none',
      ledger_movements_seen: ledger === null ? null : toMoneyString(ledger.movements),
    },
    evidence: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------------------------

export type DenominatorBasis =
  | 'invoice_total_gross'
  | 'revenue_net_of_vat'
  | 'revenue_vat_unknown'
  | 'revenue_gross'
  | 'expense_categories'
  | 'expense_categories_gross'
  | 'purchase_invoice_total_gross';

/** The label recorded in `components.denominator_basis` before the VAT branch refines it. */
function denominatorLabel(useInvoiceTotals: boolean): DenominatorBasis {
  return useInvoiceTotals ? 'invoice_total_gross' : 'revenue_gross';
}

interface DaysOutcome {
  readonly value: Decimal | null;
  readonly components: Readonly<Record<string, unknown>>;
  readonly warnings: readonly DataQualityWarning[];
  readonly missing: readonly DataQualityMissing[];
}

/** Days are integers (§1.4). Rounded once, here, at the metric's own boundary. */
function toDaysString(value: Decimal): string {
  return value.toDecimalPlaces(0, ROUND_HALF_UP).toFixed(0);
}

/**
 * `balance / Σ flow(3 periods) × 91.25`, with both sides on the same VAT footing (ADR-027.4, ADR-133).
 *
 * The receivable is VAT-inclusive (what customers owe includes the VAT charged). When it comes from
 * invoices the denominator is the same lists' Σ `total_amount` — gross, the same population. Otherwise
 * the denominator is revenue, used only when its footing is gross (`vatFooting`); a net or unknown
 * footing is NULL `vat_basis_unknown`. The receivable is never netted down by `default_vat_rate`: one
 * rate cannot describe zero-rated, exempt and reduced-rate sales, and nothing records which those are
 * (ADR-133 withdraws ADR-027.4's netting).
 */
function daysFrom(
  numerator: Decimal | null,
  window: readonly DenominatorInputs[] | null,
  useInvoiceTotals: boolean,
  settings: EngineContext['settings'],
): DaysOutcome {
  if (window === null) {
    return { value: null, components: {}, warnings: [], missing: ['insufficient_history'] };
  }
  if (window.some((entry) => entry.hasOpenItemsList)) {
    // ADR-047.10: an aged-debtors list is not a sales history; using it as one understates sales and
    // so overstates DSO, sometimes by a multiple.
    return {
      value: null,
      components: { denominator_basis: denominatorLabel(useInvoiceTotals) },
      warnings: [],
      missing: ['open_items_only'],
    };
  }

  const basis: DenominatorBasis = useInvoiceTotals ? 'invoice_total_gross' : 'revenue_gross';
  const raw = window.map((entry) => (useInvoiceTotals ? entry.invoiceSalesTotal : entry.revenue));
  const stated = raw.filter((value): value is string => value !== null);
  if (stated.length < raw.length || numerator === null) {
    return { value: null, components: { denominator_basis: basis }, warnings: [], missing: ['insufficient_history'] };
  }
  if (!useInvoiceTotals) {
    const footings = window.map((entry) => vatFooting(entry.revenueBasis, settings));
    if (footings.some((f) => f !== 'gross')) {
      return {
        value: null,
        components: { denominator_basis: basis, revenue_footings: footings, receivables_footing: 'gross' },
        warnings: [],
        missing: ['vat_basis_unknown'],
      };
    }
  }

  const denominator = sum(stated);
  const components = {
    denominator_basis: basis,
    denominator: toMoneyString(denominator),
    numerator: toMoneyString(numerator),
    days_in_window: DAYS_PER_QUARTER,
  };
  if (!isPositive(denominator)) {
    // A quarter with no sales gives no meaningful days figure. §3.4: "Σ ≤ 0 → NULL".
    return { value: null, components, warnings: [], missing: ['comparison_is_zero'] };
  }
  const ratio = divide(numerator, denominator);
  if (ratio === null) return { value: null, components, warnings: [], missing: ['comparison_is_zero'] };
  return { value: multiply(ratio, DAYS_PER_QUARTER), components, warnings: [], missing: [] };
}

/**
 * The VAT footing of a FLOW the days figures divide by — revenue for `receivables_days`, the expense
 * base for `payables_days` — from the P&L basis that stated it (ADR-129, ADR-133). Recorded facts only:
 *
 *   - ledger / trial balance / P&L report: a VAT-registered business books its sales and costs net and
 *     the VAT through the VAT account — `net`; a business that is not registered charges and reclaims
 *     none — `gross`; when nobody has said which (`vatStatusKnown === false`) — `unknown`;
 *   - invoices: `app.invoice_net` strips each invoice's recorded tax — `net`;
 *   - bank: money as it moved, VAT included — `gross` — UNLESS the proxy netted it down by the
 *     organisation's default rate (registered, with a rate: CD-33), which is an assumption about every
 *     line, not a record of any — `unknown`;
 *   - mixed or none: `unknown`.
 */
export function vatFooting(
  basis: MetricBasis | null | undefined,
  settings: EngineContext['settings'],
): 'gross' | 'net' | 'unknown' {
  switch (basis) {
    case 'bank':
      return settings.vatRegistered && settings.defaultVatRate !== null ? 'unknown' : 'gross';
    case 'invoices': return 'net';
    case 'ledger':
    case 'period_balances':
      if (settings.vatStatusKnown === false) return 'unknown';
      return settings.vatRegistered ? 'net' : 'gross';
    default: return 'unknown';
  }
}

/** @deprecated name kept for the FU-9 tests: the expense base's footing is `vatFooting`. */
export const expenseBaseFooting = vatFooting;

/**
 * `payables_days`: what is owed to suppliers over three months of what was bought, ×91.25 — with
 * BOTH sides on the same VAT footing, from recorded data only (FU-9, ADR-129).
 *
 * What is owed is always VAT-inclusive: an invoice's `balance_due` and an AP control balance both
 * carry the VAT the supplier charged. So the denominator must be too:
 *
 *   - payables from INVOICES divide by the same lists' GROSS totals (net + recorded tax, credit notes
 *     subtracted), the twin of `receivables_days` over `invoice_total_gross` (ADR-027.4). Every rate,
 *     a zero rate and an invoice with no tax column all read correctly: each row's gross is what the
 *     supplier billed. All three months need a full purchase list, else `insufficient_history`.
 *   - payables from a BALANCE or the LEDGER divide by cost of sales + operating expense + marketing
 *     (ADR-027.5) only when that base is gross too (`expenseBaseFooting`). A net base — a VAT-registered
 *     business's ledger, or invoice nets — or an unknown one gives NULL `vat_basis_unknown`.
 *
 * No rate is ever assumed: dividing by `default_vat_rate` (or 1.2) would be wrong for every zero-rated,
 * exempt or reduced-rate purchase, and nothing records which those are. The ratio this replaces put a
 * VAT-inclusive balance over a VAT-exclusive base and overstated days by the VAT rate, unflagged.
 */
function payablesDaysFrom(
  numerator: Decimal | null,
  window: readonly DenominatorInputs[] | null,
  payablesBasis: MetricBasis,
  settings: EngineContext['settings'],
): DaysOutcome {
  if (window === null || numerator === null) {
    return { value: null, components: {}, warnings: [], missing: ['insufficient_history'] };
  }

  let basis: 'purchase_invoice_total_gross' | 'expense_categories_gross';
  let raw: ReadonlyArray<string | null>;
  if (payablesBasis === 'invoices') {
    basis = 'purchase_invoice_total_gross';
    raw = window.map((entry) => entry.purchaseInvoiceGross ?? null);
  } else {
    basis = 'expense_categories_gross';
    const footings = window.map((entry) => vatFooting(entry.payablesExpenseBasis, settings));
    if (window.every((entry) => entry.payablesExpenseBase !== null) && footings.some((f) => f !== 'gross')) {
      return {
        value: null,
        components: { denominator_basis: basis, expense_base_footings: footings, payables_footing: 'gross' },
        warnings: [],
        missing: ['vat_basis_unknown'],
      };
    }
    raw = window.map((entry) => entry.payablesExpenseBase);
  }

  const components = { denominator_basis: basis as DenominatorBasis, days_in_window: DAYS_PER_QUARTER };
  const stated = raw.filter((value): value is string => value !== null);
  if (stated.length < raw.length) {
    return { value: null, components, warnings: [], missing: ['insufficient_history'] };
  }
  const denominator = sum(stated);
  const full = { ...components, denominator: toMoneyString(denominator), numerator: toMoneyString(numerator) };
  if (!isPositive(denominator)) {
    return { value: null, components: full, warnings: [], missing: ['comparison_is_zero'] };
  }
  const ratio = divide(numerator, denominator);
  if (ratio === null) return { value: null, components: full, warnings: [], missing: ['comparison_is_zero'] };
  return { value: multiply(ratio, DAYS_PER_QUARTER), components: full, warnings: [], missing: [] };
}

// ---------------------------------------------------------------------------------------------
// The series
// ---------------------------------------------------------------------------------------------

/**
 * Compute the seven AR/AP keys for every input period.
 *
 * A series rather than a period at a time, because `receivables_days` and `payables_days` need the
 * three-month flow window ending at P, and the window has to survive a chunk boundary
 * (`options.priorDenominators`).
 */
export function computeReceivables(
  ctx: EngineContext,
  inputs: readonly ReceivablesPeriodInput[],
  options: ReceivablesSeriesOptions = {},
): readonly PeriodMetrics[] {
  const ordered = [...inputs].sort(
    (a, b) =>
      a.period.periodStart.localeCompare(b.period.periodStart) || a.period.id.localeCompare(b.period.id),
  );
  const prior = options.priorDenominators ?? [];

  return ordered.map((input, index) => {
    const { period } = input;
    const asOf = input.asOfIsPeriodEnd ? period.periodEnd : ctx.asOf;
    const currency = ctx.settings.baseCurrency;

    const salesInvoices = input.salesInvoices === undefined ? input.invoices : input.salesInvoices;
    const purchaseInvoices = input.purchaseInvoices === undefined ? input.invoices : input.purchaseInvoices;
    const receivables =
      salesInvoices === null
        ? fromBalances(ctx, input.receivablesFallback, period,
            input.receivablesUnavailableReason ?? input.invoiceBasisUnavailableReason)
        : fromInvoices(ctx, salesInvoices, SALES_TYPES, asOf, input.basis);
    const payables =
      purchaseInvoices === null
        ? fromBalances(ctx, input.payablesFallback, period,
            input.payablesUnavailableReason ?? input.invoiceBasisUnavailableReason)
        : fromInvoices(ctx, purchaseInvoices, PURCHASE_TYPES, asOf, input.basis);

    const asOfComponents = {
      as_of: asOf,
      as_of_source: input.asOfIsPeriodEnd ? 'period_end' : 'run_as_of',
    };

    const window = denominatorWindow(ordered, prior, index);
    const receivablesDays = daysFrom(receivables.value, window, receivables.basis === 'invoices', ctx.settings);
    const payablesDays = payablesDaysFrom(payables.value, window, payables.basis, ctx.settings);

    const metrics: MetricResult[] = [
      balanceMetric('receivables', receivables, asOfComponents, currency),
      overdueMetric('receivables_overdue', receivables, asOfComponents, currency),
      daysMetric('receivables_days', receivables, receivablesDays, asOfComponents),
      balanceMetric('payables', payables, asOfComponents, currency),
      overdueMetric('payables_overdue', payables, asOfComponents, currency),
      daysMetric('payables_days', payables, payablesDays, asOfComponents),
      workingCapital(input, receivables, payables, currency),
    ];
    return { periodId: period.id, metrics };
  });
}

/** The three consecutive months ending at `index`, or null when they are not all available. */
function denominatorWindow(
  ordered: readonly ReceivablesPeriodInput[],
  prior: readonly DenominatorInputs[],
  index: number,
): readonly DenominatorInputs[] | null {
  const window: DenominatorInputs[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const at = index - offset;
    if (at >= 0) {
      const entry = ordered[at];
      if (entry === undefined) return null;
      const next = ordered[at + 1];
      if (
        next !== undefined &&
        monthsBetween(yearMonthOf(entry.period.periodStart), yearMonthOf(next.period.periodStart)) !== 1
      ) {
        return null;
      }
      window.push(entry);
      continue;
    }
    const carried = prior[prior.length + at];
    if (carried === undefined) return null;
    window.push(carried);
  }
  return window;
}

function balanceMetric(
  key: 'receivables' | 'payables',
  resolution: BalanceResolution,
  asOfComponents: Readonly<Record<string, unknown>>,
  currency: string,
): MetricResult {
  return {
    key,
    value: resolution.value === null ? null : toMoneyString(resolution.value),
    unit: 'money',
    basis: resolution.basis,
    assurance: resolution.assurance,
    dimensionType: 'none',
    dimensionId: null,
    currency,
    components: { ...asOfComponents, ...resolution.components },
    dataQuality: metricQuality(resolution.completeness, resolution.warnings, resolution.missing),
    evidenceQuery: resolution.evidence,
  };
}

/**
 * Overdue exists only on the invoice basis: a category total carries no due dates, so it cannot be
 * aged (§3.4, "aging metrics NULL, assurance = calculated"). `no_due_dates` is the reason recorded,
 * because that is literally what is absent.
 */
function overdueMetric(
  key: 'receivables_overdue' | 'payables_overdue',
  resolution: BalanceResolution,
  asOfComponents: Readonly<Record<string, unknown>>,
  currency: string,
): MetricResult {
  // `overdue` is null exactly when the resolution came from a balance rather than from invoices, so
  // the two conditions are one condition; keeping them separate would imply a third state.
  const overdue = resolution.aged ? resolution.overdue : null;
  return {
    key,
    value: overdue === null ? null : toMoneyString(overdue),
    unit: 'money',
    basis: resolution.basis,
    assurance: resolution.assurance,
    dimensionType: 'none',
    dimensionId: null,
    currency,
    components: { ...asOfComponents, ...resolution.components },
    dataQuality: metricQuality(
      resolution.completeness,
      resolution.warnings,
      overdue === null ? dedupeCodes([...resolution.missing, 'no_due_dates']) : resolution.missing,
    ),
    evidenceQuery: resolution.overdueEvidence,
  };
}

function daysMetric(
  key: 'receivables_days' | 'payables_days',
  resolution: BalanceResolution,
  outcome: DaysOutcome,
  asOfComponents: Readonly<Record<string, unknown>>,
): MetricResult {
  return {
    key,
    value: outcome.value === null ? null : toDaysString(outcome.value),
    unit: 'days',
    basis: resolution.basis,
    assurance: resolution.assurance,
    dimensionType: 'none',
    dimensionId: null,
    currency: null,
    components: { ...asOfComponents, ...outcome.components },
    dataQuality: metricQuality(
      resolution.completeness,
      [...resolution.warnings, ...outcome.warnings],
      dedupeCodes([...resolution.missing, ...outcome.missing]),
    ),
    evidenceQuery: derivedEvidence([
      key === 'receivables_days' ? 'receivables' : 'payables',
      key === 'receivables_days' ? 'revenue' : 'operating_expenses',
    ]),
  };
}

/**
 * `working_capital` = cash + receivables + inventory + other current assets − payables − card −
 * tax − other current liabilities (§3.4).
 *
 * A missing balance-sheet-only term (inventory, other current assets, card, tax, other current
 * liabilities) is *unknown*, not zero: the metric is still written — a working capital figure
 * without inventory is useful to a service business and honest about what it omits — with
 * `partial_working_capital` naming every term that could not be seen.
 *
 * `closing_cash`, `receivables` and `payables` are different: they are the terms the figure is
 * mostly about, and each has a source of its own. When any of them is unknown the figure is NULL
 * with that term's reasons (ADR-120). Leaving an unknown receivables balance out of the sum would
 * add it in as zero — the fabricated £0 §1.5 forbids.
 */
function workingCapital(
  input: ReceivablesPeriodInput,
  receivables: BalanceResolution,
  payables: BalanceResolution,
  currency: string,
): MetricResult {
  const cash = input.closingCash;
  const cashValue = cash?.value ?? null;

  const terms: Array<{ name: string; sign: 1 | -1; value: Decimal | null; basis: MetricBasis }> = [
    { name: 'closing_cash', sign: 1, value: cashValue === null ? null : parseDecimal(cashValue), basis: cash?.basis ?? 'none' },
    { name: 'receivables', sign: 1, value: receivables.value, basis: receivables.basis },
    ...WORKING_CAPITAL_ASSETS.map((category) => termOf(input, category, 1)),
    { name: 'payables', sign: -1 as const, value: payables.value, basis: payables.basis },
    ...WORKING_CAPITAL_LIABILITIES.map((category) => termOf(input, category, -1)),
  ];

  const missingTerms = terms.filter((term) => term.value === null).map((term) => term.name).sort();
  const knownTerms = terms.filter((term) => term.value !== null);

  const componentValues: Record<string, unknown> = {};
  for (const term of terms) {
    componentValues[term.name] = term.value === null ? null : toMoneyString(term.value);
  }
  componentValues.bases = Object.fromEntries(terms.map((term) => [term.name, term.basis]));
  componentValues.missing_terms = missingTerms;

  const inputCompleteness = [
    cash?.dataQuality.completeness ?? 0,
    receivables.completeness,
    payables.completeness,
  ];
  const baseCompleteness = Math.min(...inputCompleteness) * (knownTerms.length / terms.length);
  const warnings: DataQualityWarning[] = [
    ...(cash?.dataQuality.warnings ?? []),
    ...receivables.warnings,
    ...payables.warnings,
  ];
  if (missingTerms.length > 0) warnings.push('partial_working_capital');

  const assurance = weakerAssurance(
    weakerAssurance(cash?.assurance ?? 'calculated', receivables.assurance),
    payables.assurance,
  );
  const basis = combineBasis(knownTerms.map((term) => term.basis));

  const requiredUnknown = cashValue === null || receivables.value === null || payables.value === null;
  if (requiredUnknown) {
    return {
      key: 'working_capital',
      value: null,
      unit: 'money',
      basis,
      assurance,
      dimensionType: 'none',
      dimensionId: null,
      currency,
      components: componentValues,
      dataQuality: metricQuality(
        baseCompleteness,
        warnings,
        dedupeCodes([
          ...(cashValue === null ? (cash?.dataQuality.missing ?? ['no_opening_cash']) : []),
          ...receivables.missing,
          ...payables.missing,
        ]),
      ),
      evidenceQuery: derivedEvidence(terms.map((term) => term.name)),
    };
  }

  let total = new Decimal(0);
  for (const term of terms) {
    if (term.value === null) continue;
    total = term.sign === 1 ? total.plus(term.value) : total.minus(term.value);
  }

  return {
    key: 'working_capital',
    value: toMoneyString(total),
    unit: 'money',
    basis,
    assurance,
    dimensionType: 'none',
    dimensionId: null,
    currency,
    components: componentValues,
    dataQuality: metricQuality(baseCompleteness, warnings, []),
    evidenceQuery: derivedEvidence(terms.map((term) => term.name)),
  };
}

function termOf(
  input: ReceivablesPeriodInput,
  category: StandardCategory,
  sign: 1 | -1,
): { name: string; sign: 1 | -1; value: Decimal | null; basis: MetricBasis } {
  const term = input.balanceSheetClosings[category];
  return {
    name: category,
    sign,
    value: term === undefined ? null : parseDecimal(term.value, category),
    basis: term?.basis ?? 'none',
  };
}
