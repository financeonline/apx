import 'server-only';
import { assertCan } from '@/core/permissions';
import { NotFound } from '@/core/errors';
import { callApi } from '@/core/db/api-rpc';
import { locateOrgRow, reachableOrganizations } from '@/db/app/ai-reads';
import { orgQuery, orgRowById, orgRows, orgRowsByIds } from '@/db/rls';
import type { AccessContext } from '@/modules/tenancy';
import type { SubmitAnswer } from '../domain/contract';
import type { FeedbackType } from './feedback';

/**
 * The review queue (AI_ARCHITECTURE.md §13, CD-25; ROUTE_ARCHITECTURE.md §154).
 *
 * Reads go through each table's read policy (`src/db/rls.ts`) for the reviewer: a super admin
 * reaches every organisation and an assigned employee theirs, and nothing else (ADR-082). `api.review_ai_feedback` is the
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

type Row = Record<string, unknown>;

function toItem(row: Row, org: { name: string; slug: string } | undefined, message: Row | null): FeedbackListItem {
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
    groundingStatus: (message?.grounding_status as string | undefined) ?? null,
  };
}

/** The messages a list of reports names, read under the `ai_messages` policy (≤ 30 per `in`). */
async function messagesOf(ctx: AccessContext, orgId: string, ids: string[]): Promise<Map<string, Row>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, Row>();
  // By document id, under the table's policy (orgRowsByIds) — a `where('id','in',…)` scans the collection on the index-less emulator.
  for (const r of await orgRowsByIds<Row>(ctx.db, orgId, 'ai_messages', unique)) out.set(String(r.id), r);
  return out;
}

/**
 * Open items first, newest first; `all` includes what has been dealt with. The queue spans every
 * organisation the reviewer reaches, each read under its own `ai_feedback` policy (Firestore keeps
 * a tenant's rows under it, so the one cross-tenant SELECT is one read per organisation).
 */
export async function listFeedback(ctx: AccessContext, scope: 'open' | 'all' = 'open'): Promise<FeedbackListItem[]> {
  assertCan(ctx, 'platform.ai_feedback.review');
  const orgs = await reachableOrganizations(ctx.db);
  const perOrg = await Promise.all(orgs.map(async (org) => {
    const rows = await orgRows<Row>(ctx.db, org.organization_id, 'ai_feedback', (q) => {
      const filtered = scope === 'open' ? q.where('status', '==', 'open') : q;
      return filtered.orderBy('created_at', 'desc').limit(200);
    });
    const messages = await messagesOf(ctx, org.organization_id, rows.map((r) => r.message_id).filter((id): id is string => typeof id === 'string'));
    return rows.map((r) => toItem(r, org, typeof r.message_id === 'string' ? messages.get(r.message_id) ?? null : null));
  }));
  return perOrg.flat()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, 200);
}

/** One item with everything a reviewer needs: the answer, its grounding report, the tool calls. */
export async function loadFeedback(ctx: AccessContext, feedbackId: string): Promise<FeedbackDetail> {
  assertCan(ctx, 'platform.ai_feedback.review');
  const orgId = await locateOrgRow(ctx.db, 'ai_feedback', feedbackId);
  const row = orgId ? await orgRowById<Row>(ctx.db, orgId, 'ai_feedback', feedbackId) : null;
  if (!orgId || !row) throw new NotFound();
  const org = (await reachableOrganizations(ctx.db)).find((o) => o.organization_id === orgId);
  const message = typeof row.message_id === 'string'
    ? await orgRowById<Row>(ctx.db, orgId, 'ai_messages', row.message_id)
    : null;

  let toolCalls: FeedbackDetail['toolCalls'] = [];
  if (message) {
    const calls = await orgRows<Row>(ctx.db, orgId, 'ai_tool_calls', (q) => q
      .where('message_id', '==', row.message_id as string)
      .orderBy('sequence'));
    toolCalls = calls.map((c) => ({
      seq: c.sequence as number, toolName: c.tool_name as string, authorized: Boolean(c.authorized),
      denialReason: (c.denial_reason as string | null) ?? null, error: (c.error as string | null) ?? null,
      durationMs: (c.duration_ms as number | null) ?? null, outputSummary: c.output_summary,
    }));
  }

  return {
    ...toItem(row, org, message),
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    resolutionNote: (row.resolution_note as string | null) ?? null,
    conversationId: (message?.conversation_id as string | undefined) ?? null,
    structured: (message?.structured_response as SubmitAnswer | null | undefined) ?? null,
    groundingReport: message?.grounding_report ?? null,
    evidenceBundleId: (message?.evidence_bundle_id as string | null | undefined) ?? null,
    promptVersion: (message?.prompt_version as string | null | undefined) ?? null,
    model: (message?.model as string | null | undefined) ?? null,
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

/** Open items, for the platform overview — counted under each organisation's `ai_feedback` policy. */
export async function countOpenFeedback(ctx: AccessContext): Promise<number> {
  const orgs = await reachableOrganizations(ctx.db);
  const counts = await Promise.all(orgs.map(async (org) => {
    const scoped = await orgQuery(ctx.db, org.organization_id, 'ai_feedback');
    if (!scoped) return 0;
    const open = scoped.query.where('status', '==', 'open');
    if (scoped.keep) return (await orgRows(ctx.db, org.organization_id, 'ai_feedback', (q) => q.where('status', '==', 'open'))).length;
    return (await open.count().get()).data().count;
  }));
  return counts.reduce((a, b) => a + b, 0);
}
