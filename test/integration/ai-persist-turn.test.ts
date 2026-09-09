import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { persistAssistantTurn, persistUserTurn } from '@/core/db';
import { QuotaExceeded, NotFound } from '@/core/errors';
import { createConversation, findConversation, loadHistory, loadMessages } from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * A turn is persisted by the server, into the actor's own conversation, and what the bundle may
 * cite is what the tools returned (AI_ARCHITECTURE.md §2, §4, §14.2, §14.14; ADR-076; R2-A-01).
 *
 * Driven through `core/db/server-rpc.ts` exactly as the route will drive it, against a real
 * organisation. Run-unique fixtures (ADR-052.12).
 */

const RUN = `ai${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.ai.itest`;

let ownerId: string;
let clientUserId: string;
let orgId: string;
let snapshotId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function contextFor(userId: string, role: 'owner' | 'client'): AccessContext {
  return {
    userId, orgId, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-06-15T00:00:00Z'), organizationStatus: 'active',
  };
}

const actor = (userId: string) => ({ userId, requestId: `itest-${RUN}` });

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  clientUserId = createAuthUser(`client@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest AI ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  adminSql(`
    set local app.bootstrap = 'on';
    insert into public.organization_memberships (organization_id, user_id, role)
    values ('${orgId}', '${clientUserId}', 'client');`);

  // One real snapshot, so a bundle has something a tool could have returned.
  const period = one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-05-01'`);
  const run = one(`
    insert into public.calculation_runs (organization_id, trigger, status, started_at, engine_version, period_from, period_to, as_of)
    values ('${orgId}', 'recalc_manual', 'succeeded', now(), '1.0.0', '${period}', '${period}', '2026-06-15') returning id`);
  snapshotId = one(`
    insert into public.metric_snapshots (organization_id, period_id, calculation_run_id, metric_key, dimension_type, value, unit, basis, assurance_level)
    values ('${orgId}', '${period}', '${run}', 'revenue', 'none', 25000.00, 'money', 'ledger', 'verified') returning id`);
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest AI%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest AI %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.ai.itest' and created_at < now() - interval '1 hour';`);
});

describe('a conversation is bound to (organisation, user)', () => {
  it('the owner can find their own; the client cannot continue it', async () => {
    const owner = contextFor(ownerId, 'owner');
    const id = await createConversation(owner);
    expect((await findConversation(owner, id)).id).toBe(id);
    await expect(findConversation(contextFor(clientUserId, 'client'), id)).rejects.toBeInstanceOf(NotFound);
  });

  it('a foreign or invented id is NotFound before any model call', async () => {
    await expect(findConversation(contextFor(ownerId, 'owner'), '00000000-0000-4000-8000-000000000000'))
      .rejects.toBeInstanceOf(NotFound);
  });
});

