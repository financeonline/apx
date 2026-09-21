import { Decimal, ROUND_HALF_UP, parseDecimalOrNull, toMoneyString, toRatioString } from '@/core/money';
import {
  FORECAST_METRICS, composeFromLevels,
  type ForecastBasis, type ForecastPoint, type HorizonPeriod, type LeafLevels,
} from '@/modules/forecast';
import { ASSUMPTION_KINDS, CATEGORY_FOR_KIND, SCENARIO_CONFIG_VERSION, SCENARIO_METHOD } from './config';
import type {
  Assumption, ScenarioBasis, ScenarioCell, ScenarioResult, ScenarioUnavailable,
} from './types';

/**
 * The scenario engine (REQ-SC-01…09; ADR-100).
 *
 * **MOTION does not have a second way of working figures out.** A scenario is a set of deltas on
 * the forecast's LEAF levels — sales, direct costs, running costs, money in, money out, what is
 * owed — and both sides of the comparison are then composed by `composeFromLevels`, the same
 * function the forecast itself calls. Profit is therefore derived from sales and costs on the
 * scenario side exactly as it is on the baseline side, and cash is chained from the same real
 * opening balance. A comparison whose two halves were computed differently is not a comparison, and
 * this is the mechanism that makes that impossible rather than merely unlikely.
 *
 * **Nothing is inferred.** Each assumption below moves the leaves it names and no others:
 *
 *   - a price rise does not become a sales rise unless the number of sales is stated (§9);
 *   - marketing spend does not become revenue, ever, because no relationship in MOTION's data
 *     defines one (§10);
 *   - a sale does not become cash unless the assumption says it is collected that month (§7);
 *   - direct costs follow sales only when asked to, and then at the organisation's OWN rate read
 *     from its own forecast — never at a margin this module chose (§7);
 *   - interest is an amount somebody typed, never a rate applied to a principal (§11).
 *
 * **A missing input is a refusal, not a zero.** If any assumption needs a figure MOTION does not
 * have, the whole scenario is unavailable with the reason — a partly applied scenario would produce
 * a number that looks complete (§7, §12).
 *
 * Pure: no clock, no I/O, no randomness. The same assumptions over the same basis always produce
 * byte-identical cells, in any input order.
 */

/** The leaves a scenario may move. Everything else in the result is derived from these. */
const LEAVES = [
  'revenue', 'cost_of_sales', 'operating_expenses',
  'cash_inflows', 'cash_outflows', 'receivables', 'payables',
] as const;

type Leaf = (typeof LEAVES)[number];

export interface ApplyInput {
  readonly assumptions: readonly Assumption[];
  readonly basis: ScenarioBasis;
  readonly horizon: readonly HorizonPeriod[];
  readonly forecastBasis: ForecastBasis | null;
}

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

const money = (value: Decimal): string => toMoneyString(value.toDecimalPlaces(2, ROUND_HALF_UP));

/** Deltas on the leaves, for one month. Everything a scenario does reduces to this. */
type Deltas = Record<Leaf, Decimal>;

function noDeltas(): Deltas {
  return {
    revenue: ZERO, cost_of_sales: ZERO, operating_expenses: ZERO,
    cash_inflows: ZERO, cash_outflows: ZERO, receivables: ZERO, payables: ZERO,
  };
}

/** Assumptions in a fixed order, so two identical sets typed in different orders agree exactly. */
function ordered(assumptions: readonly Assumption[]): Assumption[] {
  const rank = new Map(ASSUMPTION_KINDS.map((kind, index) => [kind, index]));
  return [...assumptions].sort((a, b) => (rank.get(a.kind) ?? 0) - (rank.get(b.kind) ?? 0));
}

const pct = (value: string): Decimal => new Decimal(value).dividedBy(HUNDRED);

/**
 * What each assumption needs before it can be applied at all (§7, §8, §11).
 *
 * Returned rather than thrown so the page can list every missing thing at once, and so the reason
 * reaching the reader is a real condition the server checked rather than "something went wrong".
 */
