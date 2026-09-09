import 'server-only';
import { assertCan } from '@/core/permissions';
import { NotFound } from '@/core/errors';
import { callApi } from '@/core/db/api-rpc';
import type { AccessContext } from '@/modules/tenancy';

/**
 * The analyst's allowance, as the person it applies to may see it (UX_ARCHITECTURE.md §5
 * `AnalystChat.quota`; ROUTE_ARCHITECTURE.md §121).
 *
 * `api.ai_quota_status` counts exactly what `api_server.ai_persist_turn` refuses on, so the notice
 * the page shows and the 429 the route answers can never disagree (ADR-079). A `null` limit means
 * the platform set none.
 */
export interface QuotaStatus {
  readonly usedToday: number;
  readonly dailyLimit: number | null;
  readonly remainingToday: number | null;
  readonly tokensMonth: number;
  readonly monthlyCeiling: number | null;
  readonly monthlyExhausted: boolean;
  /** ISO instant of the next UTC midnight — when `usedToday` returns to zero. */
  readonly resetsAt: string;
}

interface QuotaRow {
  used_today: number;
  daily_limit: number | null;
  remaining_today: number | null;
  tokens_month: number;
  monthly_ceiling: number | null;
  monthly_exhausted: boolean;
  resets_at: string;
}

export async function aiQuotaStatus(ctx: AccessContext): Promise<QuotaStatus> {
  assertCan(ctx, 'ai.use');
  if (!ctx.orgId) throw new NotFound();
  const row = await callApi<QuotaRow>(ctx.db, 'ai_quota_status', { p_org: ctx.orgId }, ctx.requestId);
  return {
    usedToday: row.used_today,
    dailyLimit: row.daily_limit,
    remainingToday: row.remaining_today,
    tokensMonth: row.tokens_month,
    monthlyCeiling: row.monthly_ceiling,
    monthlyExhausted: row.monthly_exhausted,
    resetsAt: row.resets_at,
  };
}

/** Whether a question would be refused right now, and why — the page's notice, before the 429. */
export function quotaExhausted(quota: QuotaStatus): 'daily' | 'monthly' | null {
  if (quota.monthlyExhausted) return 'monthly';
  if (quota.remainingToday !== null && quota.remainingToday <= 0) return 'daily';
  return null;
}
