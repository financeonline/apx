import 'server-only';
import { callApi } from '@/core/db/api-rpc';
import { NotFound } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import { marketingEnabled } from './read';

/**
 * Asking for the marketing report to be written, or rewritten (ADR-170).
 *
 * Spending AI on it takes `reports.generate` (it produces a stored report) and `ai.use` (it is a model
 * call) — checked here and again in `api.request_marketing_report`, which also refuses while the
 * profile does not say what the company sells or its industry, once the month's AI allowance is used,
 * and past three reports an hour for the organisation. A request while one is already being written
 * returns that one and spends nothing (`created: false`).
 */
export interface MarketingRequest {
  readonly reportId: string;
  /** False when an attempt was already queued or running and that one was returned. */
  readonly created: boolean;
}

export async function requestMarketingReport(ctx: AccessContext): Promise<MarketingRequest> {
  assertCan(ctx, 'reports.generate');
  assertCan(ctx, 'ai.use');
  if (!ctx.orgId || !marketingEnabled(ctx)) throw new NotFound();
  const row = await callApi<{ report_id: string; created: boolean }>(
    ctx.db, 'request_marketing_report', { p_org: ctx.orgId }, ctx.requestId,
  );
  return { reportId: row.report_id, created: row.created === true };
}
