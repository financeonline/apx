import 'server-only';
import { assertCan } from '@/core/permissions';
import { ValidationError } from '@/core/errors';
import { callApi } from '@/core/db/api-rpc';
import type { AccessContext } from '@/modules/tenancy';

/**
 * "Report this answer" (AI_ARCHITECTURE.md §13, CD-25).
 *
 * Feedback names a message; `api.submit_ai_feedback` binds it to an organisation the caller can
 * reach (NOT_FOUND otherwise) and needs `ai.use`. The comment is the reporter's own words and is
 * stored verbatim for platform review — it is never fed back to the model.
 */
export const FEEDBACK_TYPES = ['incorrect', 'unhelpful', 'unsafe', 'helpful'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const MAX_FEEDBACK_COMMENT = 1_000;

export async function submitFeedback(
  ctx: AccessContext,
  input: { readonly messageId: string; readonly type: FeedbackType; readonly comment?: string | null },
): Promise<string> {
  assertCan(ctx, 'ai.use');
  if (!FEEDBACK_TYPES.includes(input.type)) throw new ValidationError('Choose what was wrong with the answer.');
  const comment = input.comment?.trim() ?? '';
  if (comment.length > MAX_FEEDBACK_COMMENT) {
    throw new ValidationError(`Keep the note under ${MAX_FEEDBACK_COMMENT} characters.`);
  }
  return callApi<string>(ctx.db, 'submit_ai_feedback', {
    p_message: input.messageId,
    p_alert: null,
    p_type: input.type,
    p_comment: comment === '' ? null : comment,
  }, ctx.requestId);
}
