import { describe, expect, it } from 'vitest';

import { Decimal, parseDecimal } from '@/core/money';
import { parseQueryDescriptor } from '@/modules/evidence';
import {
  HIGH_UNATTRIBUTED_SHARE,
  UNATTRIBUTED_LABEL,
  bankCommercialPopulation,
  computeConcentration,
  resolveSurvivor,
  type BasisChoice,
  type ConcentrationPeriodInput,
  type CounterpartyAmount,
  type AccountRef,
  type CounterpartyRef,
  type EngineContext,
  type MetricResult,
  type PeriodMetrics,
  type PeriodRef,
} from '@/modules/financial-engine';

/**
 * Customer and supplier metrics (FINANCIAL_ENGINE.md §3.5, CD-08).
 *
 * The three properties §3.5 names are asserted over generated organisations, not over one example,
 * because each of them is an identity the dashboard depends on: a concentration figure that does not
 * reconcile to revenue is a number nobody can defend to an accountant.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const RUN_ID = uuid(9001);
const AGGREGATED_AT = '2026-09-05T09:00:00Z';
const REVENUE_ACCOUNT = uuid(41);
const EXPENSE_ACCOUNT = uuid(42);

/** A chart with one revenue and one expense account, for the bank-basis populations (ADR-110). */
const BANK_CHART: readonly AccountRef[] = [
  { id: REVENUE_ACCOUNT, code: null, name: 'Sales', standardCategory: 'revenue', accountType: 'income', isSystem: true },
  { id: uuid(43), code: null, name: 'Other income', standardCategory: 'other_income', accountType: 'income', isSystem: true },
  { id: EXPENSE_ACCOUNT, code: null, name: 'Stock', standardCategory: 'cost_of_sales', accountType: 'expense', isSystem: true },
  { id: uuid(44), code: null, name: 'Transfers', standardCategory: 'transfer', accountType: 'asset', isSystem: true },
];
const BANK_POPULATIONS = {
  customer: bankCommercialPopulation(BANK_CHART, 'customer'),
  supplier: bankCommercialPopulation(BANK_CHART, 'supplier'),
};

function period(index: number): PeriodRef {
  const month = index % 12;
  const year = 2025 + Math.floor(index / 12);
  const mm = String(month + 1).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return {
    id: uuid(300 + index),
    periodStart: `${year}-${mm}-01`,
    periodEnd: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
    fiscalYear: year,
    fiscalQuarter: Math.floor(month / 3) + 1,
    label: `M${index}`,
    isComplete: true,
  };
}

function counterparty(
  id: string,
  kind: CounterpartyRef['kind'],
  mergedIntoId: string | null = null,
): CounterpartyRef {
  return { id, name: `cp-${id.slice(-4)}`, kind, mergedIntoId, defaultExpenseCategory: null };
}

function context(counterparties: readonly CounterpartyRef[]): EngineContext {
  return {
    organizationId: uuid(1000),
    calculationRunId: RUN_ID,
    aggregatedAt: AGGREGATED_AT,
    asOf: '2026-09-05',
    engineVersion: '1.0.0',
    settings: {
      baseCurrency: 'GBP',
      fiscalYearStartMonth: 4,
      timezone: 'Europe/London',
      vatRegistered: false,
      defaultVatRate: null,
      taxableCategories: [],
    },
    costOfSalesEverUsed: true,
    costOfSalesInInvoices: false,
  accounts: [],
    counterparties,
    bankAccounts: [],
    periods: [],
  };
}

const INVOICE_BASIS: BasisChoice = { basis: 'invoices', assurance: 'verified', warnings: [], proxy: false };

function revenueMetric(value: string | null): MetricResult {
  return {
    key: 'revenue',
    value,
    unit: 'money',
    basis: 'invoices',
    assurance: 'verified',
    dimensionType: 'none',
    dimensionId: null,
    currency: 'GBP',
    components: {},
    dataQuality: { completeness: 1, proxy: false, warnings: [], missing: [] },
    evidenceQuery: null,
  };
}

function periodInput(overrides: Partial<ConcentrationPeriodInput> = {}): ConcentrationPeriodInput {
  return {
    period: period(1),
    basis: INVOICE_BASIS,
    customerRevenue: [],
    supplierSpend: [],
    revenue: null,
    revenueAccountIds: [REVENUE_ACCOUNT],
    expenseAccountIds: [EXPENSE_ACCOUNT],
    ...overrides,
  };
}