export function sufficiency(
  assumptions: readonly Assumption[], basis: ScenarioBasis,
): ScenarioUnavailable[] {
  const out: ScenarioUnavailable[] = [];
  const has = (key: string): boolean => {
    const value = basis.leafLevels[key];
    return value !== undefined && value !== null;
  };
  const level = (key: string): Decimal | null => {
    const value = basis.leafLevels[key];
    return value === undefined || value === null ? null : new Decimal(value);
  };
  const need = (kind: Assumption['kind'], reason: ScenarioUnavailable['reason'], metricKey: string | null) =>
    out.push({ kind, reason, metricKey });

  for (const assumption of ordered(assumptions)) {
    const { kind } = assumption;

    // Every cost or income change needs the leaf it moves to exist in the forecast at all.
    switch (kind) {
      case 'revenue_change':
      case 'pricing_change':
        if (!has('revenue')) { need(kind, 'metric_not_forecast', 'revenue'); continue; }
        break;
      case 'payroll_change':
      case 'marketing_change':
      case 'hiring':
        if (!has('operating_expenses')) { need(kind, 'metric_not_forecast', 'operating_expenses'); continue; }
        break;
      case 'supplier_cost_change':
        // CD-05: an organisation with no cost-of-sales accounts has no direct costs at all, and
        // adding some here would invent a gross profit its books have never had.
        if (!has('cost_of_sales')) { need(kind, 'no_direct_costs', 'cost_of_sales'); continue; }
        break;
      case 'debt_drawdown':
        if (!has('cash_inflows')) { need(kind, 'metric_not_forecast', 'cash_inflows'); continue; }
        break;
      case 'debt_repayment':
        if (!has('cash_outflows')) { need(kind, 'metric_not_forecast', 'cash_outflows'); continue; }
        break;
    }

    // A percentage of payroll or marketing needs to know what payroll or marketing has been
    // running at, and that is the engine's own `expense_by_category` breakdown.
    const category = CATEGORY_FOR_KIND[kind];
    if (category !== undefined && 'mode' in assumption && assumption.mode === 'percent') {
      const categoryLevel = basis.categoryLevels[category];
      if (categoryLevel === undefined || categoryLevel === null) {
        need(kind, 'no_category_baseline', 'expense_by_category');
        continue;
      }
    }

    // Direct costs can only follow sales at a rate read from the organisation's own figures.
    if ('directCostsFollow' in assumption && assumption.directCostsFollow) {
      if (!has('cost_of_sales')) { need(kind, 'no_direct_costs', 'cost_of_sales'); continue; }
      if (kind === 'revenue_change' && assumption.mode === 'amount') {
        const revenue = level('revenue');
        if (revenue === null || revenue.isZero()) {
          need(kind, 'no_revenue_baseline', 'revenue');
          continue;
        }
      }
    }

    // A change that is assumed to move cash needs the cash figure it would move.
    if (assumption.cashEffect === 'same_month') {
      const movesIn = kind === 'revenue_change' || kind === 'pricing_change' || kind === 'debt_drawdown';
      const inflowNeeded = movesIn;
      const outflowNeeded = !movesIn
        || ('directCostsFollow' in assumption && assumption.directCostsFollow);
      if (inflowNeeded && !has('cash_inflows')) { need(kind, 'metric_not_forecast', 'cash_inflows'); continue; }
      if (outflowNeeded && !has('cash_outflows')) { need(kind, 'metric_not_forecast', 'cash_outflows'); continue; }
    }
  }
  return out;
}

/** Whether an assumption applies in this month (1-based). */
function appliesIn(assumption: Assumption, month: number): boolean {
  // Borrowing is an event: the money arrives once, in the month it was assumed to arrive.
  if (assumption.kind === 'debt_drawdown') return assumption.startsInMonth === month;
  return month >= assumption.startsInMonth;
}

