import { Decimal, parseDecimalOrNull, toMoneyString } from '@/core/money';
import { FORECAST_CONFIG_VERSION, FORECAST_METHOD } from './config';
import { buildBaseline, selectWindow } from './baseline';
import type {
  ActualPoint, Baseline, ForecastPoint, ForecastResult, HorizonPeriod, Unforecastable,
} from './types';

/**
 * Composing the forecast (REQ-FC-01; ADR-099).
 *
 * **Leaves are forecast; everything else is derived.** The engine's registry already states how the
 * figures relate — `operating_profit` depends on `gross_profit` and `operating_expenses`,
 * `closing_cash` on `opening_cash` and `net_cash_movement` — and a forecast that averaged
 * `operating_profit` directly would eventually disagree with its own components, which is the one
 * thing a reader would notice and never trust again. So the same identities the engine uses are
 * applied here, and §7's requirement that the relationship be deterministic is met by construction
 * rather than by assertion.
 *
 *   revenue, cost_of_sales, operating_expenses   ← baseline
 *   gross_profit      = revenue − cost_of_sales
 *   operating_profit  = gross_profit − operating_expenses
 *
 *   cash_inflows, cash_outflows                  ← baseline
 *   net_cash_movement = cash_inflows − cash_outflows
 *   closing_cash      = previous closing + net_cash_movement   (chained, §8)
 *
 *   receivables, payables                        ← baseline
 *
 * The cash chain starts from the last ACTUAL closing cash, never from an averaged one: a bank
 * balance is a fact on a date, and averaging the last few months' balances to open the forecast
 * would invent a balance the business never had (§8, "do not invent bank balances").
 *
 * Pure.
 */

/** The metrics a baseline is taken over. Everything else in the result is derived from these. */
export const FORECAST_LEAVES = [
  'revenue', 'cost_of_sales', 'operating_expenses',
  'cash_inflows', 'cash_outflows',
  'receivables', 'payables',
] as const;

/** The metrics the result speaks about, leaves and identities together. */
export const FORECAST_METRICS = [
  'revenue', 'operating_expenses', 'gross_profit', 'operating_profit',
  'cash_inflows', 'cash_outflows', 'net_cash_movement', 'closing_cash',
  'receivables', 'payables',
] as const;

export interface ComposeInput {
  /** Actual history per metric key, any order; the window selector sorts and trims. */
  readonly history: Readonly<Record<string, readonly ActualPoint[]>>;
  /** The future periods to speak about, oldest first. Real `fiscal_periods` rows only. */
  readonly horizon: readonly HorizonPeriod[];
  /**
   * The most recent ACTUAL closing cash, and the period it belongs to. `null` when the organisation
   * has no bank data — in which case the cash chain is not started and closing cash is absent
   * rather than guessed (§8).
   */
  readonly lastActualClosingCash: string | null;
}

const money = (value: Decimal): string => toMoneyString(value.toDecimalPlaces(2));

function point(
  metricKey: string, period: HorizonPeriod, value: Decimal,
  derivation: ForecastPoint['derivation'], from: readonly string[] = [],
): ForecastPoint {
  return {
    metricKey,
    periodId: period.periodId,
    periodLabel: period.periodLabel,
    value: money(value),
    // REQ-FC-05, without exception: a forecast of verified actuals is still a forecast.
    assurance: 'estimated',
    derivation,
    from,
  };
}

export function composeForecast(input: ComposeInput): ForecastResult {
  const baselines: Record<string, Baseline> = {};
  const unavailable: Unforecastable[] = [];

  for (const key of FORECAST_LEAVES) {
    const points = input.history[key] ?? [];
    const verdict = selectWindow(points);
    if (!verdict.ok) {
      unavailable.push({ metricKey: key, reason: verdict.reason, periodsFound: verdict.periodsFound });
      continue;
    }
    baselines[key] = buildBaseline(key, verdict.window);
  }

  const level = (key: string): Decimal | null => {
    const baseline = baselines[key];
    return baseline === undefined ? null : parseDecimalOrNull(baseline.value);
  };

  const out: ForecastPoint[] = [];
  let carriedCash = input.lastActualClosingCash === null
    ? null
    : parseDecimalOrNull(input.lastActualClosingCash);

  for (const period of input.horizon) {
    const revenue = level('revenue');
    const costOfSales = level('cost_of_sales');
    const opex = level('operating_expenses');
    const inflows = level('cash_inflows');
    const outflows = level('cash_outflows');

    if (revenue !== null) out.push(point('revenue', period, revenue, 'baseline'));
    if (opex !== null) out.push(point('operating_expenses', period, opex, 'baseline'));
    if (inflows !== null) out.push(point('cash_inflows', period, inflows, 'baseline'));
    if (outflows !== null) out.push(point('cash_outflows', period, outflows, 'baseline'));
    for (const key of ['receivables', 'payables'] as const) {
      const value = level(key);
      if (value !== null) out.push(point(key, period, value, 'baseline'));
    }

    /*
     * Gross profit needs BOTH sides. An organisation with no cost-of-sales accounts has no gross
     * profit at all in the engine either (CD-05), and inventing one by treating cost of sales as
     * zero would turn "we cannot tell" into "it is all margin".
     */
    const grossProfit = revenue !== null && costOfSales !== null ? revenue.minus(costOfSales) : null;
    if (grossProfit !== null) {
      out.push(point('gross_profit', period, grossProfit, 'identity', ['revenue', 'cost_of_sales']));
    }

    if (grossProfit !== null && opex !== null) {
      out.push(point('operating_profit', period, grossProfit.minus(opex), 'identity',
        ['gross_profit', 'operating_expenses']));
    }

    if (inflows !== null && outflows !== null) {
      const movement = inflows.minus(outflows);
      out.push(point('net_cash_movement', period, movement, 'identity',
        ['cash_inflows', 'cash_outflows']));

      // §8: the chain opens on the last real balance and then on its own previous close. Without a
      // real opening balance there is no closing balance to state.
      if (carriedCash !== null) {
        const closing = carriedCash.plus(movement);
        out.push(point('closing_cash', period, closing, 'identity',
          ['opening_cash', 'net_cash_movement']));
        carriedCash = closing;
      }
    }
  }

  /*
   * `closing_cash` is the one metric that can be unavailable for a reason the baselines do not
   * show: the components were forecastable but the organisation has no bank balance to start from.
   * Saying so is the difference between "we have not worked it out" and "we cannot".
   */
  if (baselines.cash_inflows !== undefined && baselines.cash_outflows !== undefined
      && input.lastActualClosingCash === null) {
    unavailable.push({ metricKey: 'closing_cash', reason: 'metric_not_computable', periodsFound: 0 });
  }

  const present = Object.values(baselines);
  const basis = present.length === 0
    ? null
    : present.some((b) => b.basis === 'weak') ? 'weak'
      : present.some((b) => b.basis === 'limited') ? 'limited' : 'strong';

  return {
    method: FORECAST_METHOD,
    configVersion: FORECAST_CONFIG_VERSION,
    horizon: input.horizon,
    baselines,
    points: out,
    unavailable,
    basis,
  };
}