function all(results: readonly PeriodMetrics[], key: string, index = 0): readonly MetricResult[] {
  return (results[index]?.metrics ?? []).filter((m) => m.key === key);
}

function one(results: readonly PeriodMetrics[], key: string, index = 0): MetricResult {
  const found = all(results, key, index)[0];
  if (found === undefined) throw new Error(`no metric ${key}`);
  return found;
}

function forDimension(
  results: readonly PeriodMetrics[],
  key: string,
  dimensionId: string | null,
): MetricResult {
  const found = all(results, key).find((m) => m.dimensionId === dimensionId);
  if (found === undefined) throw new Error(`no ${key} for ${dimensionId ?? 'unattributed'}`);
  return found;
}

/** A seeded LCG, so a property failure is reproducible and the suite never flakes. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const ACME = uuid(11);
const BETA = uuid(12);
const GAMMA = uuid(13);
const SUPPLIER = uuid(21);

function amount(counterpartyId: string | null, value: string): CounterpartyAmount {
  return { counterpartyId, amount: value };
}

// ---------------------------------------------------------------------------------------------
// Merge resolution
// ---------------------------------------------------------------------------------------------

describe('merged counterparties roll up to the survivor (§3.5)', () => {
  it('follows a chain of merges to its end', () => {
    const byId = new Map([
      [ACME, counterparty(ACME, 'customer', BETA)],
      [BETA, counterparty(BETA, 'customer', GAMMA)],
      [GAMMA, counterparty(GAMMA, 'customer')],
    ]);
    expect(resolveSurvivor(ACME, byId)).toBe(GAMMA);
    expect(resolveSurvivor(BETA, byId)).toBe(GAMMA);
    expect(resolveSurvivor(GAMMA, byId)).toBe(GAMMA);
  });

  it('terminates on a merge cycle, deterministically and from any entry point', () => {
    // Corrupt data must not hang a calculation run, and must not produce a different answer
    // depending on which row the loader happened to reach first.
    const byId = new Map([
      [ACME, counterparty(ACME, 'customer', BETA)],
      [BETA, counterparty(BETA, 'customer', ACME)],
    ]);
    expect(resolveSurvivor(ACME, byId)).toBe(resolveSurvivor(BETA, byId));
    expect([ACME, BETA]).toContain(resolveSurvivor(ACME, byId));
  });

  it('treats a self-merge as its own survivor', () => {
    const byId = new Map([[ACME, counterparty(ACME, 'customer', ACME)]]);
    expect(resolveSurvivor(ACME, byId)).toBe(ACME);
  });

  it('adds the merged counterparty’s revenue to the survivor, as one customer', () => {
    const ctx = context([
      counterparty(ACME, 'customer', GAMMA),
      counterparty(BETA, 'customer', GAMMA),
      counterparty(GAMMA, 'customer'),
    ]);
    const results = computeConcentration(ctx, [
      periodInput({
        customerRevenue: [amount(ACME, '300.00'), amount(BETA, '200.00'), amount(GAMMA, '500.00')],
        revenue: revenueMetric('1000.00'),
      }),
    ]);
    expect(all(results, 'customer_revenue')).toHaveLength(2); // the survivor plus Unattributed
    expect(forDimension(results, 'customer_revenue', GAMMA).value).toBe('1000.00');
    expect(one(results, 'customer_concentration_top1').value).toBe('1.000000');
  });
});

// ---------------------------------------------------------------------------------------------
// Unattributed
// ---------------------------------------------------------------------------------------------

describe('the Unattributed remainder (§3.5)', () => {
  const ctx = context([counterparty(ACME, 'customer'), counterparty(BETA, 'both')]);

  it('writes a synthetic snapshot with a null dimension so the total reconciles to revenue', () => {
    const results = computeConcentration(ctx, [
      periodInput({
        customerRevenue: [amount(ACME, '600.00'), amount(BETA, '300.00'), amount(null, '100.00')],
        revenue: revenueMetric('1000.00'),
      }),
    ]);
    const unattributed = forDimension(results, 'customer_revenue', null);
    expect(unattributed.value).toBe('100.00');
    expect(unattributed.dimensionType).toBe('counterparty');
    expect(unattributed.components).toMatchObject({ label: UNATTRIBUTED_LABEL, attributed: false });
    expect(unattributed.evidenceQuery).toBeNull();
  });

  it('routes revenue billed to a non-customer counterparty into Unattributed', () => {
    // A supplier-kind counterparty is not a customer, but the money is still the organization's
    // revenue: it has to land somewhere or the reconciliation breaks.
    const withSupplier = context([counterparty(ACME, 'customer'), counterparty(SUPPLIER, 'supplier')]);
    const results = computeConcentration(withSupplier, [
      periodInput({
        customerRevenue: [amount(ACME, '600.00'), amount(SUPPLIER, '400.00')],
        revenue: revenueMetric('1000.00'),
      }),
    ]);
    expect(forDimension(results, 'customer_revenue', null).value).toBe('400.00');
    expect(all(results, 'customer_revenue')).toHaveLength(2);
  });

  it('takes the remainder from revenue, so an unattributed row nobody sent is still accounted for', () => {
    const results = computeConcentration(ctx, [
      periodInput({ customerRevenue: [amount(ACME, '600.00')], revenue: revenueMetric('1000.00') }),
    ]);
    expect(forDimension(results, 'customer_revenue', null).value).toBe('400.00');
  });

  it('marks the family estimated when more than half the revenue is unattributed', () => {
    const results = computeConcentration(ctx, [
      periodInput({
        customerRevenue: [amount(ACME, '400.00'), amount(null, '600.00')],
        revenue: revenueMetric('1000.00'),
      }),
    ]);
    const top1 = one(results, 'customer_concentration_top1');
    expect(top1.assurance).toBe('estimated');
    expect(top1.dataQuality.warnings).toContain('high_unattributed_share');
    expect(top1.components).toMatchObject({ unattributed_share: '0.600000' });
    expect(0.6).toBeGreaterThan(HIGH_UNATTRIBUTED_SHARE);
  });

  it('leaves the family verified when the unattributed share is small', () => {
    const results = computeConcentration(ctx, [
      periodInput({
        customerRevenue: [amount(ACME, '900.00'), amount(null, '100.00')],
        revenue: revenueMetric('1000.00'),
      }),
    ]);
    const top1 = one(results, 'customer_concentration_top1');
    expect(top1.assurance).toBe('verified');
    expect(top1.dataQuality.warnings).not.toContain('high_unattributed_share');
    // §5, customer/supplier family: completeness = 1 − unattributed share.
    expect(top1.dataQuality.completeness).toBeCloseTo(0.9, 10);
  });
});

// ---------------------------------------------------------------------------------------------
// Concentration
// ---------------------------------------------------------------------------------------------

describe('customer concentration (§3.5)', () => {
  const many = Array.from({ length: 7 }, (_, index) => counterparty(uuid(500 + index), 'customer'));
  const manyCtx = context(many);

  it('takes top1 as the largest share of revenue, excluding Unattributed', () => {
    const ctx = context([counterparty(ACME, 'customer'), counterparty(BETA, 'customer')]);
    const results = computeConcentration(ctx, [
      periodInput({
        customerRevenue: [amount(ACME, '410.00'), amount(BETA, '190.00'), amount(null, '400.00')],
        revenue: revenueMetric('1000.00'),
      }),
    ]);
    const top1 = one(results, 'customer_concentration_top1');
    expect(top1.value).toBe('0.410000');
    expect(top1.components).toMatchObject({ top_counterparty_id: ACME });
  });

  it('sums the five largest shares for top5', () => {
    const revenue = many.map((cp, index) => amount(cp.id, `${(index + 1) * 100}.00`));
    const results = computeConcentration(manyCtx, [
      periodInput({ customerRevenue: revenue, revenue: revenueMetric('2800.00') }),
    ]);
    const top5 = one(results, 'customer_concentration_top5');
    // 700 + 600 + 500 + 400 + 300 = 2,500 of 2,800.
    expect(top5.value).toBe('0.892857');
    expect(top5.components).toMatchObject({ counted: 5 });
    expect(top5.dataQuality.warnings).not.toContain('fewer_than_5');
  });

  it('sums all of them and warns when there are fewer than five customers', () => {
    const ctx = context([counterparty(ACME, 'customer'), counterparty(BETA, 'customer')]);
    const results = computeConcentration(ctx, [
      periodInput({
        customerRevenue: [amount(ACME, '600.00'), amount(BETA, '400.00')],
        revenue: revenueMetric('1000.00'),
      }),
    ]);
    const top5 = one(results, 'customer_concentration_top5');
    expect(top5.value).toBe('1.000000');
    expect(top5.dataQuality.warnings).toContain('fewer_than_5');
  });

  it('is NULL with no_counterparty_data when nothing is attributed', () => {
    const ctx = context([]);
    const results = computeConcentration(ctx, [
      periodInput({ customerRevenue: [amount(null, '1000.00')], revenue: revenueMetric('1000.00') }),
    ]);
    for (const key of ['customer_concentration_top1', 'customer_concentration_top5', 'revenue_concentration_hhi']) {
      const result = one(results, key);
      expect(result.value).toBeNull();
      expect(result.dataQuality.missing).toContain('no_counterparty_data');
    }
  });

  it('gives a single customer an HHI of exactly 1.0', () => {
    const ctx = context([counterparty(ACME, 'customer')]);
    const results = computeConcentration(ctx, [
      periodInput({ customerRevenue: [amount(ACME, '1000.00')], revenue: revenueMetric('1000.00') }),
    ]);
    expect(one(results, 'revenue_concentration_hhi').value).toBe('1.000000');
  });

  it('gives a single customer an HHI of 1.0 even beside an unattributed remainder', () => {
    // The index is over the customers it is an index of; the remainder is described by top1 instead.
    const ctx = context([counterparty(ACME, 'customer')]);
    const results = computeConcentration(ctx, [
      periodInput({ customerRevenue: [amount(ACME, '600.00')], revenue: revenueMetric('1000.00') }),
    ]);
    expect(one(results, 'revenue_concentration_hhi').value).toBe('1.000000');
    expect(one(results, 'customer_concentration_top1').value).toBe('0.600000');
    expect(one(results, 'revenue_concentration_hhi').components).toMatchObject({
      normalised_over: 'attributed_revenue',
    });
  });

  it('is NULL for the HHI when every attributed customer nets to zero', () => {
    // A named customer whose invoices and credit notes cancel: there is a customer, but no attributed
    // revenue for an index to be an index of. Zero would read as "perfectly diversified".
    const ctx = context([counterparty(ACME, 'customer')]);
    const results = computeConcentration(ctx, [
      periodInput({
        customerRevenue: [amount(ACME, '0.00'), amount(null, '1000.00')],
        revenue: revenueMetric('1000.00'),
      }),
    ]);
    const hhi = one(results, 'revenue_concentration_hhi');
    expect(hhi.value).toBeNull();
    expect(hhi.dataQuality.missing).toContain('comparison_is_zero');
    expect(one(results, 'customer_concentration_top1').value).toBe('0.000000');
  });

  it('spreads the HHI towards zero as the customer base widens', () => {
    const revenue = many.map((cp) => amount(cp.id, '100.00'));
    const results = computeConcentration(manyCtx, [
      periodInput({ customerRevenue: revenue, revenue: revenueMetric('700.00') }),
    ]);
    // Seven equal customers: 7 × (1/7)² = 1/7.
    expect(one(results, 'revenue_concentration_hhi').value).toBe('0.142857');
  });
});

describe('customer shares and contribution (§3.5, CD-08)', () => {
  const ctx = context([counterparty(ACME, 'customer'), counterparty(BETA, 'customer')]);

  it('divides each customer’s revenue by the period revenue', () => {
    const results = computeConcentration(ctx, [
      periodInput({
        customerRevenue: [amount(ACME, '250.00'), amount(BETA, '750.00')],
        revenue: revenueMetric('1000.00'),
      }),
    ]);
    expect(forDimension(results, 'customer_revenue_share', ACME).value).toBe('0.250000');
    expect(forDimension(results, 'customer_revenue_share', BETA).value).toBe('0.750000');
  });

  it('is NULL when revenue is zero or negative, never a share of nothing', () => {
    for (const revenue of ['0.00', '-500.00']) {
      const results = computeConcentration(ctx, [
        periodInput({ customerRevenue: [amount(ACME, '100.00')], revenue: revenueMetric(revenue) }),
      ]);
      const share = forDimension(results, 'customer_revenue_share', ACME);
      expect(share.value).toBeNull();
      expect(share.dataQuality.missing).toContain('comparison_is_zero');
    }
  });

  it('equals revenue and says no cost was allocated when no cost carries the customer', () => {
    const results = computeConcentration(ctx, [
      periodInput({ customerRevenue: [amount(ACME, '900.00')], revenue: revenueMetric('900.00') }),
    ]);
    const contribution = forDimension(results, 'customer_contribution', ACME);
    expect(contribution.value).toBe('900.00');
    expect(contribution.dataQuality.warnings).toContain('no_cost_allocation');
    expect(contribution.assurance).toBe('calculated');
  });

  it('subtracts directly attributable costs, rolled up through the merge chain', () => {
    const merged = context([counterparty(BETA, 'customer', ACME), counterparty(ACME, 'customer')]);
    const results = computeConcentration(merged, [
      periodInput({
        customerRevenue: [amount(ACME, '900.00')],
        customerAttributableCosts: [amount(BETA, '150.00'), amount(null, '999.00')],
        revenue: revenueMetric('900.00'),
      }),
    ]);
    const contribution = forDimension(results, 'customer_contribution', ACME);
    expect(contribution.value).toBe('750.00');
    expect(contribution.dataQuality.warnings).not.toContain('no_cost_allocation');
  });

  it('writes no contribution row for the Unattributed remainder', () => {
    const results = computeConcentration(ctx, [
      periodInput({ customerRevenue: [amount(ACME, '900.00')], revenue: revenueMetric('1000.00') }),
    ]);
    expect(all(results, 'customer_contribution').every((m) => m.dimensionId !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------------------------

describe('supplier spend and concentration (§3.5)', () => {
  const ctx = context([
    counterparty(SUPPLIER, 'supplier'),
    counterparty(BETA, 'both'),
    counterparty(ACME, 'customer'),
  ]);

  it('takes shares of total spend including the unattributed remainder', () => {
    const results = computeConcentration(ctx, [
      periodInput({
        supplierSpend: [amount(SUPPLIER, '600.00'), amount(BETA, '200.00'), amount(null, '200.00')],
      }),
    ]);
    expect(forDimension(results, 'supplier_spend', SUPPLIER).value).toBe('600.00');
    expect(forDimension(results, 'supplier_spend', null).value).toBe('200.00');
    expect(one(results, 'supplier_concentration_top1').value).toBe('0.600000');
    expect(one(results, 'supplier_concentration_top5').value).toBe('0.800000');
  });

  it('counts a customer-only counterparty’s spend as unattributed', () => {
    const results = computeConcentration(ctx, [
      periodInput({ supplierSpend: [amount(ACME, '500.00'), amount(SUPPLIER, '500.00')] }),
    ]);
    expect(forDimension(results, 'supplier_spend', null).value).toBe('500.00');
  });

  it('writes no HHI for the supplier side', () => {
    const results = computeConcentration(ctx, [periodInput({ supplierSpend: [amount(SUPPLIER, '1.00')] })]);
    expect(all(results, 'revenue_concentration_hhi')).toHaveLength(1);
    expect(one(results, 'revenue_concentration_hhi').value).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------------------------

describe('the shape of a counterparty snapshot', () => {
  const ctx = context([counterparty(ACME, 'customer'), counterparty(SUPPLIER, 'supplier')]);

  it('writes a v1 invoice descriptor on the invoice basis', () => {
    const results = computeConcentration(ctx, [
      periodInput({ customerRevenue: [amount(ACME, '10.00')], revenue: revenueMetric('10.00') }),
    ]);
    const evidence = forDimension(results, 'customer_revenue', ACME).evidenceQuery;
    if (evidence?.kind !== 'leaf') throw new Error('expected a leaf');
    const parsed = parseQueryDescriptor(evidence.descriptor);
    expect(parsed.table).toBe('invoices');
    expect(parsed.filters.counterparty_ids).toEqual([ACME]);
  });

  it('resolves categories to concrete account ids on the ledger basis (ADR-034)', () => {
    const results = computeConcentration(ctx, [
      periodInput({
        basis: { basis: 'ledger', assurance: 'calculated', warnings: [], proxy: false },
        customerRevenue: [amount(ACME, '10.00')],
        revenue: revenueMetric('10.00'),
      }),
    ]);
    const evidence = forDimension(results, 'customer_revenue', ACME).evidenceQuery;
    if (evidence?.kind !== 'leaf') throw new Error('expected a leaf');
    const parsed = parseQueryDescriptor(evidence.descriptor);
    expect(parsed.table).toBe('ledger_entries');
    expect(parsed.filters.account_ids).toEqual([REVENUE_ACCOUNT]);
  });

  it('re-selects a bank-basis supplier from its population: expense outflows, no transfer of any kind (ADR-110)', () => {
    const results = computeConcentration(ctx, [
      periodInput({
        basis: { basis: 'bank', assurance: 'estimated', warnings: ['cash_basis_proxy'], proxy: true },
        supplierSpend: [amount(SUPPLIER, '10.00')],
        bankPopulations: BANK_POPULATIONS,
      }),
    ]);
    const evidence = forDimension(results, 'supplier_spend', SUPPLIER).evidenceQuery;
    if (evidence?.kind !== 'leaf') throw new Error('expected a leaf');
    const parsed = parseQueryDescriptor(evidence.descriptor);
    expect(parsed.table).toBe('bank_transactions');
    expect(parsed.filters.direction).toBe('outflow');
    // Every kind, not only cash transfers: a card repayment is nobody's spend either (§4.4).
    expect(parsed.filters.exclude_transfers).toBe('all');
    expect(parsed.filters.category_account_ids).toEqual([EXPENSE_ACCOUNT]);
    expect(forDimension(results, 'supplier_spend', SUPPLIER).dataQuality.proxy).toBe(true);
  });

  it('reads a bank-basis customer from revenue-category inflows only, not other income (ADR-110)', () => {
    const results = computeConcentration(ctx, [
      periodInput({
        basis: { basis: 'bank', assurance: 'estimated', warnings: ['cash_basis_proxy'], proxy: true },
        customerRevenue: [amount(ACME, '10.00')],
        revenue: revenueMetric('10.00'),
        bankPopulations: BANK_POPULATIONS,
      }),
    ]);
    const evidence = forDimension(results, 'customer_revenue', ACME).evidenceQuery;
    if (evidence?.kind !== 'leaf') throw new Error('expected a leaf');
    const parsed = parseQueryDescriptor(evidence.descriptor);
    expect(parsed.table).toBe('bank_transactions');
    expect(parsed.filters.direction).toBe('inflow');
    expect(parsed.filters.exclude_transfers).toBe('all');
    expect(parsed.filters.category_account_ids).toEqual([REVENUE_ACCOUNT]);
  });

  it('writes no bank-basis descriptor without the population the figure came from', () => {
    // A descriptor built from any other account list is the defect ADR-110 closed; none is better.
    const results = computeConcentration(ctx, [
      periodInput({
        basis: { basis: 'bank', assurance: 'estimated', warnings: ['cash_basis_proxy'], proxy: true },
        supplierSpend: [amount(SUPPLIER, '10.00')],
      }),
    ]);
    expect(forDimension(results, 'supplier_spend', SUPPLIER).evidenceQuery).toBeNull();
  });

  it('writes no descriptor when the basis carries no counterparty', () => {
    const results = computeConcentration(ctx, [
      periodInput({
        basis: { basis: 'period_balances', assurance: 'verified', warnings: [], proxy: false },
        customerRevenue: [amount(ACME, '10.00')],
        revenue: revenueMetric('10.00'),
      }),
    ]);
    expect(forDimension(results, 'customer_revenue', ACME).evidenceQuery).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Properties (§3.5)
// ---------------------------------------------------------------------------------------------

interface Generated {
  ctx: EngineContext;
  input: ConcentrationPeriodInput;
  revenueTotal: Decimal;
}

function randomOrganization(random: () => number): Generated {
  const customerCount = 1 + Math.floor(random() * 8);
  const counterparties = Array.from({ length: customerCount }, (_, index) =>
    counterparty(uuid(600 + index), random() < 0.2 ? 'both' : 'customer'),
  );
  const amounts: CounterpartyAmount[] = counterparties.map((cp) =>
    amount(cp.id, (Math.round(random() * 500000) / 100).toFixed(2)),
  );
  if (random() < 0.5) amounts.push(amount(null, (Math.round(random() * 200000) / 100).toFixed(2)));

  const revenueTotal = amounts.reduce(
    (total, entry) => total.plus(parseDecimal(entry.amount)),
    new Decimal(0),
  );
  return {
    ctx: context(counterparties),
    input: periodInput({ customerRevenue: amounts, revenue: revenueMetric(revenueTotal.toFixed(2)) }),
    revenueTotal,
  };
}

describe('the properties §3.5 names', () => {
  it('reconciles Σ customer_revenue, including Unattributed, to revenue', () => {
    const random = prng(20260905);
    for (let trial = 0; trial < 100; trial += 1) {
      const { ctx, input, revenueTotal } = randomOrganization(random);
      const results = computeConcentration(ctx, [input]);
      const total = all(results, 'customer_revenue').reduce(
        (running, metric) => running.plus(parseDecimal(metric.value ?? '0')),
        new Decimal(0),
      );
      expect(total.toFixed(2)).toBe(revenueTotal.toFixed(2));
    }
  });

  it('makes the shares sum to 1 within the rounding of 6 dp storage', () => {
    // §3.5 states the property as "± 1e−6". Each share is stored at 6 dp (ADR-006), so n shares can
    // carry up to n × 5e−7 of rounding: the document's figure is exact only up to two shares, and the
    // tolerance below is the same property expressed in the precision the values are actually kept in.
    const random = prng(4242);
    for (let trial = 0; trial < 100; trial += 1) {
      const { ctx, input, revenueTotal } = randomOrganization(random);
      if (!revenueTotal.greaterThan(0)) continue;
      const results = computeConcentration(ctx, [input]);
      const shares = all(results, 'customer_revenue_share');
      const total = shares.reduce(
        (running, metric) => running.plus(parseDecimal(metric.value ?? '0')),
        new Decimal(0),
      );
      const tolerance = Decimal.max('0.000001', new Decimal('0.0000005').times(shares.length));
      expect(total.minus(1).abs().lessThanOrEqualTo(tolerance)).toBe(true);
    }
  });

  it('makes the shares sum to exactly 1 before they are rounded for storage', () => {
    const random = prng(909);
    for (let trial = 0; trial < 100; trial += 1) {
      const { ctx, input, revenueTotal } = randomOrganization(random);
      if (!revenueTotal.greaterThan(0)) continue;
      const results = computeConcentration(ctx, [input]);
      const total = all(results, 'customer_revenue').reduce(
        (running, metric) => running.plus(parseDecimal(metric.value ?? '0').dividedBy(revenueTotal)),
        new Decimal(0),
      );
      expect(total.toFixed(12)).toBe('1.000000000000');
    }
  });

  it('keeps the HHI inside [top1², 1]', () => {
    const random = prng(777);
    for (let trial = 0; trial < 100; trial += 1) {
      const { ctx, input, revenueTotal } = randomOrganization(random);
      if (!revenueTotal.greaterThan(0)) continue;
      const results = computeConcentration(ctx, [input]);
      const hhi = parseDecimal(one(results, 'revenue_concentration_hhi').value ?? '0');
      const top1 = parseDecimal(one(results, 'customer_concentration_top1').value ?? '0');
      // A 6 dp rounding of each side can move the bound by half a unit in the last place.
      expect(hhi.plus('0.000001').greaterThanOrEqualTo(top1.times(top1))).toBe(true);
      expect(hhi.lessThanOrEqualTo(1)).toBe(true);
      expect(hhi.greaterThan(0)).toBe(true);
    }
  });

  it('never lets top1 exceed top5', () => {
    const random = prng(31337);
    for (let trial = 0; trial < 100; trial += 1) {
      const { ctx, input, revenueTotal } = randomOrganization(random);
      if (!revenueTotal.greaterThan(0)) continue;
      const results = computeConcentration(ctx, [input]);
      const top1 = parseDecimal(one(results, 'customer_concentration_top1').value ?? '0');
      const top5 = parseDecimal(one(results, 'customer_concentration_top5').value ?? '0');
      expect(top5.greaterThanOrEqualTo(top1)).toBe(true);
      expect(top5.lessThanOrEqualTo('1.000001')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Determinism (§1.1)
// ---------------------------------------------------------------------------------------------

describe('determinism (§1.1)', () => {
  const { ctx, input } = randomOrganization(prng(11));
  const second = { ...input, period: period(2) };

  it('produces byte-identical results when run twice', () => {
    expect(JSON.stringify(computeConcentration(ctx, [input, second]))).toBe(
      JSON.stringify(computeConcentration(ctx, [input, second])),
    );
  });

  it('produces the same results whatever order the periods and rows arrive in', () => {
    const shuffled = [second, input].map((entry) => ({
      ...entry,
      customerRevenue: [...entry.customerRevenue].reverse(),
    }));
    expect(JSON.stringify(computeConcentration(ctx, shuffled))).toBe(
      JSON.stringify(computeConcentration(ctx, [input, second])),
    );
  });
});
