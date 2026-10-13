import 'server-only';
import { NotFound } from '@/core/errors';
import { assertCan, can } from '@/core/permissions';
import { moduleOn, type AccessContext } from '@/modules/tenancy';
import { loadInvestmentSubject, loadLatestAttempt, loadLatestReadyReport } from '../data/repository';
import { defaultSurplus } from '../domain/figures';
import type { InvestmentReport, InvestmentView } from '../domain/types';
import { loadInvestmentBase } from './figures';

/**
 * Reading Investment for the page (ADR-171), as Marketing is read (ADR-170).
 *
 * `reports.view` — the five roles — then the system switch: Investment switched off is NOT FOUND for
 * every role (ADR-158), and RLS hides the stored packs too (`app.investment_enabled`), never the UI
 * alone. The pack shown is the newest READY one; the status is the newest attempt's, so a refresh
 * under way, or one that failed, never hides the pack that is already there.
 *
 * The page also shows the base year APX would build a new pack on and the surplus it would allocate by
 * default (the base year's net profit), so the analyst can see what "create the pack" will use before
 * spending anything — and knows to enter an amount when the year shows no profit.
 */

/** Whether this organisation has Investment (ADR-158). Synchronous: the context already carries it. */
export function investmentEnabled(ctx: AccessContext): boolean {
  return ctx.orgId !== null && moduleOn(ctx, 'investment');
}

/** `reports.view`, then the switch; the organisation the context is for. */
export function requireInvestment(ctx: AccessContext): string {
  assertCan(ctx, 'reports.view');
  if (!ctx.orgId || !investmentEnabled(ctx)) throw new NotFound();
  return ctx.orgId;
}

/** Whether the viewer may spend AI on writing or refreshing the pack — what the database checks. */
function mayRefresh(ctx: AccessContext): boolean {
  return can(ctx, 'reports.generate') && can(ctx, 'ai.use');
}

export async function getInvestmentView(ctx: AccessContext): Promise<InvestmentView> {
  const orgId = requireInvestment(ctx);
  const [subject, attempt, ready, base] = await Promise.all([
    loadInvestmentSubject(ctx.db, orgId, ctx.requestId),
    loadLatestAttempt(ctx.db, orgId, ctx.requestId),
    loadLatestReadyReport(ctx.db, orgId, ctx.requestId),
    loadInvestmentBase(ctx.db, orgId),
  ]);
  if (subject === null) throw new NotFound();

  return {
    organisationName: subject.name,
    currency: subject.currency,
    profile: subject.profile,
    base,
    defaultSurplus: base === null ? null : defaultSurplus(base),
    status: attempt === null ? 'none' : attempt.status,
    report: ready?.report ?? null,
    failure: attempt?.status === 'failed' ? attempt.failure : null,
    canRefresh: mayRefresh(ctx),
    // `customers.edit` records the company's commercial facts — owner, admin and the assigned adviser.
    canEditProfile: can(ctx, 'customers.edit'),
  };
}

/** The newest ready pack, for the Word and PDF downloads; null when there is none yet. */
export async function getLatestInvestmentReport(ctx: AccessContext): Promise<InvestmentReport | null> {
  const orgId = requireInvestment(ctx);
  return (await loadLatestReadyReport(ctx.db, orgId, ctx.requestId))?.report ?? null;
}
