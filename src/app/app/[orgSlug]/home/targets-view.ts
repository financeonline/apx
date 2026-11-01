import 'server-only';
import { Decimal, tryParseDecimal } from '@/core/money';
import { assessTargets, parseMonthlyTargets, type MonthlyTargets } from '@/modules/targets';
import type { TargetActuals } from '@/modules/departments';
import type { TargetsCheckView } from '@/components/department-dashboard/types';
import { compactMoney } from './dash-format';

/**
 * The monthly target check as the dashboard shows it (`operations.js#renderTargets`,
 * `#renderTargetsPreview`, `#renderTargetChart`): `assessTargets` (Decimal) formatted, plus the
 * card's chart scale. Used for the first render and by `assessTargetsAction` while typing.
 */
export function targetsCheckView(
  month: string, input: unknown, history: readonly TargetActuals[], currency: string,
): TargetsCheckView {
  const targets: MonthlyTargets = parseMonthlyTargets(input);
  const actual = history.find((h) => h.month === month) ?? null;
  const assessment = actual === null ? null : assessTargets(actual, targets);

  const show = (unit: 'tasks' | 'money' | 'percent', v: string): string =>
    unit === 'money' ? compactMoney(v, currency)
      : unit === 'percent' ? `${new Decimal(v).toFixed(1)}%`
        : `${new Decimal(v).toFixed(0)} tasks`;

  const items = (assessment?.items ?? []).map((item) => ({
    key: item.key,
    label: item.label,
    status: item.status,
    actual: item.actual === null ? 'No figure' : show(item.unit, item.actual),
    target: `${item.direction === 'max' ? 'max ' : ''}${show(item.unit, item.target)}`,
    meterPercent: item.meterPercent ?? '0',
  }));
  const hasActuals = assessment !== null && assessment.hasActuals;

  // The chart: the six months' sales against the selected target, scaled as the prototype
  // (largest of target and sales × 1.12).
  const sales = history.map((h) => tryParseDecimal(h.sales));
  const target = new Decimal(targets.sales);
  const top = Decimal.max(target, ...sales.filter((d): d is Decimal => d !== null));
  const cap = top.times('1.12');
  return {
    month,
    hasActuals,
    warnings: assessment?.warnings ?? 0,
    items: hasActuals ? items : [],
    preview: hasActuals && actual ? {
      salesActual: compactMoney(actual.sales, currency),
      salesTarget: compactMoney(targets.sales, currency),
      marketingActual: compactMoney(actual.marketing, currency),
      marketingTarget: compactMoney(targets.marketing, currency),
    } : null,
    chart: {
      labels: history.map((h) => h.label),
      sales: sales.map((d) => (d === null ? null : d.toNumber())),
      titles: history.map((h) => `${h.label}: ${h.sales === null ? 'no figure' : compactMoney(h.sales, currency)}`),
      target: target.toNumber(),
      cap: cap.isZero() ? 1 : cap.toNumber(),
      ticks: [compactMoney('0', currency), compactMoney(cap.dividedBy(2), currency), compactMoney(cap, currency)],
    },
  };
}
