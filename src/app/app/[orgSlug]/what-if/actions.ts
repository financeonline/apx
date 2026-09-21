'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import {
  ASSUMPTION_KINDS, archiveScenario, hasScenario, runScenario, type AssumptionKind,
} from '@/modules/scenarios';
import { done, fail, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Running and putting away a what-if (REQ-SC-01, §13, §19; ADR-100).
 *
 * The form is read HERE rather than serialised to JSON in the browser, for two reasons. It works
 * without JavaScript, which matters for a page a non-technical owner may open on a bad connection;
 * and it means the server builds the assumption objects from named fields it chose, so a browser
 * cannot post a shape the form never offered. Everything it builds is then validated again by
 * `parseAssumptions` before a single figure is read (§4).
 *
 * `intelligence.recompute` is checked here, again inside `runScenario`, and a third time in SQL
 * where `api_server.finish_scenario` re-validates the actor — the permission is not a property of
 * this button (ADR-026).
 */

const bool = (form: FormData, name: string): boolean => form.get(name) !== null;

function whole(form: FormData, name: string, fallback: number): number {
  const raw = text(form, name);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The assumptions the form actually offered, in the shape the domain expects.
 *
 * A kind is included only when its own checkbox is ticked. An untouched row contributes nothing —
 * it is not an assumption of "no change", which would be indistinguishable from an assumption of
 * zero and would make the assumptions list say something the person never said.
 */
function assumptionsFrom(form: FormData): unknown[] {
  const out: unknown[] = [];

  for (const kind of ASSUMPTION_KINDS) {
    if (!bool(form, `include.${kind}`)) continue;
    const field = (name: string) => text(form, `${kind}.${name}`);
    const common = {
      kind,
      startsInMonth: whole(form, `${kind}.startsInMonth`, 1),
      cashEffect: field('cashEffect') === 'none' ? 'none' : 'same_month',
    };

    switch (kind as AssumptionKind) {
      case 'revenue_change':
        out.push({
          ...common,
          mode: field('mode') === 'amount' ? 'amount' : 'percent',
          value: field('value'),
          directCostsFollow: bool(form, `${kind}.directCostsFollow`),
        });
        break;
      case 'payroll_change':
      case 'supplier_cost_change':
      case 'marketing_change':
        out.push({
          ...common,
          mode: field('mode') === 'amount' ? 'amount' : 'percent',
          value: field('value'),
        });
        break;
      case 'hiring':
        out.push({
          ...common,
          headcount: whole(form, `${kind}.headcount`, 0),
          monthlyCostPerPerson: field('monthlyCostPerPerson'),
        });
        break;
      case 'pricing_change':
        out.push({
          ...common,
          pricePercent: field('pricePercent'),
          volumePercent: field('volumePercent'),
          directCostsFollow: bool(form, `${kind}.directCostsFollow`),
        });
        break;
      case 'debt_drawdown':
        out.push({ ...common, cashEffect: 'same_month', amount: field('amount') });
        break;
      case 'debt_repayment':
        out.push({
          ...common,
          cashEffect: 'same_month',
          monthlyAmount: field('monthlyAmount'),
          // §11: an empty interest box means "none given", which is not the same as zero.
          monthlyInterest: field('monthlyInterest').length === 0 ? null : field('monthlyInterest'),
        });
        break;
    }
  }
  return out;
}

export async function runScenarioAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'intelligence.recompute');

    const state = await runScenario(ctx, {
      name: text(form, 'name'),
      assumptions: assumptionsFrom(form),
    });
    revalidatePath(`/app/${orgSlug}/what-if`);

    /*
     * "It could not be worked out" is an outcome, not a failure, and it has to be SAID — a tick
     * beside an unchanged page would leave the reader unable to tell which of the two happened.
     * The reasons themselves are listed on the page, where there is room for them.
     */
    return hasScenario(state)
      ? done('Worked out and saved.')
      : done('This could not be worked out. The reasons are below.');
  } catch (error) {
    return fail(error, { requestId, action: 'scenario.run' });
  }
}

export async function archiveScenarioAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'intelligence.recompute');

    const archived = text(form, 'archived') !== 'false';
    await archiveScenario(ctx, text(form, 'scenario_id'), archived);
    revalidatePath(`/app/${orgSlug}/what-if`);
    return done(archived ? 'Put away.' : 'Brought back.');
  } catch (error) {
    return fail(error, { requestId, action: 'scenario.archive' });
  }
}
