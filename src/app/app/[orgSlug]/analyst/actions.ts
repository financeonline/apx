'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { submitFeedback, type FeedbackType } from '@/modules/ai';
import { createFromRecommendation } from '@/modules/actions';
import { done, fail, integer, optionalText, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * The analyst page's two writes. Each is the SECOND check, never the only one: `api.submit_ai_feedback`
 * binds the message to an organisation the caller can reach, and `api.create_action_from_recommendation`
 * refuses any answer that did not pass grounding (ADR-032.5) whatever the button said.
 */

export async function reportAnswerAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await submitFeedback(ctx, {
      messageId: text(form, 'message_id'),
      type: text(form, 'type') as FeedbackType,
      comment: optionalText(form, 'comment') ?? null,
    });
    return done('Thank you. Someone will look at this answer.');
  } catch (error) {
    return fail(error, { requestId, action: 'ai.feedback' });
  }
}

export async function createActionFromAnswerAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await createFromRecommendation(ctx, text(form, 'message_id'), integer(form, 'index', 0));
    revalidatePath(`/app/${orgSlug}/actions`);
    revalidatePath(`/app/${orgSlug}/home`);
    return done('Added to the Action Centre.');
  } catch (error) {
    return fail(error, { requestId, action: 'actions.create' });
  }
}
