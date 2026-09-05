/**
 * Customer and supplier metrics (FINANCIAL_ENGINE.md §3.5, CD-08, ADR-034).
 *
 * Nine keys: `customer_revenue`, `customer_contribution`, `customer_revenue_share`,
 * `customer_concentration_top1`, `customer_concentration_top5`, `revenue_concentration_hhi`,
 * `supplier_spend`, `supplier_concentration_top1`, `supplier_concentration_top5`.
 *
 * The rule that keeps the family honest is **Unattributed**. Revenue that carries no counterparty is
 * written as a synthetic snapshot with `dimension_id = NULL` labelled "Unattributed", so
 * `Σ customer_revenue + unattributed = revenue` exactly. Without it, concentration would be computed
 * over the attributed slice alone and a business with one named customer and nine anonymous card
 * receipts would be told it has 100% concentration.
 *
 * Merged counterparties roll up to their survivor (`merged_into_id`), following the chain to its end
 * — Acme Ltd merged into Acme Limited merged into Acme is one customer, not three.
 */

import { Decimal, divide, isPositive, parseDecimal, toMoneyString, toRatioString } from '@/core/money';
import {
  combineBasis,
  derivedEvidence,
  leafEvidence,
  metricQuality,
  type PeriodMetrics,
} from './cash';
import type {
  AssuranceLevel,
  BasisChoice,
  CounterpartyRef,
  DataQualityWarning,
  EngineContext,
  EvidenceQuery,
  LeafDescriptor,
  MetricResult,
  PeriodRef,
} from './types';

/** §3.5: the counterparty kinds each side of the business is drawn from. */
export const CUSTOMER_KINDS: readonly CounterpartyRef['kind'][] = ['customer', 'both'];
export const SUPPLIER_KINDS: readonly CounterpartyRef['kind'][] = ['supplier', 'both'];

/** §3.5: an Unattributed share above this makes every concentration figure an estimate. */
export const HIGH_UNATTRIBUTED_SHARE = 0.5;

/** The label the UI shows for the synthetic `dimension_id = NULL` snapshot. */
export const UNATTRIBUTED_LABEL = 'Unattributed';

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/**
 * One counterparty's amount for the period, already in reporting sign (revenue positive, spend
 * positive).
 *
 * The sign convention of §3 belongs to the basis, not to this family — a ledger credit to a revenue
 * account and a bank inflow are the same money expressed two ways — so the caller applies it once
 * and this file never re-derives it. `counterpartyId = null` is the unattributed remainder.
 */
export interface CounterpartyAmount {
  readonly counterpartyId: string | null;
  readonly amount: string;
}

