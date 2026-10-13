'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { requestInvestmentReport } from '@/modules/investment';
import { fail, done, optionalText, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Investment's one action (ADR-171): write the Investment Pack, or write it again — Marketing's
 * action in shape (ADR-170). The shape every action has (SERVICE_ARCHITECTURE.md §8.9): the context
 * from the slug, never from the form, then one service call, which asserts `reports.generate` and
 * `ai.use`, reads the amount to allocate, refuses a company with no surplus to allocate, and calls
 * `api.request_investment_report`, which checks the permissions again with the amount's bounds, the
 * month's AI allowance and the hourly limit.
 *
 * For `useActionState` with a form that posts `org_slug` and, optionally, `surplus` — the amount the
 * analyst enters to allocate, as typed ("95,000", "95000.50", "£95,000"). Empty means APX uses the
 * base year's net profit. A refused amount comes back as a VALIDATION error on the `surplus` field.
 */
export async function requestInvestmentReportAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    const { created } = await requestInvestmentReport(ctx, { surplus: optionalText(form, 'surplus') ?? null });
    revalidatePath(`/app/${orgSlug}/investment`);
    return done(created
      ? 'We are writing the Investment Pack. It usually takes a minute or two, and appears here when it is ready.'
      : 'The Investment Pack is already being written. It appears here when it is ready.');
  } catch (error) {
    return fail(error, { requestId, action: 'investment.requestReport' });
  }
}
