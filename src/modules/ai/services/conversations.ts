import 'server-only';
import { NotFound } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import { callApi } from '@/core/db/api-rpc';
import { orgRowById, orgRows } from '@/db/rls';
import type { AccessContext } from '@/modules/tenancy';
import type { SubmitAnswer } from '../domain/contract';

/**
 * Conversations (AI_ARCHITECTURE.md §2 step 3, §4, §9 "History replay"; F-C-11).
 *
 * A conversation is bound to `(organization_id, user_id)` at load. An id that belongs to another
 * organisation, or to a colleague, is `NotFound` BEFORE any model is called — there is no message
 * to hijack because there is no conversation to find. Owners and admins review colleagues'
 * conversations through the UI (disclosed in Settings), never by continuing them, which is why
 * `findConversation` (continue) and `listConversations` (review) have different scopes.
 *
 * Reads go through the table's read policy (`src/db/rls.ts`), which admits an `ai_conversations`
 * row to its owner or to the organisation's owner/admin. Writes go through `api.*` /
 * `api_server.*` — nothing here inserts.
 */

export interface ConversationRef {
  readonly id: string;
  readonly title: string | null;
  readonly lastMessageAt: string | null;
  readonly createdAt: string;
}

export interface HistoryTurn {
  readonly role: 'user' | 'assistant';
  /** The user's text, or the assistant's validated `structured_response`. Never assistant prose. */
  readonly content: string | null;
  readonly structured: SubmitAnswer | null;
  readonly groundingStatus: string | null;
}

export interface StoredMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string | null;
  readonly structured: SubmitAnswer | null;
  readonly groundingStatus: string | null;
  readonly evidenceBundleId: string | null;
  readonly flagged: boolean;
  readonly createdAt: string;
}

/** §9: the last N turns replayed. */
export const HISTORY_TURNS = 10;

function requireOrg(ctx: AccessContext): string {
  if (!ctx.orgId) throw new NotFound();
  return ctx.orgId;
}

/**
 * The conversation the caller may CONTINUE: theirs, in this organisation, still active. Anything
 * else is NotFound — including a colleague's, which the caller might be able to read.
 */
export async function findConversation(ctx: AccessContext, conversationId: string): Promise<ConversationRef> {
  assertCan(ctx, 'ai.use');
  const orgId = requireOrg(ctx);
  const row = await orgRowById(ctx.db, orgId, 'ai_conversations', conversationId);
  if (!row || row.user_id !== ctx.userId || row.status !== 'active') throw new NotFound();
  return toRef(row);
}

function toRef(row: Record<string, unknown>): ConversationRef {
  return {
    id: row.id as string,
    title: (row.title as string | null) ?? null,
    lastMessageAt: (row.last_message_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export async function createConversation(ctx: AccessContext): Promise<string> {
  assertCan(ctx, 'ai.use');
  const orgId = requireOrg(ctx);
  return callApi<string>(ctx.db, 'create_conversation', { p_org: orgId }, ctx.requestId);
}

/** The caller's own conversations, newest first — the list on `/analyst`. */
export async function listConversations(ctx: AccessContext): Promise<ConversationRef[]> {
  assertCan(ctx, 'ai.use');
  const orgId = requireOrg(ctx);
  // Firestore orders nulls first ascending, so a descending order puts never-used conversations last.
  const rows = await orgRows(ctx.db, orgId, 'ai_conversations', (q) => q
    .where('user_id', '==', ctx.userId)
    .where('status', '==', 'active')
    .orderBy('last_message_at', 'desc')
    .limit(50));
  return rows.map(toRef);
}

/**
 * The messages of a conversation the caller may READ: their own, or — for an owner/admin — a
 * colleague’s. The read policy decides (`src/db/rls.ts`). Used by the conversation page.
 */
export async function loadMessages(ctx: AccessContext, conversationId: string): Promise<StoredMessage[]> {
  assertCan(ctx, 'ai.use');
  const orgId = requireOrg(ctx);
  const rows = await orgRows(ctx.db, orgId, 'ai_messages', (q) => q
    .where('conversation_id', '==', conversationId)
    .orderBy('created_at', 'asc')
    .limit(200));
  if (rows.length === 0) {
    // Either an empty conversation the caller owns, or one they may not see. Tell the two apart the
    // way the rest of the product does: a foreign id is NotFound.
    if (!(await orgRowById(ctx.db, orgId, 'ai_conversations', conversationId))) throw new NotFound();
  }
  return rows.map((row) => ({
    id: row.id as string,
    role: row.role as 'user' | 'assistant',
    content: (row.content as string | null) ?? null,
    structured: (row.structured_response as SubmitAnswer | null) ?? null,
    groundingStatus: (row.grounding_status as string | null) ?? null,
    evidenceBundleId: (row.evidence_bundle_id as string | null) ?? null,
    flagged: Boolean(row.flagged),
    createdAt: row.created_at as string,
  }));
}

/**
 * §9 history replay: the last `HISTORY_TURNS` turns of the caller's OWN conversation, oldest
 * first, as user text and validated assistant JSON — never assistant prose, never tool results.
 * The prompt assembler wraps every string field of the assistant JSON in `untrusted()`; this
 * function returns the stored shape so that wrapping happens in one place.
 */
export async function loadHistory(ctx: AccessContext, conversationId: string): Promise<HistoryTurn[]> {
  await findConversation(ctx, conversationId);
  const orgId = requireOrg(ctx);
  const rows = (await orgRows(ctx.db, orgId, 'ai_messages', (q) => q
    .where('conversation_id', '==', conversationId)
    .orderBy('created_at', 'desc')
    .limit(HISTORY_TURNS * 2))).reverse();
  return rows.map((row) => ({
    role: row.role as 'user' | 'assistant',
    content: (row.content as string | null) ?? null,
    structured: (row.structured_response as SubmitAnswer | null) ?? null,
    groundingStatus: (row.grounding_status as string | null) ?? null,
  }));
}