/**
 * One assumption's effect on the leaves, in money, for one month.
 *
 * Every branch reads a baseline level from the organisation's own forecast; none invents a rate.
 */
function deltasFor(assumption: Assumption, basis: ScenarioBasis): Deltas {
  const deltas = noDeltas();
  const level = (key: string): Decimal => {
    const value = basis.leafLevels[key];
    return value === undefined || value === null ? ZERO : new Decimal(value);
  };
  const categoryLevel = (key: string): Decimal => {
    const value = basis.categoryLevels[key];
    return value === undefined || value === null ? ZERO : new Decimal(value);
  };

  switch (assumption.kind) {
    case 'revenue_change': {
      const share = assumption.mode === 'percent' ? pct(assumption.value) : null;
      deltas.revenue = share === null ? new Decimal(assumption.value) : level('revenue').times(share);
      if (assumption.directCostsFollow) {
        /*
         * The organisation's OWN rate. In percent mode it is the same proportion; in amount mode it
         * is the proportion that amount is of the forecast sales, which `sufficiency` has already
         * proved is not zero. Neither is a margin this module chose.
         */
        const proportion = share ?? deltas.revenue.dividedBy(level('revenue'));
        deltas.cost_of_sales = level('cost_of_sales').times(proportion);
      }
      break;
    }
    case 'pricing_change': {
      /*
       * §9: price and volume are two separate assumptions and the reader sees both. Sales move by
       * (1 + price)(1 + volume) − 1; DIRECT COSTS move with volume alone, because a price rise does
       * not make anything cost more to buy or make.
       */
      const price = pct(assumption.pricePercent);
      const volume = pct(assumption.volumePercent);
      const factor = new Decimal(1).plus(price).times(new Decimal(1).plus(volume)).minus(1);
      deltas.revenue = level('revenue').times(factor);
      if (assumption.directCostsFollow) deltas.cost_of_sales = level('cost_of_sales').times(volume);
      break;
    }
    case 'payroll_change':
    case 'marketing_change': {
      const category = CATEGORY_FOR_KIND[assumption.kind]!;
      deltas.operating_expenses = assumption.mode === 'percent'
        ? categoryLevel(category).times(pct(assumption.value))
        : new Decimal(assumption.value);
      break;
    }
    case 'supplier_cost_change':
      deltas.cost_of_sales = assumption.mode === 'percent'
        ? level('cost_of_sales').times(pct(assumption.value))
        : new Decimal(assumption.value);
      break;
    case 'hiring':
      // §8: the cost is the one the user gave, times the number of people. Nothing is assumed.
      deltas.operating_expenses = new Decimal(assumption.monthlyCostPerPerson)
        .times(assumption.headcount);
      break;
    case 'debt_drawdown':
      deltas.cash_inflows = new Decimal(assumption.amount);
      break;
    case 'debt_repayment':
      /*
       * §11: capital and interest are separate amounts and both are cash. Interest is NOT added to
       * operating profit: it sits below the operating line in the engine (`interest_expense`,
       * FINANCIAL_ENGINE.md §3.1), and MOTION's forecast does not carry a figure below that line —
       * so the honest statement is that this changes cash and not operating profit, which is what
       * the page says.
       */
      deltas.cash_outflows = new Decimal(assumption.monthlyAmount)
        .plus(assumption.monthlyInterest === null ? ZERO : new Decimal(assumption.monthlyInterest));
      break;
  }

  // §7: cash moves only when the assumption says it does.
  if (assumption.cashEffect === 'same_month'
      && assumption.kind !== 'debt_drawdown' && assumption.kind !== 'debt_repayment') {
    deltas.cash_inflows = deltas.cash_inflows.plus(deltas.revenue);
    deltas.cash_outflows = deltas.cash_outflows
      .plus(deltas.operating_expenses)
      .plus(deltas.cost_of_sales);
  }

  return deltas;
}

