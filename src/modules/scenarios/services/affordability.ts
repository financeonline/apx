import 'server-only';
import { assertCan } from '@/core/permissions';
import { hasForecast, loadForecast, type ForecastView } from '@/modules/forecast';
import type { AccessContext } from '@/modules/tenancy';
import { assessAffordability, type AffordabilityResult, type Recurrence } from '../domain/affordability';
import { basisFromForecast } from './index';

/**
 * An affordability check (SOW §12; ADR-146), worked out against the stored forecast and NOT stored.
 *
 * `financials.view`, as reading the forecast is (ADR-172): nothing is written, and the check says no more than
 * the forecast already does plus the amount the person gave. The AI tool and the What-if page's form
 * both call this, so the analyst and the page cannot disagree.
 */

export interface AffordabilityCheck {
  readonly result: AffordabilityResult;
  readonly currency: string | null;
  readonly startLabel: string | null;
  readonly forecast: {
    readonly runId: string; readonly basis: ForecastView['basis']; readonly stale: boolean;
    readonly generatedAt: string; readonly evidenceBundleId: string | null;
  } | null;
}

export async function checkAffordability(
  ctx: AccessContext,
  input: { readonly amount: string; readonly recurrence: Recurrence; readonly startsInMonth: number },
): Promise<AffordabilityCheck> {
  assertCan(ctx, 'financials.view');
  const state = await loadForecast(ctx);
  if (!hasForecast(state) || state.periods.length === 0) {
    return {
      result: assessAffordability({ ...input, basis: { leafLevels: {}, categoryLevels: {}, lastActualClosingCash: null }, horizon: [] }),
      currency: null, startLabel: null, forecast: null,
    };
  }
  const horizon = state.periods.map((p) => ({ periodId: p.periodId, periodStart: p.periodStart, periodLabel: p.periodLabel }));
  const result = assessAffordability({ ...input, basis: basisFromForecast(state), horizon });
  let currency: string | null = null;
  for (const period of state.periods) for (const m of period.metrics) currency ??= m.currency;
  return {
    result,
    currency,
    startLabel: horizon[input.startsInMonth - 1]?.periodLabel ?? null,
    forecast: {
      runId: state.runId, basis: state.basis, stale: state.stale,
      generatedAt: state.generatedAt, evidenceBundleId: state.evidenceBundleId,
    },
  };
}
