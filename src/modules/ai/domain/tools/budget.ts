import { z } from 'zod';
import { budgetVarianceFor } from '@/modules/budgets';
import { fail, money, ok, ratio, resolvePeriodArg } from './envelope';
import type { ToolDefinition } from './types';

/**
 * Tool 27 (ADR-142): budget against actual for one month.
 *
 * Reads the Budget page's own service. The budget figures are the imported plan; the actual figures
 * are the engine's snapshots for the month, each with its snapshot id; the difference is the
 * service's, never the model's. A line the engine could not state comes back with no actual and no
 * difference — the reason is a code, never a zero.
 */
export const getBudgetVariance: ToolDefinition<{ period?: string }, unknown> = {
  name: 'get_budget_variance',
  description:
    'Budget against actual for one month: each profit-and-loss line with the budgeted amount, the actual figure and the difference. Use this for "are we on budget", "over or under budget" and "how did we do against plan" questions. `period` must be a label from period_context. If no budget was imported for the month, it says so.',
  permission: 'financials.view',
  input: z.object({ period: z.string().optional() }),
  async run(input, call) {
    const resolved = resolvePeriodArg(input.period, call);
    if (!resolved.ok) return fail(resolved.error);
    const { ctx } = call;
    const period = resolved.period;
    const result = await budgetVarianceFor(ctx.db, ctx.orgId!, period.id, ctx.requestId);
    if (result.variance === null) {
      return fail({ code: 'NO_DATA', message: 'No budget has been imported for that month.' });
    }
    const currency = result.currency;
    return ok({
      source: 'imported_budget',
      lines: result.variance.rows.map((row) => ({
        line: row.key,
        kind: row.kind,
        budget: money(row.budget, currency),
        actual: money(row.actual, currency),
        snapshot_id: row.actualSnapshotId,
        actual_unavailable: row.actual === null ? row.actualMissing : null,
        difference: money(row.variance, currency),
        difference_share_of_budget: ratio(row.variancePct),
        favourable: row.favourable,
        budget_counts_missing_categories_as_nil: row.assumedZero,
      })),
      not_compared: result.variance.notCompared.map((n) => ({ category: n.category, budget: money(n.budget, currency) })),
    }, { periods: [period], calculation_run_id: null }, call);
  },
};
