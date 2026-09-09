import 'server-only';
import { assertCan } from '@/core/permissions';
import { NotFound, toMotionError } from '@/core/errors';
import { callApi } from '@/core/db/api-rpc';
import type { AccessContext } from '@/modules/tenancy';
import type { SubmitAnswer } from '../domain/contract';
import type { FeedbackType } from './feedback';

/**
 * The review queue (AI_ARCHITECTURE.md §13, CD-25; ROUTE_ARCHITECTURE.md §154).
 *
 * Reads run under the reviewer's own client: RLS admits a super admin to every organisation and an
 * assigned employee to theirs, and nothing else (ADR-082). `api.review_ai_feedback` is the
 * authority for the write — it re-checks the permission in the item's organisation, refuses `open`,
 * flags or unflags the message and audits — and this service adds nothing to that.
 */

export type FeedbackStatus = 'open' | 'reviewed' | 'actioned' | 'dismissed';
export const REVIEW_STATUSES = ['reviewed', 'actioned', 'dismissed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface FeedbackListItem {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly type: FeedbackType;
  readonly status: FeedbackStatus;
  readonly comment: string | null;
  readonly createdAt: string;
  readonly messageId: string | null;
  readonly alertId: string | null;
  readonly groundingStatus: string | null;
}

export interface FeedbackDetail extends FeedbackListItem {
  readonly reviewedAt: string | null;
  readonly resolutionNote: string | null;
  readonly conversationId: string | null;
  readonly structured: SubmitAnswer | null;
  readonly groundingReport: unknown;
  readonly evidenceBundleId: string | null;
  readonly promptVersion: string | null;
  readonly model: string | null;
  readonly toolCalls: ReadonlyArray<{
    readonly seq: number;
    readonly toolName: string;
    readonly authorized: boolean;
    readonly denialReason: string | null;
    readonly error: string | null;
    readonly durationMs: number | null;
    readonly outputSummary: unknown;
  }>;
}

const BASE_SELECT = 'id, organization_id, message_id, alert_id, feedback_type, status, comment, created_at, organizations(name, slug)';
const LIST_SELECT = `${BASE_SELECT}, ai_messages(grounding_status)`;
// One embed of the message: PostgREST refuses the same relation embedded twice in a select.
const DETAIL_SELECT = `${BASE_SELECT}, reviewed_at, resolution_note, ai_messages(conversation_id, structured_response, grounding_status, grounding_report, evidence_bundle_id, prompt_version, model)`;

function toItem(row: Record<string, unknown>): FeedbackListItem {
  const org = row.organizations as { name: string; slug: string } | null;
  const message = row.ai_messages as { grounding_status: string } | null;
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    organizationName: org?.name ?? '',
    organizationSlug: org?.slug ?? '',
    type: row.feedback_type as FeedbackType,
    status: row.status as FeedbackStatus,
    comment: (row.comment as string | null) ?? null,
    createdAt: row.created_at as string,
    messageId: (row.message_id as string | null) ?? null,
    alertId: (row.alert_id as string | null) ?? null,
    groundingStatus: message?.grounding_status ?? null,
  };
}

/** Open items first, newest first; `all` includes what has been dealt with. */
export async function listFeedback(ctx: AccessContext, scope: 'open' | 'all' = 'open'): Promise<FeedbackListItem[]> {
  assertCan(ctx, 'platform.ai_feedback.review');
  let query = ctx.db.from('ai_feedback').select(LIST_SELECT).order('created_at', { ascending: false }).limit(200);
  if (scope === 'open') query = query.eq('status', 'open');
  const { data, error } = await query;
  if (error) throw toMotionError(error, ctx.requestId);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toItem);
}

/** One item with everything a reviewer needs: the answer, its grounding report, the tool calls. */
export async function loadFeedback(ctx: AccessContext, feedbackId: string): Promise<FeedbackDetail> {
  assertCan(ctx, 'platform.ai_feedback.review');
  const { data, error } = await ctx.db
    .from('ai_feedback')
    .select(DETAIL_SELECT)
    .eq('id', feedbackId)
    .maybeSingle();
  if (error) throw toMotionError(error, ctx.requestId);
  if (!data) throw new NotFound();
  const row = data as unknown as Record<string, unknown>;
  const message = row.ai_messages as {
    conversation_id: string; structured_response: SubmitAnswer | null; grounding_status: string; grounding_report: unknown;
    evidence_bundle_id: string | null; prompt_version: string | null; model: string | null;
  } | null;

  let toolCalls: FeedbackDetail['toolCalls'] = [];
  if (message) {
    const calls = await ctx.db
      .from('ai_tool_calls')
      .select('sequence, tool_name, authorized, denial_reason, error, duration_ms, output_summary')
      .eq('organization_id', row.organization_id as string)
      .eq('message_id', row.message_id as string)
      .order('sequence');
    if (calls.error) throw toMotionError(calls.error, ctx.requestId);
    toolCalls = ((calls.data ?? []) as Record<string, unknown>[]).map((c) => ({
      seq: c.sequence as number, toolName: c.tool_name as string, authorized: Boolean(c.authorized),
      denialReason: (c.denial_reason as string | null) ?? null, error: (c.error as string | null) ?? null,
      durationMs: (c.duration_ms as number | null) ?? null, outputSummary: c.output_summary,
    }));
  }

  return {
    ...toItem(row),
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    resolutionNote: (row.resolution_note as string | null) ?? null,
    conversationId: message?.conversation_id ?? null,
    structured: message?.structured_response ?? null,
    groundingReport: message?.grounding_report ?? null,
    evidenceBundleId: message?.evidence_bundle_id ?? null,
    promptVersion: message?.prompt_version ?? null,
    model: message?.model ?? null,
    toolCalls,
  };
}

export async function reviewFeedback(
  ctx: AccessContext, input: { readonly feedbackId: string; readonly status: ReviewStatus; readonly note?: string | null },
): Promise<string> {
  assertCan(ctx, 'platform.ai_feedback.review');
  return callApi<string>(ctx.db, 'review_ai_feedback', {
    p_feedback: input.feedbackId, p_status: input.status, p_note: input.note ?? null,
  }, ctx.requestId);
}

/** Open items, for the platform overview. */
export async function countOpenFeedback(ctx: AccessContext): Promise<number> {
  const { count, error } = await ctx.db.from('ai_feedback').select('id', { count: 'exact', head: true }).eq('status', 'open');
  if (error) throw toMotionError(error, ctx.requestId);
  return count ?? 0;
}
