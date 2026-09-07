'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { requestPdf } from '@/modules/reporting';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Asks the queue for a PDF (SERVICE_ARCHITECTURE.md §4.14).
 *
 * `api.enqueue_job` checks `reports.generate` and merges onto a job already queued for the same
 * organisation and period, so pressing the button twice does not render twice — the document would
 * be identical and is not cheap to produce.
 */
export async function requestPdfAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await requestPdf(ctx, text(form, 'period_id'));

    revalidatePath(`/app/${orgSlug}/reports`);
    revalidatePath(`/app/${orgSlug}/reports/monthly/${text(form, 'period_id')}`);
    return done('We are producing the PDF. It will appear here shortly.');
  } catch (error) {
    return fail(error, { requestId, action: 'reports.request_pdf' });
  }
}
