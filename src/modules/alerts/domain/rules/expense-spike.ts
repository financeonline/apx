/**
 * `expense.spike_category` (FINANCIAL_ENGINE.md §8.2), the condition health rule K3 counts.
 *
 * Two thresholds must BOTH hold: a rise of at least 25%, and a rise worth at least 2% of revenue.
 * Either alone produces noise nobody reads — a category that went from £40 to £90 more than doubled,
 * and a 3% rise in the largest cost line is normal. Requiring both is what makes the count in K3 a
 * statement about the business rather than about how many categories the chart of accounts has.
 *
 * Pure.
 */

import { Decimal, toMoneyString, toRatioString } from '@/core/money';
import {
  accountIdsInCategory, componentOf, dimensionsOf, queryPin, usableValue, type RuleContext,
} from '../context';
import { minAbsThreshold } from '../suppression';
import { varianceKey } from '@/modules/financial-engine';
import type { MetricObservation, RuleOutcome } from '../types';

/** Defaults, CD-18. */
export const SPIKE_PCT_THRESHOLD = new Decimal('0.25');
export const SPIKE_REVENUE_SHARE = new Decimal('0.02');
export const SPIKE_HIGH_PCT = new Decimal('0.50');
export const SPIKE_HIGH_REVENUE_SHARE = new Decimal('0.05');
/** The floor that stands in for the revenue test when revenue is NULL (§8.2). */
export const SPIKE_ABSOLUTE_FLOOR = new Decimal('500');

const VARIANCE_KEY = varianceKey('expense_by_category', 'prev_period');

/**
 * N-5 (Step 0F): "what the rise was made of", from the source that STATED the figure.
 *
 * On the ledger basis that is the five largest entries (unchanged). On a trial-balance or P&L-report
 * basis there are no entries: the figure is the winning report's rows — its leaf selection, or for a
 * cumulative month BOTH year-to-date selections — exactly as the engine's own `evidence_query` names
 * them. Citing ledger entries there cited a source the figure never read (an empty or unrelated
 * selection). No usable query → no records pin, rather than a wrong one.
 */
function madeOf(
  ctx: RuleContext, current: MetricObservation | undefined, basis: string, ledger: () => ReturnType<typeof queryPin>,
  label: string,
): ReturnType<typeof queryPin> {
  // Ledger (and, unchanged here, any basis other than a report's) keeps the entries pin.
  if (basis !== 'period_balances') return ledger();
  const query = current?.evidenceQuery as {
    kind?: string; descriptor?: { table?: string; filters?: Record<string, unknown> };
    terms?: Array<{ sign: number; period_id: string | null; descriptor: { table?: string; filters?: Record<string, unknown> } | null }>;
  } | null | undefined;
  const pin = (filters: Record<string, unknown>, text: string) => queryPin(ctx, 'period_balances', filters, {
    label: text, claim: 'What the rise was made of',
  });
  if (query?.kind === 'leaf' && query.descriptor?.table === 'period_balances' && query.descriptor.filters) {
    return pin(query.descriptor.filters, `${label} — the report lines`);
  }
  if (query?.kind === 'difference' && Array.isArray(query.terms)) {
    return query.terms.flatMap((term) => (term.descriptor?.table === 'period_balances' && term.descriptor.filters
      ? pin(term.descriptor.filters, `${label} — ${term.sign === 1 ? 'year to date' : 'less: prior year to date'}`)
      : []));
  }
  return [];
}

/** The category a dimensioned observation is about; `dimension_key`, never `dimension_id` (ADR-053). */
function categoryOf(observation: MetricObservation): string | null {
  return observation.dimensionKey ?? null;
}

const ACCOUNT_VARIANCE_KEY = varianceKey('expense_by_account', 'prev_period');

