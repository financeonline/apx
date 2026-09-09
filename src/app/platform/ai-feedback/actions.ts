'use server';

import { revalidatePath } from 'next/cache';
import { assertCan } from '@/core/permissions';
import { reviewFeedback, REVIEW_STATUSES, type ReviewStatus } from '@/modules/ai';
import { getPlatformContext } from '@/modules/tenancy';
import { done, fail, optionalText, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Marking a report reviewed, actioned or dismissed (AI_ARCHITECTURE.md §13; ADR-082).
 *
 * `api.review_ai_feedback` is the authority: it re-checks `platform.ai_feedback.review` in the
 * item's own organisation, refuses `open`, sets or clears the message's badge and audits. This is
 * the form, not the rule.
 */
export async function reviewFeedbackAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const ctx = await getPlatformContext();
  try {
    assertCan(ctx, 'platform.ai_feedback.review');
    const status = text(form, 'status');
    if (!(REVIEW_STATUSES as readonly string[]).includes(status)) {
      return fail(new Error('Choose reviewed, actioned or dismissed.'), { requestId: ctx.requestId, action: 'platform.reviewFeedback' });
    }
    const feedbackId = text(form, 'feedback_id');
    await reviewFeedback(ctx, { feedbackId, status: status as ReviewStatus, note: optionalText(form, 'note') ?? null });
    revalidatePath('/platform/ai-feedback');
    revalidatePath(`/platform/ai-feedback/${feedbackId}`);
    return done(`Marked ${status}.`);
  } catch (error) {
    return fail(error, { requestId: ctx.requestId, action: 'platform.reviewFeedback' });
  }
}
