'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { requestMarketingReport } from '@/modules/marketing';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Marketing's one action (ADR-170): write the report, or write it again. The shape every action has
 * (SERVICE_ARCHITECTURE.md §8.9): the context from the slug, never from the form, then one service
 * call, which asserts `reports.generate` and `ai.use` and calls `api.request_marketing_report`, which
 * checks them again with the profile, the month's AI allowance and the hourly limit.
 *
 * For `useActionState` with a form that posts `org_slug`.
 */
export async function requestMarketingReportAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    const { created } = await requestMarketingReport(ctx);
    revalidatePath(`/app/${orgSlug}/marketing`);
    return done(created
      ? 'We are writing the marketing report. It usually takes a minute or two, and appears here when it is ready.'
      : 'The marketing report is already being written. It appears here when it is ready.');
  } catch (error) {
    return fail(error, { requestId, action: 'marketing.requestReport' });
  }
}