/**
 * `expense.spike_account` (§8.2): the same test, one level down.
 *
 * Scoped to the ledger and trial-balance bases, because an account is a chart-of-accounts concept
 * and a bank-basis figure has no account behind it. The overlap with the category rule — an account
 * spiking inside a category that already fired — is suppressed by the evaluator through
 * `RULES['expense.spike_account'].supersededBy`, so the test lives in one place rather than being
 * re-derived here.
 */
export function evaluateExpenseSpikeAccount(ctx: RuleContext): readonly RuleOutcome[] {
  const revenue = usableValue(
    ctx.snapshots.find(
      (s) => s.periodId === ctx.periodId && s.metricKey === 'revenue' && s.dimensionId === null,
    ),
  );
  const floor = minAbsThreshold(revenue);
  const materialRise = revenue === null
    ? SPIKE_ABSOLUTE_FLOOR
    : revenue.times(SPIKE_REVENUE_SHARE);

  const accountsById = new Map(ctx.accounts.map((a) => [a.id, a]));
  const outcomes: RuleOutcome[] = [];

  const variances = [...dimensionsOf(ctx.snapshots, ctx.periodId, ACCOUNT_VARIANCE_KEY)]
    .filter((v) => v.dimensionId !== null)
    // §8.2: ledger/TB basis only.
    .filter((v) => v.basis === 'ledger' || v.basis === 'period_balances')
    .sort((a, b) => a.dimensionId!.localeCompare(b.dimensionId!));

  for (const variance of variances) {
    const rise = usableValue(variance);
    const pctChange = componentOf(variance, 'pct_change');
    if (rise === null || pctChange === null) continue;
    if (pctChange.lessThan(SPIKE_PCT_THRESHOLD)) continue;
    if (rise.lessThan(materialRise)) continue;
    if (rise.abs().lessThan(floor)) continue;

    const account = accountsById.get(variance.dimensionId!);

    outcomes.push({
      ruleKey: 'expense.spike_account',
      severity: 'medium',
      subject: { type: 'account', id: variance.dimensionId, key: null },
      periodId: ctx.periodId,
      metricKey: 'expense_by_account',
      thresholdSummary: {
        account: account?.name ?? null,
        category: account?.standardCategory ?? null,
        current: typeof variance.components.current === 'string' ? variance.components.current : null,
        previous: typeof variance.components.comparison === 'string'
          ? variance.components.comparison : null,
        value: toMoneyString(rise),
        pct_change: toRatioString(pctChange),
        threshold_pct: toRatioString(SPIKE_PCT_THRESHOLD),
        threshold_value: toMoneyString(materialRise),
      },
      snapshotIds: variance.snapshotId === null ? [] : [variance.snapshotId],
      recordIds: [],
      evidence: [
        ...(variance.snapshotId === null ? [] : [{
          itemType: 'metric_snapshot' as const,
          refId: variance.snapshotId,
          queryDescriptor: null,
          label: `${account?.name ?? 'The account'} against last month`,
          claim: 'The rise this alert is about',
          assuranceLevel: variance.assurance,
        }]),
        ...madeOf(ctx,
          ctx.snapshots.find((s) => s.periodId === ctx.periodId && s.metricKey === 'expense_by_account'
            && s.dimensionId === variance.dimensionId),
          variance.basis,
          () => queryPin(ctx, 'ledger_entries', {
            period_ids: [ctx.periodId],
            account_ids: [variance.dimensionId!],
          }, {
            label: `The five largest entries on ${account?.name ?? 'this account'}`,
            claim: 'What the rise was made of',
            order: [{ field: 'amount', dir: 'desc' }],
            limit: 5,
          }),
          account?.name ?? 'This account'),
      ],
    });
  }

  return outcomes;
}

/**
 * Every category whose spend spiked in this period.
 *
 * Deterministic order: categories are sorted by key, so two runs over identical data produce the
 * same outcomes in the same order — which is what makes the reproduction test in §7 meaningful.
 */