describe('the server persists a turn', () => {
  let conversationId: string;

  it('the user half charges the quota and stores the text', async () => {
    conversationId = await createConversation(contextFor(ownerId, 'owner'));
    const { messageId, quota } = await persistUserTurn(actor(ownerId), {
      organizationId: orgId, conversationId, message: 'why did revenue fall?',
    });
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(quota.used_today).toBe(1);
    expect(quota.daily).toBe(100);
  });

  it('refuses another actor into that conversation with NotFound', async () => {
    await expect(persistUserTurn(actor(clientUserId), {
      organizationId: orgId, conversationId, message: 'hijack',
    })).rejects.toBeInstanceOf(NotFound);
  });

  it('the assistant half writes the message, the tool calls and a bundle from returned ids only', async () => {
    const { messageId, evidenceBundleId } = await persistAssistantTurn(actor(ownerId), {
      organizationId: orgId, conversationId,
      assistant: {
        structured_response: { mode: 'answer', direct_answer: { statement: 'x' } },
        grounding_status: 'passed', grounding_report: null, period_context: null,
        prompt_version: 'test', model: 'test-model', input_tokens: 120, output_tokens: 40,
        latency_ms: 900, title: 'Why revenue fell',
      },
      toolCalls: [{
        sequence: 1, tool_name: 'get_metric', input: { metric_key: 'revenue' }, authorized: true,
        denial_reason: null, output_hash: 'ab'.repeat(32), output_summary: { rows: 1 }, duration_ms: 12,
        error: null, returned_ids: [snapshotId], returned_hashes: [],
      }],
      bundle: {
        calculation_run_id: null,
        items: [{ item_type: 'metric_snapshot', ref_id: snapshotId, ref_revision_no: null, query_descriptor: null,
          descriptor_hash: null, label: 'Revenue, May 2026', claim: null, assurance_level: 'verified' }],
      },
    });
    expect(evidenceBundleId).toMatch(/^[0-9a-f-]{36}$/);

    const row = adminSql(`
      select role || '|' || coalesce(content, 'NULL') || '|' || grounding_status || '|' || input_tokens
        from public.ai_messages where id = '${messageId}'`);
    expect(row, 'assistant content is NULL; status and tokens are server facts').toBe('assistant|NULL|passed|120');
    expect(adminSql(`select count(*) from public.ai_tool_calls where message_id = '${messageId}'`)).toBe('1');
    expect(adminSql(`
      select kind || '|' || created_by_type from public.evidence_bundles where id = '${evidenceBundleId}'`)).toBe('ai_response|ai');
    expect(adminSql(`
      select action from public.audit_events where organization_id = '${orgId}' and target_id = '${messageId}'`)).toBe('ai.answered');
    expect(adminSql(`select title from public.ai_conversations where id = '${conversationId}'`)).toBe('Why revenue fell');
  });

  it('refuses a bundle citing an id no tool returned — the database, not the loop, decides', async () => {
    await expect(persistAssistantTurn(actor(ownerId), {
      organizationId: orgId, conversationId,
      assistant: {
        structured_response: {}, grounding_status: 'passed', grounding_report: null, period_context: null,
        prompt_version: 'test', model: null, input_tokens: 1, output_tokens: 1, latency_ms: 1, title: null,
      },
      toolCalls: [],
      bundle: { calculation_run_id: null, items: [{ item_type: 'metric_snapshot', ref_id: snapshotId,
        ref_revision_no: null, query_descriptor: null, descriptor_hash: null, label: 'x', claim: null, assurance_level: 'verified' }] },
    })).rejects.toThrow(/no tool returned this turn/);
  });

  it('a failed turn is stored for review with no bundle', async () => {
    const { evidenceBundleId } = await persistAssistantTurn(actor(ownerId), {
      organizationId: orgId, conversationId,
      assistant: {
        structured_response: null, grounding_status: 'failed', grounding_report: { reason: 'timeout' },
        period_context: null, prompt_version: 'test', model: null, input_tokens: 0, output_tokens: 0,
        latency_ms: 45000, title: null,
      },
      toolCalls: [], bundle: null,
    });
    expect(evidenceBundleId).toBeNull();
  });

  it('history replays the owner’s turns oldest first, assistant turns as JSON only', async () => {
    const history = await loadHistory(contextFor(ownerId, 'owner'), conversationId);
    expect(history[0]?.role).toBe('user');
    expect(history[0]?.content).toBe('why did revenue fall?');
    const assistant = history.find((t) => t.role === 'assistant');
    expect(assistant?.content, 'assistant prose is never replayed').toBeNull();
    expect(assistant?.structured).toMatchObject({ mode: 'answer' });
  });

  it('messages of a colleague’s conversation are readable by an owner but the client gets NotFound', async () => {
    const asClient = contextFor(clientUserId, 'client');
    await expect(loadMessages(asClient, conversationId)).rejects.toBeInstanceOf(NotFound);
    const asOwner = await loadMessages(contextFor(ownerId, 'owner'), conversationId);
    expect(asOwner.length).toBeGreaterThanOrEqual(3);
  });

  it('the daily quota is enforced before any model call', async () => {
    adminSql(`
      insert into public.platform_org_settings (organization_id, ai_quota_daily)
      values ('${orgId}', 1) on conflict (organization_id) do update set ai_quota_daily = 1`);
    await expect(persistUserTurn(actor(ownerId), {
      organizationId: orgId, conversationId, message: 'one more',
    })).rejects.toBeInstanceOf(QuotaExceeded);
    adminSql(`delete from public.platform_org_settings where organization_id = '${orgId}'`);
  });
});
