import { ValidationError } from '@/core/errors';
import { Decimal, divide, multiply, toMoneyString, toRatioString, tryParseDecimal } from '@/core/money';

/**
 * Monthly targets of the department dashboard (docs/DEPARTMENT_DASHBOARD_PLAN.md, "Make the next
 * move" → Monthly targets dialog). Pure: the prototype's `defaultTargets` and `assessTargets`
 * (`operations-model.js`), with money and ratios as Decimal (ADR-006) and a missing actual stated as
 * missing rather than judged.
 */

/** One month's targets. Money and percentages are decimal strings; the workflow target is a count. */
export interface MonthlyTargets {
  /** Completed workflow tasks in the month (at least). Whole number, 1–1,000,000. */
  readonly workflow: number;
  /** Sales in the month (at least). Money, more than 0. */
  readonly sales: string;
  /** Marketing spend in the month (at most). Money, 0 or more. */
  readonly marketing: string;
  /** Costs as a percentage of revenue (at most). 0–1000, one decimal place. */
  readonly costRatio: string;
  /** Marketing spend as a percentage of revenue (at most). 0–1000, one decimal place. */
  readonly marketingRatio: string;
}

export type TargetKey = keyof MonthlyTargets;

/** The prototype's illustrative starting values, shown until a month's targets are saved. */
export const DEFAULT_TARGETS: MonthlyTargets = {
  workflow: 80,
  sales: '300000',
  marketing: '15000',
  costRatio: '65',
  marketingRatio: '5',
};

/** The bounds of the prototype's targets dialog inputs. */
export const TARGET_LIMITS = {
  workflow: { min: 1, max: 1_000_000 },
  sales: { max: '100000000' },
  marketing: { max: '100000000' },
  ratio: { min: '0', max: '1000' },
} as const;

/** `YYYY-MM` from 2020-01 to 2100-12 (the prototype's month input range). */
export function isTargetMonth(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  return year >= 2020 && year <= 2100;
}

export function parseTargetMonth(value: unknown): string {
  if (!isTargetMonth(value)) {
    throw new ValidationError('Choose a valid reporting month.', [{ path: 'month', message: 'A month is YYYY-MM, from 2020-01 to 2100-12.' }]);
  }
  return value;
}

/** A plain decimal from a string or a finite number (the dialog sends either); null otherwise. */
function decimalFrom(value: unknown): Decimal | null {
  if (typeof value === 'number') return Number.isFinite(value) ? new Decimal(value) : null;
  if (typeof value !== 'string' || !/^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(value)) return null;
  return tryParseDecimal(value);
}

/**
 * Validates the dialog's five fields and returns them normalised (money to two decimal places,
 * percentages to one), or throws ValidationError with one issue per field. The database function
 * repeats these checks; this copy exists so the person sees which field is wrong.
 */
export function parseMonthlyTargets(input: unknown): MonthlyTargets {
  const t = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const issues: Array<{ path: string; message: string }> = [];

  const workflowValue = decimalFrom(t.workflow);
  let workflow = 0;
  if (workflowValue === null || !workflowValue.isInteger()
    || workflowValue.lt(TARGET_LIMITS.workflow.min) || workflowValue.gt(TARGET_LIMITS.workflow.max)) {
    issues.push({ path: 'workflow', message: 'Enter a whole number of completed tasks from 1 to 1,000,000.' });
  } else {
    workflow = workflowValue.toNumber();
  }

  const money = (key: 'sales' | 'marketing', positive: boolean): string => {
    const d = decimalFrom(t[key]);
    const label = key === 'sales' ? 'Sales' : 'Marketing spend';
    if (d === null || d.decimalPlaces() > 2) {
      issues.push({ path: key, message: `${label} is an amount, to at most two decimal places.` });
      return '0.00';
    }
    if (positive ? d.lte(0) : d.lt(0)) {
      issues.push({ path: key, message: `${label} must be ${positive ? 'more than' : 'at least'} 0.` });
      return '0.00';
    }
    if (d.gt(TARGET_LIMITS[key].max)) {
      issues.push({ path: key, message: `${label} is at most 100,000,000.` });
      return '0.00';
    }
    return toMoneyString(d);
  };

  const ratio = (key: 'costRatio' | 'marketingRatio'): string => {
    const d = decimalFrom(t[key]);
    const label = key === 'costRatio' ? 'Cost / revenue' : 'Marketing / revenue';
    if (d === null || d.decimalPlaces() > 1 || d.lt(TARGET_LIMITS.ratio.min) || d.gt(TARGET_LIMITS.ratio.max)) {
      issues.push({ path: key, message: `${label} is a percentage from 0 to 1000, to one decimal place.` });
      return '0.0';
    }
    return d.toFixed(1);
  };

  const parsed: MonthlyTargets = {
    workflow,
    sales: money('sales', true),
    marketing: money('marketing', false),
    costRatio: ratio('costRatio'),
    marketingRatio: ratio('marketingRatio'),
  };
  if (issues.length > 0) throw new ValidationError('Some targets need fixing.', issues);
  return parsed;
}

