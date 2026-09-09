import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { countOpenFeedback, createConversation, listFeedback, loadFeedback, reviewFeedback, submitFeedback } from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * The review queue (AI_ARCHITECTURE.md §13; RBAC_MATRIX.md §2.1; ADR-082): who sees which reports,
 * what a reviewer gets to see about an answer, and what a review changes.
 */

const RUN = `fr${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.review.itest`;

let ownerId: string;
let employeeId: string;
let strangerEmployeeId: string;
let adminId: string;
let orgId: string;
let feedbackId: string;
let messageId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function orgContext(userId: string, role: EffectiveRole): AccessContext {
  return {
    userId, orgId, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
  };
}

/** A platform context: no organisation, aal2, the platform role's permissions. */
function platformContext(userId: string, role: 'super_admin' | 'employee'): AccessContext {
  return {
    userId, orgId: null, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: role === 'super_admin' ? 'platform_admin' : 'employee',
    db: clientFor(userId, { email: `${role}@${DOMAIN}`, aal: 'aal2' }),
    requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: null,
  };
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  employeeId = createAuthUser(`employee@${DOMAIN}`);
  strangerEmployeeId = createAuthUser(`stranger@${DOMAIN}`);
  adminId = createAuthUser(`admin@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Review ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  adminSql(`
    insert into public.platform_users (user_id, platform_role, status) values
      ('${employeeId}', 'employee', 'active'), ('${strangerEmployeeId}', 'employee', 'active'), ('${adminId}', 'super_admin', 'active');
    insert into public.organization_assignments (organization_id, employee_user_id, assigned_by, status)
    values ('${orgId}', '${employeeId}', '${adminId}', 'active');`);

  const owner = orgContext(ownerId, 'owner');
  const conversationId = await createConversation(owner);
  messageId = one(`
    insert into public.ai_messages (organization_id, conversation_id, role, structured_response, grounding_status, grounding_report, prompt_version, model)
    values ('${orgId}', '${conversationId}', 'assistant',
            '{"mode":"answer","direct_answer":{"statement":"Sales were £1 in May 2026.","kind":"deterministic_calculation","period":"May 2026","evidence_refs":[],"numbers":[],"entity_refs":[]},"key_findings":[],"causes":[],"risks":[],"opportunities":[],"recommended_actions":[],"confidence":{"data_quality_notes":[]},"evidence":[],"unsupported":[]}'::jsonb,
            'degraded', '{"mismatches":[{"path":"key_findings[0]","statement":"Marketing was £9,999.","reason":"no such figure"}]}'::jsonb, 'analyst-v3.0', 'scripted') returning id`);
  adminSql(`
    insert into public.ai_tool_calls (organization_id, message_id, sequence, tool_name, input, authorized, output_summary, duration_ms)
    values ('${orgId}', '${messageId}', 1, 'get_metric', '{"metric_key":"revenue"}'::jsonb, true, '{"ok":true}'::jsonb, 12)`);
  feedbackId = await submitFeedback(owner, { messageId, type: 'incorrect', comment: 'The May figure is wrong.' });
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Review%${RUN}';
    delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('who sees the queue', () => {
  it('a super admin sees the open report, with the answer, the removed sentence and the tool calls', async () => {
    const ctx = platformContext(adminId, 'super_admin');
    const open = await listFeedback(ctx, 'open');
    expect(open.map((f) => f.id)).toContain(feedbackId);
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
    expect(adminSql(`select status || '|' || resolution_note from public.ai_feedback where id = '${feedbackId}'`)).toBe('reviewed|Looked at it.');
    expect(adminSql(`select flagged from public.ai_messages where id = '${messageId}'`)).toBe('t');
    expect(adminSql(`select count(*) from public.audit_events where organization_id = '${orgId}' and action = 'ai.feedback_reviewed'`)).toBe('1');
    expect((await listFeedback(platformContext(adminId, 'super_admin'), 'open')).map((f) => f.id)).not.toContain(feedbackId);
  });

  it('a super admin dismisses it and the badge comes off', async () => {
    await reviewFeedback(platformContext(adminId, 'super_admin'), { feedbackId, status: 'dismissed' });
    expect(adminSql(`select flagged from public.ai_messages where id = '${messageId}'`)).toBe('f');
  });

  it('an owner cannot review, whatever the form says', async () => {
    await expect(reviewFeedback(orgContext(ownerId, 'owner'), { feedbackId, status: 'actioned' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
