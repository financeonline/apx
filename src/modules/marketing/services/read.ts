import 'server-only';
import { NotFound } from '@/core/errors';
import { assertCan, can } from '@/core/permissions';
import { moduleOn, type AccessContext } from '@/modules/tenancy';
import { loadLatestAttempt, loadLatestReadyReport, loadMarketingSubject } from '../data/repository';
import { profileIsReady, type CompanyProfile, type MarketingReport, type MarketingView } from '../domain/types';

/**
 * Reading Marketing for the page (ADR-170).
 *
 * `reports.view` — the five roles — then the system switch: Marketing switched off is NOT FOUND for
 * every role (ADR-158), and RLS hides the stored reports too (`app.marketing_enabled`), never the UI
 * alone. The report shown is the newest READY one; the status is the newest attempt's, so a refresh
 * under way, or one that failed, never hides the report that is already there.
 */

/** Whether this organisation has Marketing (ADR-158). Synchronous: the context already carries it. */
export function marketingEnabled(ctx: AccessContext): boolean {
  return ctx.orgId !== null && moduleOn(ctx, 'marketing');
}

function requireMarketing(ctx: AccessContext): string {
  assertCan(ctx, 'reports.view');
  if (!ctx.orgId || !marketingEnabled(ctx)) throw new NotFound();
  return ctx.orgId;
}

/** Whether the viewer may spend AI on writing or refreshing the report — what the database checks. */
function mayRefresh(ctx: AccessContext): boolean {
  return can(ctx, 'reports.generate') && can(ctx, 'ai.use');
}

export async function getMarketingView(ctx: AccessContext): Promise<MarketingView> {
  const orgId = requireMarketing(ctx);
  const [subject, attempt, ready] = await Promise.all([
    loadMarketingSubject(ctx.db, orgId, ctx.requestId),
    loadLatestAttempt(ctx.db, orgId, ctx.requestId),
    loadLatestReadyReport(ctx.db, orgId, ctx.requestId),
  ]);
  if (subject === null) throw new NotFound();

  return {
    organisationName: subject.name,
    profile: subject.profile,
    profileReady: profileIsReady(subject.profile),
    status: attempt === null ? 'none' : attempt.status,
    report: ready?.report ?? null,
    failure: attempt?.status === 'failed' ? attempt.failure : null,
    canRefresh: mayRefresh(ctx),
    // `customers.edit` records the company's commercial facts — owner, admin and the assigned adviser.
    canEditProfile: can(ctx, 'customers.edit'),
  };
}

/** The newest ready report, for the Word and PDF downloads; null when there is none yet. */
export async function getLatestMarketingReport(ctx: AccessContext): Promise<MarketingReport | null> {
  const orgId = requireMarketing(ctx);
  return (await loadLatestReadyReport(ctx.db, orgId, ctx.requestId))?.report ?? null;
}

/**
 * The company profile, for its form and for Marketing. Readable by the five roles (RLS); it is not
 * part of the Marketing system, so it answers whether or not Marketing is switched on — Investment
 * will read it too.
 */
export async function getCompanyProfile(ctx: AccessContext): Promise<CompanyProfile> {
  assertCan(ctx, 'reports.view');
  if (!ctx.orgId) throw new NotFound();
  const subject = await loadMarketingSubject(ctx.db, ctx.orgId, ctx.requestId);
  if (subject === null) throw new NotFound();
  return subject.profile;
}