function levelsWith(basis: ScenarioBasis, deltas: Deltas): LeafLevels {
  const out: Record<string, string | null> = {};
  for (const leaf of LEAVES) {
    const level = basis.leafLevels[leaf];
    out[leaf] = level === undefined || level === null
      ? null
      : money(new Decimal(level).plus(deltas[leaf]));
  }
  return out;
}

function key(point: ForecastPoint): string {
  return `${point.periodId}|${point.metricKey}`;
}

/**
 * Work the scenario out.
 *
 * Both sides are composed by the forecast's own function: the baseline from the untouched levels,
 * the scenario from the levels each assumption moved. The cells are the pairing.
 */
export function applyScenario(input: ApplyInput): ScenarioResult {
  const unavailable = sufficiency(input.assumptions, input.basis);
  if (unavailable.length > 0) {
    return {
      method: SCENARIO_METHOD,
      configVersion: SCENARIO_CONFIG_VERSION,
      cells: [],
      unavailable,
      basis: input.forecastBasis,
    };
  }

  const assumptions = ordered(input.assumptions);
  const flat = levelsWith(input.basis, noDeltas());

  const baselinePoints = composeFromLevels({
    horizon: input.horizon,
    levelsAt: () => flat,
    lastActualClosingCash: input.basis.lastActualClosingCash,
  });

  const scenarioPoints = composeFromLevels({
    horizon: input.horizon,
    levelsAt: (index) => {
      const month = index + 1;
      const total = noDeltas();
      for (const assumption of assumptions) {
        if (!appliesIn(assumption, month)) continue;
        const deltas = deltasFor(assumption, input.basis);
        for (const leaf of LEAVES) total[leaf] = total[leaf].plus(deltas[leaf]);
      }
      return levelsWith(input.basis, total);
    },
    lastActualClosingCash: input.basis.lastActualClosingCash,
  });

  const scenarioByKey = new Map(scenarioPoints.map((p) => [key(p), p]));
  const metricOrder = new Map(FORECAST_METRICS.map((metricKey, index) => [metricKey as string, index]));
  /*
   * Months in HORIZON order, never in label order. "Nov 2026" sorts before "Oct 2026" before
   * "Sep 2026" alphabetically, and a cash chain read backwards tells the reader their balance is
   * falling when it is rising — the defect Phase 11 found and fixed on the forecast page.
   */
  const periodOrder = new Map(input.horizon.map((period, index) => [period.periodId, index]));

  const cells: ScenarioCell[] = [];
  for (const baseline of baselinePoints) {
    const scenario = scenarioByKey.get(key(baseline));
    // Symmetrical by construction: both sides compose the same leaves through the same identities,
    // so a metric present on one side is present on the other. The guard is here because a silent
    // `undefined` would become a cell claiming a change of zero.
    if (scenario === undefined) continue;

    const base = parseDecimalOrNull(baseline.value) ?? ZERO;
    const after = parseDecimalOrNull(scenario.value) ?? ZERO;
    const change = after.minus(base);

    cells.push({
      metricKey: baseline.metricKey,
      periodId: baseline.periodId,
      periodLabel: baseline.periodLabel,
      baselineValue: baseline.value,
      scenarioValue: scenario.value,
      change: money(change),
      /*
       * FINANCIAL_ENGINE.md §3.2's own rule, applied here so a scenario and a variance agree: a
       * percentage across zero is meaningless, so it is NULL and the money change still stands.
       */
      changeRatio: base.isZero() ? null : toRatioString(change.dividedBy(base.abs())),
      derivation: baseline.derivation,
      derivedFrom: baseline.from,
    });
  }

  cells.sort((a, b) => {
    const period = (periodOrder.get(a.periodId) ?? 99) - (periodOrder.get(b.periodId) ?? 99);
    return period !== 0
      ? period
      : (metricOrder.get(a.metricKey) ?? 99) - (metricOrder.get(b.metricKey) ?? 99);
  });

  return {
    method: SCENARIO_METHOD,
    configVersion: SCENARIO_CONFIG_VERSION,
    cells,
    unavailable: [],
    basis: input.forecastBasis,
  };
}
