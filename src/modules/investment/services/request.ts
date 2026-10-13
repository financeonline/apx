import 'server-only';
import { callApi } from '@/core/db/api-rpc';
import { NotFound, ValidationError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import { defaultSurplus } from '../domain/figures';
import { parseSurplusInput } from '../domain/surplus';
import { loadInvestmentBase } from './figures';
import { INVESTMENT_FAILURES, noProfitFailure } from './generate-report';
import { investmentEnabled } from './read';

/**
 * Asking for the Investment Pack to be written, or rewritten (ADR-171).
 *
 * Spending AI on it takes `reports.generate` (it produces a stored report) and `ai.use` (it is a model
 * call) — checked here and again in `api.request_investment_report`, which also refuses an amount below
 * 1 (the pack's figures are whole currency units) or beyond 1,000,000,000,000, once the month's AI
 * allowance is used, and past three packs an hour for the organisation. A request while one is already being written returns that
 * one and spends nothing (`created: false`).
 *
 * `surplus` is the amount the analyst entered to allocate (as typed, or already a decimal string), or
 * null for the base year's net profit. A pack needs a surplus: with no amount entered, a company whose
 * base year shows no profit — or that has no figures at all — is refused HERE, in the same words the
 * job would fail it in, so nobody waits for a pack that cannot be written. (The base year is worked
 * out in TypeScript from the figures, so this is the one place the rule can be checked before the
 * job; the job checks it again for a caller that came straight to the database.)
 */
export interface InvestmentRequest {
  readonly reportId: string;
  /** False when an attempt was already queued or running and that one was returned. */
  readonly created: boolean;
}

export async function requestInvestmentReport(
  ctx: AccessContext,
  input: { readonly surplus: string | null },
): Promise<InvestmentRequest> {
  assertCan(ctx, 'reports.generate');
  assertCan(ctx, 'ai.use');
  if (!ctx.orgId || !investmentEnabled(ctx)) throw new NotFound();

  const parsed = parseSurplusInput(input.surplus);
  if (!parsed.ok) throw new ValidationError(parsed.message, [{ path: 'surplus', message: parsed.message }]);

  const base = await loadInvestmentBase(ctx.db, ctx.orgId);
  if (base === null) throw new ValidationError(INVESTMENT_FAILURES.noFigures);
  if (parsed.surplus === null && defaultSurplus(base) === null) {
    const message = noProfitFailure(base.yearLabel);
    throw new ValidationError(message, [{ path: 'surplus', message }]);
  }

  const row = await callApi<{ report_id: string; created: boolean }>(
    ctx.db, 'request_investment_report', { p_org: ctx.orgId, p_surplus: parsed.surplus }, ctx.requestId,
  );
  return { reportId: row.report_id, created: row.created === true };
}
