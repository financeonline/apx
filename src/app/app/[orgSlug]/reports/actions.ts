'use server';

import { revalidatePath } from 'next/cache';
import { ValidationError, toMotionError } from '@/core/errors';
import { getAccessContext } from '@/modules/tenancy';
import { finishCustomReport, requestCompose, requestStoredPdf, type ComposableKind } from '@/modules/reporting';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Phase 17 report actions (ADR-141). Each one asks the queue for work; `api.enqueue_job` checks
 * `reports.generate` and the window, and merges a second press onto the job already waiting.
 */

const COMPOSABLE: readonly ComposableKind[] = ['daily_brief', 'weekly_intelligence', 'adviser', 'funding_readiness'];

export async function requestComposeAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    const kind = text(form, 'kind') as ComposableKind;
    if (!COMPOSABLE.includes(kind)) throw new ValidationError('That report cannot be produced here.');
    await requestCompose(ctx, kind, kind === 'adviser' || kind === 'funding_readiness' ? null : text(form, 'window_start'));
    revalidatePath(`/app/${orgSlug}/reports`);
    return done('We are producing the report. It will appear in the list shortly.');
  } catch (error) {
    return fail(error, { requestId, action: 'reports.compose' });
  }
}

export async function requestStoredPdfAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  const reportId = text(form, 'report_id');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await requestStoredPdf(ctx, reportId);
    revalidatePath(`/app/${orgSlug}/reports/r/${reportId}`);
    return done('We are producing the PDF. It will appear here shortly.');
  } catch (error) {
    return fail(error, { requestId, action: 'reports.request_stored_pdf' });
  }
}

export type FinishCustomResult =
  | { readonly ok: true; readonly reportId: string }
  | { readonly ok: false; readonly message: string };

/**
 * Records a Custom AI Report from the answers the analyst already gave in its conversation. The
 * server reads the answers back from storage; nothing here is taken from the browser as an answer.
 */
export async function finishCustomReportAction(input: {
  orgSlug: string;
  conversationId: string;
  periodId: string;
  dimensions: string[];
  assistantMessageIds: string[];
}): Promise<FinishCustomResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(input.orgSlug);
    requestId = ctx.requestId;
    const reportId = await finishCustomReport(ctx, input);
    revalidatePath(`/app/${input.orgSlug}/reports`);
    return { ok: true, reportId };
  } catch (error) {
    const result = fail(error, { requestId, action: 'reports.finish_custom' });
    return { ok: false, message: result.ok ? 'The report could not be saved.' : toMotionError(error).message };
  }
}
