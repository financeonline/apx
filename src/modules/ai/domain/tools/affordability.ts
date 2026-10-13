import { z } from 'zod';
import { RECURRENCES, checkAffordability, parseWrittenAmount, writtenInQuestion, type AffordabilityUnavailable } from '@/modules/scenarios';
import { NotFound, PermissionDenied } from '@/core/errors';
import { count, fail, money, ok } from './envelope';
import type { ToolDefinition } from './types';

/**
 * Tool 28 (ADR-146): "can we afford it?" — worked out by MOTION, reported by the analyst.
 *
 * The one tool that takes a money amount from the conversation, so it is fenced three ways:
 *
 *   1. **The amount is the person's, verbatim.** `amount_as_written` must appear in THIS turn's
 *      question, character for character apart from case and spacing; the tool parses it itself. A
 *      model that invented or "rounded" an amount gets a refusal, not a figure.
 *   2. **The arithmetic is MOTION's.** The check is `checkAffordability` — the What-if page's own
 *      service, applied to the stored forecast through the forecast's own composer.
 *   3. **What the model chose is echoed back.** The amount, one-off or monthly, and the start month
 *      all return in the result, so the answer states the assumptions it was checked under.
 *
 * Nothing is stored. `dashboard.view`, as `get_forecast` is.
 */

const asToolError = (e: unknown) =>
  e instanceof PermissionDenied ? fail({ code: 'PERMISSION_DENIED' as const, message: e.message })
  : e instanceof NotFound ? fail({ code: 'NOT_FOUND' as const, message: 'That is not something this conversation can open.' })
  : null;

const UNAVAILABLE_MESSAGE: Readonly<Record<AffordabilityUnavailable, string>> = {
  no_forecast: 'No forecast has been worked out for this organisation yet, and an affordability check starts from one. It is worked out on the Forecast page.',
  no_cash_forecast: 'The forecast cannot state closing cash for the months ahead (there is no bank balance to start from, or no money out to forecast), so affordability cannot be checked.',
  starts_after_horizon: 'That start month is beyond the months the forecast covers.',
  invalid_amount: 'That amount is not one APX can check (it must be more than zero and less than a billion).',
};

export const checkAffordabilityTool: ToolDefinition<{ amount_as_written: string; recurrence: 'one_off' | 'monthly'; starts_in_month?: number }, unknown> = {
  name: 'check_affordability',
  description:
    'Whether the business can afford a proposed expenditure, worked out by APX against its cash forecast: closing cash in each forecast month as expected and after the spend, the lowest point, a one-month buffer of normal money out, and a verdict (affordable, tight or not_affordable). Use it for "can we afford…" questions ONLY when the person stated an amount. `amount_as_written` must be copied exactly as the person wrote it in their question (for example "£25,000" or "5k"); never convert, round or supply it yourself. `recurrence` is "one_off" for a single payment or "monthly" for a cost that repeats every month — use what the person said. `starts_in_month` is 1 for the first forecast month (the default), 2 for the second, and so on. If no amount was given, do not call this tool.',
  permission: 'dashboard.view',
  input: z.object({
    amount_as_written: z.string().min(1).max(40),
    recurrence: z.enum(RECURRENCES),
    starts_in_month: z.number().int().min(1).max(12).optional(),
  }),
  async run(input, call) {
    try {
      if (call.question === undefined || !writtenInQuestion(input.amount_as_written, call.question)) {
        return fail({
          code: 'NOT_FOUND',
          message: 'That amount is not in the question as written. Only an amount the person typed can be checked; ask them for it.',
        });
      }
      const amount = parseWrittenAmount(input.amount_as_written);
      if (amount === null) {
        return fail({ code: 'NOT_FOUND', message: 'That is not an amount APX can read. Ask the person for the amount in figures, for example 25000 or £25,000.' });
      }
      const check = await checkAffordability(call.ctx, {
        amount, recurrence: input.recurrence, startsInMonth: input.starts_in_month ?? 1,
      });
      const r = check.result;
      if (r.unavailable !== null) {
        return fail({ code: r.unavailable === 'invalid_amount' || r.unavailable === 'starts_after_horizon' ? 'NOT_FOUND' : 'NO_DATA', message: UNAVAILABLE_MESSAGE[r.unavailable] });
      }
      const c = check.currency;
      return ok({
        method: r.method,
        rule: 'Affordable: the lowest closing cash over the forecast months, after the spend, is at least one month of normal money out. Tight: it stays at or above zero but below that. Not affordable: it goes below zero. Cash only; profit is not assessed; nothing beyond the forecast months is assumed.',
        verdict: r.verdict,
        verdict_without_the_spend: r.verdictWithout,
        amount: money(r.amount, c),
        recurrence: r.recurrence,
        starts: check.startLabel,
        starts_in_month: count(r.startsInMonth, 0),
        total_spent_over_forecast: money(r.totalSpent, c),
        months: r.months.map((m) => ({
          period: m.periodLabel,
          period_id: m.periodId,
          expected_closing_cash: money(m.expectedCash, c),
          closing_cash_after_spend: money(m.cashAfter, c),
        })),
        lowest_after_spend: r.lowest === null ? null : { period: r.lowest.periodLabel, value: money(r.lowest.cashAfter, c) },
        lowest_without_spend: r.lowestWithout === null ? null : { period: r.lowestWithout.periodLabel, value: money(r.lowestWithout.expectedCash, c) },
        buffer_one_month_money_out: money(r.buffer, c),
        headroom_over_buffer: money(r.headroom, c),
        forecast_basis: check.forecast?.basis ?? null,
        stale: check.forecast?.stale ?? null,
        evidence_bundle_id: check.forecast?.evidenceBundleId ?? null,
      }, { periods: [], calculation_run_id: null }, call);
    } catch (e) { const mapped = asToolError(e); if (mapped) return mapped; throw e; }
  },
};