/** The expected revision a save carries: a whole number, 0 for a month with nothing saved. */
export function parseExpectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError('Reload the targets and try again.', [
      { path: 'expectedRevision', message: 'The expected revision is a whole number (0 when nothing was saved).' },
    ]);
  }
  return value;
}

// ── Assessment ───────────────────────────────────────────────────────────────────────────────────

/** The month's actual figures. `null` = not known (no figures, or not established) — never zero. */
export interface TargetActuals {
  readonly sales: string | null;
  readonly costs: string | null;
  readonly marketing: string | null;
  readonly workflowCompleted: number | null;
}

export type TargetStatus = 'on-track' | 'attention' | 'missing';

export interface TargetItem {
  readonly key: TargetKey;
  readonly label: string;
  readonly unit: 'tasks' | 'money' | 'percent';
  /** `min`: the actual should reach the target; `max`: it should stay at or under it. */
  readonly direction: 'min' | 'max';
  /** Tasks as a whole number, money to the penny, a percentage to six decimal places; null = missing. */
  readonly actual: string | null;
  readonly target: string;
  readonly status: TargetStatus;
  /** The prototype's meter: actual ÷ target × 100, held to 0–100, one decimal place; null = missing. */
  readonly meterPercent: string | null;
}

export interface TargetAssessment {
  /** Always the five items, in the prototype's order. */
  readonly items: readonly TargetItem[];
  /** Items that need attention (a missing item is not counted). */
  readonly warnings: number;
  /** Items that could not be judged, because an actual they need is missing. */
  readonly missing: readonly TargetKey[];
  /** False when no item could be judged — the prototype's "Data completion required". */
  readonly hasActuals: boolean;
}

const HUNDRED = new Decimal(100);

function meter(actual: Decimal, target: Decimal): string {
  if (target.isZero()) return '100.0';
  const pct = divide(multiply(actual, HUNDRED), target) ?? HUNDRED;
  return Decimal.max(0, Decimal.min(100, pct)).toFixed(1);
}

/**
 * The prototype's `assessTargets`, item for item: Workflow completion (min), Sales (min), Marketing
 * spend (max), Cost / revenue (max), Marketing / revenue (max); on track when the actual meets the
 * direction (`>=` for min, `<=` for max), otherwise attention.
 *
 * A ratio needs both of its figures and a sales figure above zero (a ratio of nothing to nothing is
 * not a fact); without them the item is missing. Ratios are compared at full precision and reported
 * to six decimal places.
 */
export function assessTargets(actuals: TargetActuals, targets: MonthlyTargets): TargetAssessment {
  const sales = tryParseDecimal(actuals.sales);
  const costs = tryParseDecimal(actuals.costs);
  const marketing = tryParseDecimal(actuals.marketing);
  const workflow = actuals.workflowCompleted === null || !Number.isFinite(actuals.workflowCompleted)
    ? null : new Decimal(actuals.workflowCompleted);
  const ratioOf = (part: Decimal | null): Decimal | null =>
    (part === null || sales === null || !sales.gt(0) ? null : divide(multiply(part, HUNDRED), sales));

  const specs: ReadonlyArray<{
    key: TargetKey; label: string; unit: TargetItem['unit']; direction: TargetItem['direction'];
    actual: Decimal | null; target: Decimal; show: (d: Decimal) => string;
  }> = [
    { key: 'workflow', label: 'Workflow completion', unit: 'tasks', direction: 'min', actual: workflow, target: new Decimal(targets.workflow), show: (d) => d.toFixed(0) },
    { key: 'sales', label: 'Sales', unit: 'money', direction: 'min', actual: sales, target: new Decimal(targets.sales), show: (d) => toMoneyString(d) },
    { key: 'marketing', label: 'Marketing spend', unit: 'money', direction: 'max', actual: marketing, target: new Decimal(targets.marketing), show: (d) => toMoneyString(d) },
    { key: 'costRatio', label: 'Cost / revenue', unit: 'percent', direction: 'max', actual: ratioOf(costs), target: new Decimal(targets.costRatio), show: (d) => toRatioString(d) },
    { key: 'marketingRatio', label: 'Marketing / revenue', unit: 'percent', direction: 'max', actual: ratioOf(marketing), target: new Decimal(targets.marketingRatio), show: (d) => toRatioString(d) },
  ];

  const items: TargetItem[] = specs.map((s) => {
    const targetText = s.unit === 'money' ? toMoneyString(s.target) : s.unit === 'tasks' ? s.target.toFixed(0) : s.target.toString();
    if (s.actual === null) {
      return { key: s.key, label: s.label, unit: s.unit, direction: s.direction, actual: null, target: targetText, status: 'missing', meterPercent: null };
    }
    const met = s.direction === 'min' ? s.actual.gte(s.target) : s.actual.lte(s.target);
    return {
      key: s.key, label: s.label, unit: s.unit, direction: s.direction,
      actual: s.show(s.actual), target: targetText,
      status: met ? 'on-track' : 'attention',
      meterPercent: meter(s.actual, s.target),
    };
  });

  const missing = items.filter((i) => i.status === 'missing').map((i) => i.key);
  return {
    items,
    warnings: items.filter((i) => i.status === 'attention').length,
    missing,
    hasActuals: missing.length < items.length,
  };
}
