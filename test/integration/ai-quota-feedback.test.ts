import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { persistAssistantTurn, persistUserTurn } from '@/core/db';
import { aiQuotaStatus, createConversation, quotaExhausted, submitFeedback } from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { orgRow } from '@/db/schema';
import { dropUsers, makeOrg } from './ai-fixtures';
import { clientFor, createAuthUser, deleteOrg, fs } from './setup';

/**
 * The analyst page's two small services (Phase 11 Slice 4, ADR-079): the quota as the member sees
 * it, counted the way the refusal counts, and "Report this answer".
 */

const RUN = `aq${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.quota.itest.motion`;

let ownerId: string;
let strangerId: string;
let orgId: string;
let messageId: string;

function contextFor(userId: string, role: 'owner' | 'client' = 'owner', org = orgId): AccessContext {
  return {
    userId, orgId: org, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
  };
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  strangerId = await createAuthUser(`stranger@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest Quota ${RUN}`);
});

afterAll(async () => {
  await deleteOrg(orgId);
  await dropUsers(DOMAIN);
});

describe('aiQuotaStatus counts what ai_persist_turn charges', () => {
  it('starts at zero against the platform default, and moves when a user turn is persisted', async () => {
    const ctx = contextFor(ownerId);
    const before = await aiQuotaStatus(ctx);
    expect(before.usedToday).toBe(0);
    expect(before.dailyLimit).toBe(100);
    expect(before.remainingToday).toBe(100);
    expect(before.tokensMonth).toBe(0);
    expect(before.monthlyExhausted).toBe(false);
    expect(quotaExhausted(before)).toBeNull();
    expect(new Date(before.resetsAt).getTime()).toBeGreaterThan(Date.now());

    const conversationId = await createConversation(ctx);
    const actor = { userId: ownerId, requestId: ctx.requestId };
    await persistUserTurn(actor, { organizationId: orgId, conversationId, message: 'How was May?' });
    // The assistant's tokens count toward the month (app.ai_tokens_used_this_month).
    ({ messageId } = await persistAssistantTurn(actor, {
      organizationId: orgId, conversationId,
      assistant: {
        structured_response: {}, grounding_status: 'failed', grounding_report: null, period_context: null,
        prompt_version: 'test', model: null, input_tokens: 70, output_tokens: 30, latency_ms: 1, title: null,
      },
      toolCalls: [], bundle: null,
    }));

    const after = await aiQuotaStatus(ctx);
    expect(after.usedToday).toBe(1);
    expect(after.remainingToday).toBe(99);
    expect(after.tokensMonth).toBe(100);
  });

  it('reports exhaustion the way the refusal would', () => {
    const base = { usedToday: 0, dailyLimit: 100, remainingToday: 100, tokensMonth: 0, monthlyCeiling: 1, monthlyExhausted: false, resetsAt: '' };
    expect(quotaExhausted({ ...base, remainingToday: 0 })).toBe('daily');
    expect(quotaExhausted({ ...base, monthlyExhausted: true })).toBe('monthly');
    expect(quotaExhausted({ ...base, dailyLimit: null, remainingToday: null })).toBeNull();
  });

  it('is NOT_FOUND for an organisation the caller cannot reach', async () => {
    await expect(aiQuotaStatus(contextFor(strangerId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('submitFeedback', () => {
  it('records a report against an assistant message of the caller’s organisation', async () => {
    const ctx = contextFor(ownerId);
    const feedbackId = await submitFeedback(ctx, { messageId, type: 'incorrect', comment: '  The May figure is wrong.  ' });
    expect(feedbackId).toMatch(/^[0-9a-f-]{36}$/);
    const feedback = (await orgRow(fs(), orgId, 'ai_feedback', feedbackId).get()).data()!;
    expect(`${feedback.feedback_type}|${feedback.comment}`).toBe('incorrect|The May figure is wrong.');
    expect(feedback.status).toBe('open');
    // Reporting does not flag the message; platform review does (§13).
    expect((await orgRow(fs(), orgId, 'ai_messages', messageId).get()).get('flagged')).toBe(false);
    const audit = await fs().collection('audit_events').where('target_id', '==', feedbackId).get();
    expect(audit.docs.map((d) => d.get('action'))).toEqual(['ai.feedback_submitted']);
  });

  it('refuses a message the caller cannot reach, as NOT_FOUND', async () => {
    await expect(submitFeedback(contextFor(strangerId), { messageId, type: 'unhelpful' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an over-long note before the database sees it', async () => {
    await expect(submitFeedback(contextFor(ownerId), { messageId, type: 'unhelpful', comment: 'x'.repeat(1_001) }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