export function evaluateExpenseSpikeCategory(ctx: RuleContext): readonly RuleOutcome[] {
  const revenue = usableValue(
    ctx.snapshots.find(
      (s) => s.periodId === ctx.periodId && s.metricKey === 'revenue' && s.dimensionId === null,
    ),
  );
  const floor = minAbsThreshold(revenue);
  const materialRise = revenue === null
    ? SPIKE_ABSOLUTE_FLOOR
    : revenue.times(SPIKE_REVENUE_SHARE);
  const highRise = revenue === null ? null : revenue.times(SPIKE_HIGH_REVENUE_SHARE);

  const outcomes: RuleOutcome[] = [];

  const variances = [...dimensionsOf(ctx.snapshots, ctx.periodId, VARIANCE_KEY)]
    .sort((a, b) => (categoryOf(a) ?? '').localeCompare(categoryOf(b) ?? ''));

  for (const variance of variances) {
    const category = categoryOf(variance);
    if (category === null) continue;

    // `usableValue` returns NULL for a `basis_differs` variance, so a trial balance compared with a
    // bank statement can never fire this rule (§7.2, ADR-030.3).
    const rise = usableValue(variance);
    const pctChange = componentOf(variance, 'pct_change');
    if (rise === null || pctChange === null) continue;

    if (pctChange.lessThan(SPIKE_PCT_THRESHOLD)) continue;
    if (rise.lessThan(materialRise)) continue;
    // §8.1's absolute floor. A 30% rise on a £60 category is not a finding.
    if (rise.abs().lessThan(floor)) continue;

    const isHigh = pctChange.greaterThanOrEqualTo(SPIKE_HIGH_PCT)
      || (highRise !== null && rise.greaterThanOrEqualTo(highRise));
    const accountIds = accountIdsInCategory(ctx, category);

    outcomes.push({
      ruleKey: 'expense.spike_category',
      severity: isHigh ? 'high' : 'medium',
      subject: { type: 'standard_category', id: null, key: category },
      periodId: ctx.periodId,
      thresholdSummary: {
        category,
        current: typeof variance.components.current === 'string' ? variance.components.current : null,
        previous: typeof variance.components.comparison === 'string'
          ? variance.components.comparison : null,
        value: toMoneyString(rise),
        pct_change: toRatioString(pctChange),
        revenue: revenue === null ? null : toMoneyString(revenue),
        threshold_pct: toRatioString(SPIKE_PCT_THRESHOLD),
        threshold_value: toMoneyString(materialRise),
      },
      snapshotIds: variance.snapshotId === null ? [] : [variance.snapshotId],
      recordIds: [],
      evidence: [
        ...(variance.snapshotId === null ? [] : [{
          itemType: 'metric_snapshot' as const,
          refId: variance.snapshotId,
          queryDescriptor: null,
          label: `${category} against last month`,
          claim: 'The rise this alert is about',
          assuranceLevel: variance.assurance,
        }]),
        /*
         * §8.2 pins the five largest records in the category. A DESCRIPTOR rather than five ids: the
         * resolver reads it as of this run (ADR-034), so opening the alert in six months shows the
         * five that were largest THEN, not the five that are largest now.
         *
         * The category is resolved to ACCOUNT IDS here rather than stored as a category filter,
         * which the v1 vocabulary deliberately has no room for — a category is a mutable property of
         * an account, and a stored category filter would make this evidence follow a later remap.
         */
        ...madeOf(ctx,
          ctx.snapshots.find((s) => s.periodId === ctx.periodId && s.metricKey === 'expense_by_category'
            && s.dimensionKey === category),
          variance.basis,
          () => (accountIds.length === 0 ? [] : queryPin(ctx, 'ledger_entries', {
            period_ids: [ctx.periodId],
            account_ids: accountIds,
          }, {
            label: `The five largest ${category} transactions this period`,
            claim: 'What the rise was made of',
            order: [{ field: 'amount', dir: 'desc' }],
            limit: 5,
          })),
          category),
      ],
    });
  }

  return outcomes;
}
