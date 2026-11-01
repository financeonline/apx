'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { ValidationError } from '@/core/errors';
import { Decimal, add, multiply, subtract, tryParseDecimal } from '@/core/money';
import { setAlertStatus } from '@/modules/alerts';
import { setStatus } from '@/modules/actions';
import { createEngagementItem } from '@/modules/engagement';
import { loadOrganizationFacts } from '@/modules/dashboard';
import { clientReviewTitle, reviewRequestTitle, type TargetActuals } from '@/modules/departments';
import { fail, done } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';
import type { GrowthRowsView, TargetsCheckView } from '@/components/department-dashboard/types';
import { compactMoney, fullMoney } from './dash-format';
import { targetsCheckView } from './targets-view';

/**
 * The department dashboard's writes and recalculations (docs/DEPARTMENT_DASHBOARD_PLAN.md).
 *
 * Each write is the SECOND permission check, never the only one: the services and `api.*`
 * functions re-check the caller (ADR-026). The prototype stored these in the browser; here they are
 * real records — a review request or a client review is an engagement item, "Mark as reviewed" is
 * the alert's status, "Complete task" the action's status.
 */

const home = (orgSlug: string) => `/app/${orgSlug}/home`;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Client: "Request analyst review" on a priority item → an engagement request. */
export async function requestReviewAction(orgSlug: string, item: { title: string; context: string; href: string }): Promise<ActionResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    const title = String(item?.title ?? '').trim();
    if (!title) throw new ValidationError('That item could not be found.');
    await createEngagementItem(ctx, {
      kind: 'request',
      // The shared title, so the dashboard reads the item back as "Requested".
      title: reviewRequestTitle(title),
      detail: clip(`${String(item.context ?? '')}\n\nOpen: ${String(item.href ?? '')}`.trim(), 2000),
      dueDate: null,
    });
    revalidatePath(home(orgSlug));
    revalidatePath(`/app/${orgSlug}/engagement`);
    return done('Review requested. Your analyst will see it in Client Management.');
  } catch (error) {
    return fail(error, { requestId, action: 'dashboard.request_review' });
  }
}

/**
 * Analyst: "Mark as reviewed" / "Reopen observation" (an alert → acknowledged / open) and
 * "Complete task" / "Reopen task" (an action → completed / open).
 */
export async function setItemReviewedAction(
  orgSlug: string, kind: 'alert' | 'action', recordId: string, reviewed: boolean,
): Promise<ActionResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    if (typeof recordId !== 'string' || recordId === '') throw new ValidationError('That item could not be found.');
    if (kind === 'alert') {
      assertCan(ctx, 'alerts.manage');
      await setAlertStatus(ctx.db, { alertId: recordId, status: reviewed ? 'acknowledged' : 'open', reason: null }, requestId);
      revalidatePath(`/app/${orgSlug}/insights`);
    } else if (kind === 'action') {
      await setStatus(ctx, recordId, reviewed ? 'completed' : 'open');
      revalidatePath(`/app/${orgSlug}/actions`);
    } else {
      throw new ValidationError('Only observations and tasks can be reviewed here.');
    }
    revalidatePath(home(orgSlug));
    return done(kind === 'action'
      ? (reviewed ? 'Task completed.' : 'Task reopened.')
      : (reviewed ? 'Observation marked as reviewed.' : 'Observation reopened.'));
  } catch (error) {
    return fail(error, { requestId, action: 'dashboard.set_reviewed' });
  }
}

/** Analyst: "Record review" on a client profile → an engagement deliverable `Client review: <name>`. */
export async function recordClientReviewAction(orgSlug: string, client: { name: string; nextStep: string }): Promise<ActionResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    const name = String(client?.name ?? '').trim();
    if (!name) throw new ValidationError('That client could not be found.');
    await createEngagementItem(ctx, {
      kind: 'deliverable',
      title: clientReviewTitle(name),
      detail: clip(String(client.nextStep ?? ''), 2000) || null,
      dueDate: null,
    });
    revalidatePath(home(orgSlug));
    revalidatePath(`/app/${orgSlug}/engagement`);
    return done('Client review recorded in Client Management.');
  } catch (error) {
    return fail(error, { requestId, action: 'dashboard.record_client_review' });
  }
}

type Outcome<T> = { ok: true; view: T } | { ok: false; error: ActionResult };

/**
 * "How can I Grow" with an additional investment (`growth.js#projectGrowth`), in Decimal:
 *   revenue′ = revenue × (1 + g); uplift = revenue × g
 *   profit′  = (fixed: profit + gross profit × g | scale: profit × (1 + g)) − investment
 *   cost′    = revenue′ − profit′
 * The baseline is the service's (Decimal strings); nothing here is a sample figure.
 */
export async function projectGrowthAction(
  orgSlug: string,
  baseline: { revenue: string; grossProfit: string; profit: string },
  costMode: 'fixed' | 'scale',
  investmentInput: string,
): Promise<Outcome<GrowthRowsView>> {
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'dashboard.view');
    const facts = await loadOrganizationFacts(ctx.db, ctx.orgId!);
    const currency = facts?.baseCurrency ?? 'GBP';
    const base = {
      revenue: tryParseDecimal(baseline?.revenue), grossProfit: tryParseDecimal(baseline?.grossProfit), profit: tryParseDecimal(baseline?.profit),
    };
    if (base.revenue === null || base.grossProfit === null || base.profit === null || !base.revenue.gt(0)) {
      throw new ValidationError('The growth baseline could not be read.');
    }
    // The prototype's input: 0 to 10,000,000, anything else held to that range.
    const raw = tryParseDecimal(String(investmentInput ?? '0').trim() || '0') ?? new Decimal(0);
    const investment = Decimal.max(0, Decimal.min(10_000_000, raw));
    const rows = [10, 20, 30].map((rate) => {
      const g = new Decimal(rate).dividedBy(100);
      const projected = multiply(base.revenue!, add(1, g));
      const uplift = multiply(base.revenue!, g);
      const before = costMode === 'scale' ? multiply(base.profit!, add(1, g)) : add(base.profit!, multiply(base.grossProfit!, g));
      const projectedProfit = subtract(before, investment);
      const projectedCost = subtract(projected, projectedProfit);
      return {
        rate,
        revenue: fullMoney(projected, currency),
        cost: fullMoney(projectedCost, currency),
        profit: fullMoney(projectedProfit, currency),
        uplift: `+${compactMoney(uplift, currency)}`,
        profitCompact: compactMoney(projectedProfit, currency),
      };
    });
    return { ok: true, view: { rows, investmentDisplay: compactMoney(investment, currency) } };
  } catch (error) {
    return { ok: false, error: fail(error, { requestId, action: 'dashboard.project_growth' }) };
  }
}

/** The monthly target check for the month and the targets being typed (no write). */
export async function assessTargetsAction(
  orgSlug: string, month: string, targets: unknown, actuals: readonly TargetActuals[],
): Promise<Outcome<TargetsCheckView>> {
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'dashboard.view');
    const facts = await loadOrganizationFacts(ctx.db, ctx.orgId!);
    const history = Array.isArray(actuals) ? actuals.slice(0, 24) : [];
    return { ok: true, view: targetsCheckView(month, targets, history, facts?.baseCurrency ?? 'GBP') };
  } catch (error) {
    return { ok: false, error: fail(error, { requestId, action: 'dashboard.assess_targets' }) };
  }
}
