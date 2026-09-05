/**
 * Factor sentences (FINANCIAL_ENGINE.md §7.3 templates, §7.4 `positives_structured`).
 *
 * Every sentence is a template plus typed values, never a string built by concatenation at the call
 * site. Two reasons, and both are load-bearing:
 *
 *   1. The AI's allowed set is built from `values` and not from the rendered prose (ADR-032.1). A
 *      model may quote "8.3%" because that figure is a typed field; it cannot invent "about 8%" from
 *      a sentence, because the sentence is not what it is allowed to read.
 *   2. Copy changes are then a change to one table, not a search through six rule files, and the
 *      numbers cannot drift out of the words when it happens.
 *
 * Pure.
 */

import { Decimal, formatMoney, formatPercent } from '@/core/money';
import type { FactorSentence } from './types';

export type TemplateId =
  | 'net_margin_healthy'
  | 'gross_margin_improved'
  | 'made_a_loss'
  | 'gross_margin_fell'
  | 'runway_months'
  | 'cash_fell_months'
  | 'cash_grew'
  | 'revenue_up_yoy'
  | 'revenue_down'
  | 'revenue_volatile'
  | 'costs_grew_slower'
  | 'category_spend_jumped'
  | 'no_customer_dominant'
  | 'customer_concentration'
  | 'collections_slow'
  | 'bank_balance_rising'
  | 'bank_balance_falling'
  | 'bank_anomalies';

type Renderer = (values: Readonly<Record<string, string>>, currency: string) => string;

function money(value: string, currency: string): string {
  return formatMoney(new Decimal(value), { currency });
}

function percent(value: string): string {
  return formatPercent(new Decimal(value));
}

/** Percentage POINTS, not a percentage of a percentage: a margin moving 0.031 is "3.1 pts". */
function points(value: string): string {
  return new Decimal(value).abs().times(100).toDecimalPlaces(1).toString();
}

const TEMPLATES: Readonly<Record<TemplateId, Renderer>> = {
  net_margin_healthy: (v) => `Net margin of ${percent(v.net_margin!)} is healthy`,
  gross_margin_improved: (v) =>
    `Gross margin improved ${points(v.delta!)} pts over the last 3 months`,
  made_a_loss: (v, c) => `The business made a loss of ${money(v.net_profit!, c)} this month`,
  gross_margin_fell: (v) => `Gross margin fell ${points(v.delta!)} pts over the last 3 months`,
  runway_months: (v) => `Cash would last about ${v.runway} months at the current rate`,
  cash_fell_months: (v) => `Cash fell for ${v.n} months in a row`,
  cash_grew: (v, c) => `Cash grew by ${money(v.net_cash_movement!, c)} this month`,
  revenue_up_yoy: (v) => `Revenue is up ${percent(v.pct!)} on ${v.comparison}`,
  revenue_down: (v) => `Revenue is down ${percent(v.pct!)} on ${v.comparison}`,
  revenue_volatile: () => 'Revenue swings a lot month to month',
  costs_grew_slower: () => 'Costs grew slower than revenue',
  category_spend_jumped: (v) => `${v.category} spending jumped ${percent(v.pct!)} this month`,
  no_customer_dominant: (v) => `No single customer is more than ${percent(v.share!)} of revenue`,
  customer_concentration: (v) =>
    `Your largest customer is ${percent(v.share!)} of revenue — a concentration risk`,
  collections_slow: (v) => `Customers take about ${v.days} days to pay`,
  bank_balance_rising: () => 'The bank balance has risen for three months',
  bank_balance_falling: () => 'The bank balance has fallen for three months',
  bank_anomalies: (v) => `${v.count} unusual banking items need a look`,
};

/**
 * Render one factor sentence.
 *
 * `snapshotIds` are the figures the sentence rests on, so the explainability panel can link the
 * words straight to the numbers rather than asking the reader to take them on trust.
 */
export function sentence(
  templateId: TemplateId,
  values: Readonly<Record<string, string>>,
  currency: string,
  snapshotIds: readonly (string | null)[] = [],
): FactorSentence {
  return {
    template_id: templateId,
    text: TEMPLATES[templateId](values, currency),
    values,
    // An in-flight snapshot has no id yet; pinning `null` would put a dead link in the panel.
    snapshot_ids: snapshotIds.filter((id): id is string => id !== null),
  };
}

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as readonly TemplateId[];
