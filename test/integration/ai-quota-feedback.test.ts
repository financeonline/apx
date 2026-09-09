import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { persistUserTurn } from '@/core/db';
import { aiQuotaStatus, createConversation, quotaExhausted, submitFeedback } from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * The analyst page's two small services (Phase 11 Slice 4, ADR-079): the quota as the member sees
 * it, counted the way the refusal counts, and "Report this answer".
 */

const RUN = `aq${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.quota.itest`;

let ownerId: string;
let strangerId: string;
let orgId: string;

function contextFor(userId: string, role: 'owner' | 'client' = 'owner', org = orgId): AccessContext {
  return {
    userId, orgId: org, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
  };
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  strangerId = createAuthUser(`stranger@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Quota ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Quota%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('aiQuotaStatus counts what ai_persist_turn charges', () => {
  it('starts at zero against the platform default, and moves when a user turn is persisted', async () => {
    const ctx = contextFor(ownerId);
    const before = await aiQuotaStatus(ctx);
    expect(before.usedToday).toBe(0);
    expect(before.dailyLimit).toBe(100);
    expect(before.remainingToday).toBe(100);
    expect(before.monthlyExhausted).toBe(false);
    expect(quotaExhausted(before)).toBeNull();
    expect(new Date(before.resetsAt).getTime()).toBeGreaterThan(Date.now());

    const conversationId = await createConversation(ctx);
    await persistUserTurn({ userId: ownerId, requestId: ctx.requestId }, { organizationId: orgId, conversationId, message: 'How was May?' });

    const after = await aiQuotaStatus(ctx);
    expect(after.usedToday).toBe(1);
    expect(after.remainingToday).toBe(99);
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
    const conversationId = await createConversation(ctx);
    const messageId = adminSql(`
      insert into public.ai_messages (organization_id, conversation_id, role, structured_response, grounding_status)
      values ('${orgId}', '${conversationId}', 'assistant', '{}'::jsonb, 'failed') returning id`).split('\n')[0]!.trim();

    const feedbackId = await submitFeedback(ctx, { messageId, type: 'incorrect', comment: '  The May figure is wrong.  ' });
    expect(feedbackId).toMatch(/^[0-9a-f-]{36}$/);
    expect(adminSql(`select feedback_type || '|' || comment from public.ai_feedback where id = '${feedbackId}'`))
      .toBe('incorrect|The May figure is wrong.');
    // Reporting does not flag the message; platform review does (§13).
    expect(adminSql(`select flagged from public.ai_messages where id = '${messageId}'`)).toBe('f');
  });

  it('refuses a message the caller cannot reach, as NOT_FOUND', async () => {
    const messageId = adminSql(`select id from public.ai_messages where organization_id = '${orgId}' and role = 'assistant' limit 1`);
    await expect(submitFeedback(contextFor(strangerId), { messageId, type: 'unhelpful' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an over-long note before the database sees it', async () => {
    const messageId = adminSql(`select id from public.ai_messages where organization_id = '${orgId}' and role = 'assistant' limit 1`);
    await expect(submitFeedback(contextFor(ownerId), { messageId, type: 'unhelpful', comment: 'x'.repeat(1_001) }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
