'use server';

import { revalidatePath } from 'next/cache';
import { NotFound } from '@/core/errors';
import { createFromHealthScore } from '@/modules/actions';
import { getPortfolioContext, loadOpportunities, loadPortfolio, OPPORTUNITY_KINDS, type OpportunityKind } from '@/modules/portfolio';
import { getAccessContext } from '@/modules/tenancy';
import { done, fail, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Record an advisory opportunity as an action in the client's Action Centre (ADR-148).
 *
 * The browser sends only WHICH client and WHICH opportunity. The opportunity is worked out again
 * here from the client's current breakdown, so the action says what MOTION's rules say now — never
 * text a browser supplied — and a client outside the caller's portfolio is NOT FOUND. Creating the
 * action is then the client organisation's own `actions.create`, checked in SQL as always.
 */
export async function recordOpportunityAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getPortfolioContext();
    requestId = ctx.requestId;
    const orgId = text(form, 'org_id');
    const kind = text(form, 'kind') as OpportunityKind;
    const organisation = ctx.organisations.find((o) => o.id === orgId);
    if (organisation === undefined || !OPPORTUNITY_KINDS.includes(kind)) throw new NotFound();

    const view = await loadPortfolio(ctx);
    const [entry] = await loadOpportunities(ctx, view, [orgId]);
    const opportunity = entry?.opportunities.find((o) => o.kind === kind);
    if (entry === undefined || opportunity === undefined) {
      return fail(new Error('That opportunity no longer applies to the latest figures.'), { requestId, action: 'portfolio.opportunity' });
    }

    const orgCtx = await getAccessContext(organisation.slug);
    await createFromHealthScore(orgCtx, entry.healthScoreId, {
      title: opportunity.title,
      issue: `${opportunity.because.join('; ')} (${entry.periodLabel}).`,
      recommendation: opportunity.suggestion,
      priority: 'medium',
    });
    revalidatePath(`/portfolio/clients/${orgId}`);
    return done(`Added to ${organisation.name}'s Action Centre.`);
  } catch (error) {
    return fail(error, { requestId, action: 'portfolio.opportunity' });
  }
}