export interface ConcentrationPeriodInput {
  readonly period: PeriodRef;
  /** The counterparty family's precedence outcome for this period (§2.3, as P&L). */
  readonly basis: BasisChoice;
  readonly customerRevenue: readonly CounterpartyAmount[];
  /**
   * CD-08: costs carrying this `counterparty_id` **as a customer cost**. Absent or zero →
   * `customer_contribution` equals `customer_revenue` and carries `no_cost_allocation`, which is what
   * lets the UI label it "revenue contribution" rather than pretend a margin was computed.
   */
  readonly customerAttributableCosts?: readonly CounterpartyAmount[];
  readonly supplierSpend: readonly CounterpartyAmount[];
  /**
   * The period's `revenue` metric. Shares are taken against it and the unattributed remainder is
   * derived from it, so the reconciliation of §3.5 holds by construction rather than by luck.
   */
  readonly revenue: MetricResult | null;
  /** Accounts carrying `revenue` when the run executed, for the descriptors (ADR-034). */
  readonly revenueAccountIds: readonly string[];
  /** Accounts carrying `cost_of_sales ∪ OPEX_SET` when the run executed. */
  readonly expenseAccountIds: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Merge resolution
// ---------------------------------------------------------------------------------------------

/**
 * Follow `merged_into_id` to the surviving counterparty.
 *
 * A merge chain is ordinary (a duplicate merged into a duplicate that was itself merged); a merge
 * *cycle* is corrupt data, and following it would hang the run. The cycle is broken deterministically
 * on its lowest id, so the same corrupt data always produces the same snapshot rather than a figure
 * that depends on which row the loader happened to start from.
 */
export function resolveSurvivor(
  id: string,
  byId: ReadonlyMap<string, CounterpartyRef>,
): string {
  const path: string[] = [id];
  let current = id;
  for (;;) {
    const next = byId.get(current)?.mergedIntoId ?? null;
    if (next === null || next === current) return current;
    const seenAt = path.indexOf(next);
    if (seenAt >= 0) {
      const cycle = [...path.slice(seenAt)].sort();
      return cycle[0] ?? current;
    }
    path.push(next);
    current = next;
  }
}

// ---------------------------------------------------------------------------------------------
// Rolling up
// ---------------------------------------------------------------------------------------------

interface RolledUp {
  /** Attributed totals per survivor, ordered by amount descending then id, for stable top-n. */
  readonly attributed: ReadonlyArray<{ id: string; amount: Decimal }>;
  readonly attributedTotal: Decimal;
  readonly unattributed: Decimal;
  readonly total: Decimal;
}

/**
 * Roll amounts up to survivors, dropping counterparties outside the set into Unattributed.
 *
 * A revenue row against a counterparty whose `kind` is `supplier` or `unknown` is not a customer's
 * revenue, but it *is* the organization's revenue: putting it in Unattributed is the only treatment
 * that keeps `Σ customer_revenue + unattributed = revenue` while leaving the customer set correct.
 */
function rollUp(
  amounts: readonly CounterpartyAmount[],
  counterparties: readonly CounterpartyRef[],
  kinds: readonly CounterpartyRef['kind'][],
  overallTotal: Decimal | null,
): RolledUp {
  const byId = new Map(counterparties.map((counterparty) => [counterparty.id, counterparty]));
  const totals = new Map<string, Decimal>();
  let unattributed = new Decimal(0);
  let attributedTotal = new Decimal(0);

  for (const entry of [...amounts].sort(
    (a, b) => (a.counterpartyId ?? '').localeCompare(b.counterpartyId ?? ''),
  )) {
    const amount = parseDecimal(entry.amount, 'amount');
    const survivorId = entry.counterpartyId === null ? null : resolveSurvivor(entry.counterpartyId, byId);
    const survivor = survivorId === null ? undefined : byId.get(survivorId);
    if (survivorId === null || survivor === undefined || !kinds.includes(survivor.kind)) {
      unattributed = unattributed.plus(amount);
      continue;
    }
    totals.set(survivorId, (totals.get(survivorId) ?? new Decimal(0)).plus(amount));
    attributedTotal = attributedTotal.plus(amount);
  }

  const attributed = [...totals.entries()]
    .map(([id, amount]) => ({ id, amount }))
    .sort((a, b) => b.amount.comparedTo(a.amount) || a.id.localeCompare(b.id));

  // §3.5: the remainder is taken from `revenue` so the identity is exact. Where no total is supplied
  // (no covering P&L metric) the rows themselves are all that is known.
  const total = overallTotal ?? attributedTotal.plus(unattributed);
  const remainder = overallTotal === null ? unattributed : overallTotal.minus(attributedTotal);

  return { attributed, attributedTotal, unattributed: remainder, total };
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

function counterpartyEvidence(
  ctx: EngineContext,
  input: ConcentrationPeriodInput,
  counterpartyId: string | null,
  side: 'customer' | 'supplier',
): EvidenceQuery | null {
  // The Unattributed row is the *absence* of a counterparty. A v1 descriptor cannot express "rows
  // with no counterparty" (`counterparty_ids` is a non-empty id list, ADR-034), and a descriptor
  // without the filter would re-select every row — evidence that reconciles to the wrong number is
  // worse than none, so the synthetic snapshot carries none.
  if (counterpartyId === null) return null;
  const accountIds = side === 'customer' ? input.revenueAccountIds : input.expenseAccountIds;
  const filters: LeafDescriptor['filters'] = { period_ids: [input.period.id], counterparty_ids: [counterpartyId] };

  switch (input.basis.basis) {
    case 'invoices':
      return leafEvidence(ctx, 'invoices', {
        ...filters,
        invoice_types:
          side === 'customer'
            ? ['sales', 'sales_credit_note']
            : ['purchase', 'purchase_credit_note'],
      });
    case 'ledger':
      return leafEvidence(ctx, 'ledger_entries', { ...filters, account_ids: [...accountIds].sort() });
    case 'bank':
      return leafEvidence(ctx, 'bank_transactions', {
        ...filters,
        category_account_ids: [...accountIds].sort(),
        direction: side === 'customer' ? 'inflow' : 'outflow',
        exclude_cash_transfers: true,
      });
    default:
      // `period_balances` carries no counterparty, so this family never resolves to it (§2.3).
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------------------------

/**
 * Compute the customer and supplier family for every input period.
 *
 * Each period is independent — nothing here needs a trailing window — but the signature matches the
 * other two families so the run can treat them alike.
 */
export function computeConcentration(
  ctx: EngineContext,
  inputs: readonly ConcentrationPeriodInput[],
): readonly PeriodMetrics[] {
  return [...inputs]
    .sort(
      (a, b) =>
        a.period.periodStart.localeCompare(b.period.periodStart) ||
        a.period.id.localeCompare(b.period.id),
    )
    .map((input) => ({ periodId: input.period.id, metrics: computePeriod(ctx, input) }));
}

function computePeriod(ctx: EngineContext, input: ConcentrationPeriodInput): MetricResult[] {
  const currency = ctx.settings.baseCurrency;
  const revenueValue = input.revenue?.value ?? null;
  const revenueTotal = revenueValue === null ? null : parseDecimal(revenueValue);

  const customers = rollUp(input.customerRevenue, ctx.counterparties, CUSTOMER_KINDS, revenueTotal);
  const suppliers = rollUp(input.supplierSpend, ctx.counterparties, SUPPLIER_KINDS, null);

  const costsBySurvivor = attributableCosts(input, ctx.counterparties);

  return [
    ...customerAmounts(ctx, input, customers, costsBySurvivor, currency),
    ...concentration(input, customers, 'customer'),
    ...supplierAmounts(ctx, input, suppliers, currency),
    ...concentration(input, suppliers, 'supplier'),
  ];
}

function attributableCosts(
  input: ConcentrationPeriodInput,
  counterparties: readonly CounterpartyRef[],
): ReadonlyMap<string, Decimal> {
  const byId = new Map(counterparties.map((counterparty) => [counterparty.id, counterparty]));
  const totals = new Map<string, Decimal>();
  for (const entry of input.customerAttributableCosts ?? []) {
    if (entry.counterpartyId === null) continue;
    const survivorId = resolveSurvivor(entry.counterpartyId, byId);
    totals.set(
      survivorId,
      (totals.get(survivorId) ?? new Decimal(0)).plus(parseDecimal(entry.amount, 'amount')),
    );
  }
  return totals;
}

/** §5, customer/supplier family: `completeness = 1 − unattributed share`. */
function completenessOf(rolled: RolledUp): number {
  if (!isPositive(rolled.total)) return 0;
  return 1 - rolled.unattributed.abs().dividedBy(rolled.total.abs()).toNumber();
}

function unattributedShare(rolled: RolledUp): Decimal | null {
  if (rolled.total.isZero()) return null;
  return divide(rolled.unattributed, rolled.total);
}

function customerAmounts(
  ctx: EngineContext,
  input: ConcentrationPeriodInput,
  customers: RolledUp,
  costs: ReadonlyMap<string, Decimal>,
  currency: string,
): MetricResult[] {
  const completeness = completenessOf(customers);
  const warnings: DataQualityWarning[] = [...input.basis.warnings];
  if (customers.total.lessThan(0)) warnings.push('negative_revenue');

  const rows: MetricResult[] = [];
  const entries: Array<{ id: string | null; amount: Decimal }> = [
    ...customers.attributed,
    { id: null, amount: customers.unattributed },
  ];

  for (const entry of entries) {
    const evidence = counterpartyEvidence(ctx, input, entry.id, 'customer');
    rows.push({
      key: 'customer_revenue',
      value: toMoneyString(entry.amount),
      unit: 'money',
      basis: input.basis.basis,
      assurance: input.basis.assurance,
      dimensionType: 'counterparty',
      dimensionId: entry.id,
      currency,
      components: entry.id === null ? { label: UNATTRIBUTED_LABEL, attributed: false } : { attributed: true },
      dataQuality: metricQuality(completeness, warnings, [], input.basis.proxy),
      evidenceQuery: evidence,
    });

    const share = customers.total.isZero() ? null : divide(entry.amount, customers.total);
    rows.push({
      key: 'customer_revenue_share',
      // §3.5: `revenue ≤ 0 → NULL`. A share of a loss-making or empty month is not a share.
      value: share === null || !isPositive(customers.total) ? null : toRatioString(share),
      unit: 'ratio',
      basis: input.basis.basis,
      assurance: input.basis.assurance,
      dimensionType: 'counterparty',
      dimensionId: entry.id,
      currency: null,
      components: {
        customer_revenue: toMoneyString(entry.amount),
        revenue: toMoneyString(customers.total),
        ...(entry.id === null ? { label: UNATTRIBUTED_LABEL } : {}),
      },
      dataQuality: metricQuality(
        completeness,
        warnings,
        isPositive(customers.total) ? [] : ['comparison_is_zero'],
        input.basis.proxy,
      ),
      evidenceQuery: derivedEvidence(['customer_revenue', 'revenue']),
    });

    if (entry.id === null) continue;

    // CD-08: contribution is revenue less directly attributable cost. For most organizations no cost
    // carries a customer id, so the figure equals revenue and says so rather than implying a margin.
    const cost = costs.get(entry.id) ?? new Decimal(0);
    rows.push({
      key: 'customer_contribution',
      value: toMoneyString(entry.amount.minus(cost)),
      unit: 'money',
      basis: combineBasis([input.basis.basis]),
      assurance: 'calculated',
      dimensionType: 'counterparty',
      dimensionId: entry.id,
      currency,
      components: {
        customer_revenue: toMoneyString(entry.amount),
        attributable_costs: toMoneyString(cost),
      },
      dataQuality: metricQuality(
        completeness,
        cost.isZero() ? [...warnings, 'no_cost_allocation'] : warnings,
        [],
        input.basis.proxy,
      ),
      evidenceQuery: derivedEvidence(['customer_revenue']),
    });
  }

  return rows;
}

function supplierAmounts(
  ctx: EngineContext,
  input: ConcentrationPeriodInput,
  suppliers: RolledUp,
  currency: string,
): MetricResult[] {
  const completeness = completenessOf(suppliers);
  const warnings = input.basis.warnings;
  const entries: Array<{ id: string | null; amount: Decimal }> = [
    ...suppliers.attributed,
    { id: null, amount: suppliers.unattributed },
  ];

  return entries.map((entry) => ({
    key: 'supplier_spend',
    value: toMoneyString(entry.amount),
    unit: 'money',
    basis: input.basis.basis,
    assurance: input.basis.assurance,
    dimensionType: 'counterparty',
    dimensionId: entry.id,
    currency,
    components: entry.id === null ? { label: UNATTRIBUTED_LABEL, attributed: false } : { attributed: true },
    dataQuality: metricQuality(completeness, warnings, [], input.basis.proxy),
    evidenceQuery: counterpartyEvidence(ctx, input, entry.id, 'supplier'),
  }));
}

/**
 * `*_concentration_top1`, `*_concentration_top5` and, for customers, `revenue_concentration_hhi`.
 *
 * `top1` and `top5` are shares of the whole — including Unattributed — because "41% of revenue" has
 * to mean 41% of the revenue on the dashboard. The HHI is normalised over the attributed slice
 * instead: §3.5 requires a single customer to score exactly 1.0, which only holds if the index is
 * taken over the customers it is an index of. Both invariants then hold together, since an
 * attributed share is never smaller than the corresponding revenue share: `HHI ∈ [top1², 1]`.
 */
function concentration(
  input: ConcentrationPeriodInput,
  rolled: RolledUp,
  side: 'customer' | 'supplier',
): MetricResult[] {
  const completeness = completenessOf(rolled);
  const unattributed = unattributedShare(rolled);
  const highUnattributed = unattributed !== null && unattributed.greaterThan(HIGH_UNATTRIBUTED_SHARE);
  const warnings: DataQualityWarning[] = [...input.basis.warnings];
  if (highUnattributed) warnings.push('high_unattributed_share');
  const assurance: AssuranceLevel = highUnattributed ? 'estimated' : input.basis.assurance;

  const base = {
    unit: 'ratio',
    basis: input.basis.basis,
    assurance,
    dimensionType: 'none',
    dimensionId: null,
    currency: null,
  } as const;

  const top1Key = side === 'customer' ? 'customer_concentration_top1' : 'supplier_concentration_top1';
  const top5Key = side === 'customer' ? 'customer_concentration_top5' : 'supplier_concentration_top5';
  const amountKey = side === 'customer' ? 'customer_revenue' : 'supplier_spend';
  const evidence = derivedEvidence([amountKey]);

  // §3.5: "fewer than 1 attributed customer → NULL `no_counterparty_data`". Nothing is known about
  // the shape of the customer base, and 0 would read as "perfectly diversified".
  if (rolled.attributed.length === 0 || !isPositive(rolled.total)) {
    const missing = rolled.attributed.length === 0 ? (['no_counterparty_data'] as const) : (['comparison_is_zero'] as const);
    const empty = {
      ...base,
      value: null,
      components: {
        attributed_count: rolled.attributed.length,
        unattributed_share: unattributed === null ? null : toRatioString(unattributed),
      },
      dataQuality: metricQuality(completeness, warnings, missing, input.basis.proxy),
      evidenceQuery: evidence,
    };
    return side === 'customer'
      ? [{ ...empty, key: top1Key }, { ...empty, key: top5Key }, { ...empty, key: 'revenue_concentration_hhi' }]
      : [{ ...empty, key: top1Key }, { ...empty, key: top5Key }];
  }

  // `rolled.total` is positive here — the guard above returned otherwise — so this is plain division.
  const shares = rolled.attributed.map((entry) => ({
    id: entry.id,
    amount: entry.amount,
    share: entry.amount.dividedBy(rolled.total),
  }));
  const top = shares[0];
  const topFive = shares.slice(0, 5);
  const top5Share = topFive.reduce((total, entry) => total.plus(entry.share), new Decimal(0));

  const sharedComponents = {
    unattributed_share: unattributed === null ? null : toRatioString(unattributed),
    attributed_count: rolled.attributed.length,
  };

  const results: MetricResult[] = [
    {
      ...base,
      key: top1Key,
      value: top === undefined ? null : toRatioString(top.share),
      components: {
        ...sharedComponents,
        top_counterparty_id: top?.id ?? null,
        share: top === undefined ? null : toRatioString(top.share),
      },
      dataQuality: metricQuality(completeness, warnings, [], input.basis.proxy),
      evidenceQuery: evidence,
    },
    {
      ...base,
      key: top5Key,
      value: toRatioString(top5Share),
      components: {
        ...sharedComponents,
        counterparty_ids: topFive.map((entry) => entry.id),
        counted: topFive.length,
      },
      dataQuality: metricQuality(
        completeness,
        // §3.5: fewer than five is not an error, but "top 5" over three customers is a different
        // statement from "top 5" over fifty, and the reader is told which they are looking at.
        rolled.attributed.length < 5 ? [...warnings, 'fewer_than_5'] : warnings,
        [],
        input.basis.proxy,
      ),
      evidenceQuery: evidence,
    },
  ];

  if (side === 'supplier') return results;

  const hhi = shares.reduce((total, entry) => {
    const normalised = divide(entry.amount, rolled.attributedTotal);
    return normalised === null ? total : total.plus(normalised.times(normalised));
  }, new Decimal(0));

  results.push({
    ...base,
    key: 'revenue_concentration_hhi',
    value: rolled.attributedTotal.isZero() ? null : toRatioString(hhi),
    components: {
      ...sharedComponents,
      attributed_revenue: toMoneyString(rolled.attributedTotal),
      normalised_over: 'attributed_revenue',
    },
    dataQuality: metricQuality(
      completeness,
      warnings,
      rolled.attributedTotal.isZero() ? ['comparison_is_zero'] : [],
      input.basis.proxy,
    ),
    evidenceQuery: evidence,
  });

  return results;
}

/** Every key this file writes, for the registry's dependency list (§3.6). */
export const CONCENTRATION_KEYS = [
  'customer_revenue', 'customer_contribution', 'customer_revenue_share',
  'customer_concentration_top1', 'customer_concentration_top5', 'revenue_concentration_hhi',
  'supplier_spend', 'supplier_concentration_top1', 'supplier_concentration_top5',
] as const;
