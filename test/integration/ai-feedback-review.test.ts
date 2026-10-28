import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { persistAssistantTurn } from '@/core/db';
import { countOpenFeedback, createConversation, listFeedback, loadFeedback, reviewFeedback, submitFeedback } from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { orgCollection, orgRow } from '@/db/schema';
import { addPlatformUser, assign, dropUsers, makeOrg } from './ai-fixtures';
import { clientFor, createAuthUser, deleteOrg, fs } from './setup';

/**
 * The review queue (AI_ARCHITECTURE.md §13; RBAC_MATRIX.md §2.1; ADR-082): who sees which reports,
 * what a reviewer gets to see about an answer, and what a review changes.
 */

const RUN = `fr${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.review.itest.motion`;

let ownerId: string;
let employeeId: string;
let strangerEmployeeId: string;
let adminId: string;
let orgId: string;
let feedbackId: string;
let messageId: string;

function orgContext(userId: string, role: EffectiveRole): AccessContext {
  return {
    userId, orgId, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
  };
}

/** A platform context: no organisation, the platform role's permissions. */
function platformContext(userId: string, role: 'super_admin' | 'employee'): AccessContext {
  return {
    userId, orgId: null, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: role === 'super_admin' ? 'platform_admin' : 'employee',
    db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: null,
  };
}

const STRUCTURED = {
  mode: 'answer',
  direct_answer: { statement: 'Sales were £1 in May 2026.', kind: 'deterministic_calculation', period: 'May 2026', evidence_refs: [], numbers: [], entity_refs: [] },
  key_findings: [], causes: [], risks: [], opportunities: [], recommended_actions: [],
  confidence: { data_quality_notes: [] }, evidence: [], unsupported: [],
};

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  employeeId = await createAuthUser(`employee@${DOMAIN}`);
  strangerEmployeeId = await createAuthUser(`stranger@${DOMAIN}`);
  adminId = await createAuthUser(`admin@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest Review ${RUN}`);
  await addPlatformUser(employeeId, 'employee');
  await addPlatformUser(strangerEmployeeId, 'employee');
  await addPlatformUser(adminId, 'super_admin');
  await assign(orgId, employeeId, 'active', adminId);

  const owner = orgContext(ownerId, 'owner');
  const conversationId = await createConversation(owner);
  // The answer and its tool call, as the server records them.
  ({ messageId } = await persistAssistantTurn({ userId: ownerId, requestId: `itest-${RUN}` }, {
    organizationId: orgId, conversationId,
    assistant: {
      structured_response: STRUCTURED, grounding_status: 'degraded',
      grounding_report: { mismatches: [{ path: 'key_findings[0]', statement: 'Marketing was £9,999.', reason: 'no such figure' }] },
      period_context: null, prompt_version: 'analyst-v3.0', model: 'scripted', input_tokens: 1, output_tokens: 1,
      latency_ms: 1, title: null,
    },
    toolCalls: [{
      sequence: 1, tool_name: 'get_metric', input: { metric_key: 'revenue' }, authorized: true, denial_reason: null,
      output_hash: null, output_summary: { ok: true }, duration_ms: 12, error: null, returned_ids: [], returned_hashes: [],
    }],
    bundle: null,
  }));
  feedbackId = await submitFeedback(owner, { messageId, type: 'incorrect', comment: 'The May figure is wrong.' });
});

afterAll(async () => {
  await deleteOrg(orgId);
  await dropUsers(DOMAIN);
});

const feedback = async () => (await orgRow(fs(), orgId, 'ai_feedback', feedbackId).get()).data()!;
const flagged = async () => (await orgRow(fs(), orgId, 'ai_messages', messageId).get()).get('flagged');

describe('who sees the queue', () => {
  it('a super admin sees the open report, with the answer, the removed sentence and the tool calls', async () => {
    const ctx = platformContext(adminId, 'super_admin');
    const open = await listFeedback(ctx, 'open');
    expect(open.map((f) => f.id)).toContain(feedbackId);
    expect(open.find((f) => f.id === feedbackId)?.groundingStatus).toBe('degraded');
    expect(await countOpenFeedback(ctx)).toBeGreaterThan(0);

    const detail = await loadFeedback(ctx, feedbackId);
    expect(detail.structured?.direct_answer.statement).toBe('Sales were £1 in May 2026.');
    expect(JSON.stringify(detail.groundingReport)).toContain('£9,999');
    expect(detail.toolCalls.map((c) => c.toolName)).toEqual(['get_metric']);
    expect(detail.groundingStatus).toBe('degraded');
    expect(detail.organizationSlug).toBeTruthy();
  });

  it('an assigned employee sees it; an unassigned employee sees nothing and gets 404 on the item', async () => {
    const assigned = await listFeedback(platformContext(employeeId, 'employee'), 'open');
    expect(assigned.map((f) => f.id)).toContain(feedbackId);
    const stranger = platformContext(strangerEmployeeId, 'employee');
    expect((await listFeedback(stranger, 'open')).map((f) => f.id)).not.toContain(feedbackId);
    await expect(loadFeedback(stranger, feedbackId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an organisation owner has no queue at all', async () => {
    await expect(listFeedback(orgContext(ownerId, 'owner'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('reviewing', () => {
  it('the assigned employee marks it reviewed: the message wears the badge, the note is kept, the audit says so', async () => {
    await reviewFeedback(platformContext(employeeId, 'employee'), { feedbackId, status: 'reviewed', note: 'Looked at it.' });
    const f = await feedback();
    expect(`${f.status}|${f.resolution_note}`).toBe('reviewed|Looked at it.');
    expect(f.reviewed_by).toBe(employeeId);
    expect(await flagged()).toBe(true);
    const audit = await fs().collection('audit_events').where('target_id', '==', feedbackId).get();
    expect(audit.docs.filter((d) => d.get('action') === 'ai.feedback_reviewed')).toHaveLength(1);
    expect((await listFeedback(platformContext(adminId, 'super_admin'), 'open')).map((x) => x.id)).not.toContain(feedbackId);
    expect((await listFeedback(platformContext(adminId, 'super_admin'), 'all')).map((x) => x.id)).toContain(feedbackId);
  });

  it('a super admin dismisses it and the badge comes off', async () => {
    await reviewFeedback(platformContext(adminId, 'super_admin'), { feedbackId, status: 'dismissed' });
    expect(await flagged()).toBe(false);
  });

  it('an owner cannot review, whatever the form says', async () => {
    await expect(reviewFeedback(orgContext(ownerId, 'owner'), { feedbackId, status: 'actioned' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('the review queue refuses to reopen an item, and an unassigned employee cannot review it at all', async () => {
    const { API_FUNCTIONS } = await import('@/db/api');
    await expect(API_FUNCTIONS.review_ai_feedback!(clientFor(adminId), { p_feedback: feedbackId, p_status: 'open' }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(API_FUNCTIONS.review_ai_feedback!(clientFor(strangerEmployeeId), { p_feedback: feedbackId, p_status: 'actioned' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await orgCollection(fs(), orgId, 'ai_feedback').get()).size).toBe(1);
  });
});
