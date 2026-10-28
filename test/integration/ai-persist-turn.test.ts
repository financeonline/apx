import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { persistAssistantTurn, persistUserTurn } from '@/core/db';
import { QuotaExceeded, NotFound } from '@/core/errors';
import { createConversation, findConversation, listConversations, loadHistory, loadMessages } from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { globalRow, newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import { addMember, dropUsers, makeOrg, periodOf, setOrgQuota } from './ai-fixtures';
import { clientFor, createAuthUser, deleteOrg, fs } from './setup';

/**
 * A turn is persisted by the server, into the actor's own conversation, and what the bundle may
 * cite is what the tools returned (AI_ARCHITECTURE.md §2, §4, §14.2, §14.14; ADR-076; R2-A-01).
 *
 * Driven through `core/db/server-rpc.ts` exactly as the route will drive it, against a real
 * organisation. Run-unique fixtures (ADR-052.12).
 */

const RUN = `ai${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.ai.itest.motion`;

let ownerId: string;
let clientUserId: string;
let orgId: string;
let snapshotId: string;

function contextFor(userId: string, role: 'owner' | 'client'): AccessContext {
  return {
    userId, orgId, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-06-15T00:00:00Z'), organizationStatus: 'active',
  };
}

const actor = (userId: string) => ({ userId, requestId: `itest-${RUN}` });
const row = async (table: Parameters<typeof orgRow>[2], id: string) => (await orgRow(fs(), orgId, table, id).get()).data();

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  clientUserId = await createAuthUser(`client@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest AI ${RUN}`);
  await addMember(orgId, clientUserId, 'client');

  // One real snapshot, so a bundle has something a tool could have returned.
  const period = periodOf(orgId, '2026-05-01');
  const run = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'calculation_runs', run).set({
    id: run, organization_id: orgId, job_id: null, trigger: 'recalc_manual', trigger_ref_id: null,
    engine_version: '1.0.0', period_from: period, period_to: period, as_of: '2026-06-15', as_of_ts: now,
    status: 'succeeded', failure_reason: null, stale: false, input_fingerprint: null, chunks: [], progress: {},
    started_at: now, finished_at: now, duration_ms: 1, error: null, stats: {}, created_at: now, updated_at: now,
  });
  snapshotId = newId();
  await orgRow(fs(), orgId, 'metric_snapshots', snapshotId).set({
    id: snapshotId, organization_id: orgId, calculation_run_id: run, period_id: period, metric_key: 'revenue',
    dimension_type: 'none', dimension_id: null, dimension_key: null, value: '25000.000000', unit: 'money',
    currency: 'GBP', basis: 'ledger', assurance_level: 'verified', data_quality: {}, components: {},
    evidence_query: null, created_at: now,
  });
});

afterAll(async () => {
  await deleteOrg(orgId);
  await dropUsers(DOMAIN);
});

describe('a conversation is bound to (organisation, user)', () => {
  it('the owner can find their own; the client cannot continue it', async () => {
    const owner = contextFor(ownerId, 'owner');
    const id = await createConversation(owner);
    expect((await findConversation(owner, id)).id).toBe(id);
    await expect(findConversation(contextFor(clientUserId, 'client'), id)).rejects.toBeInstanceOf(NotFound);
    // Each lists only their own: the client's read policy narrows to user_id, the list narrows again.
    const mine = await createConversation(contextFor(clientUserId, 'client'));
    expect((await listConversations(contextFor(clientUserId, 'client'))).map((c) => c.id)).toEqual([mine]);
    expect((await listConversations(owner)).map((c) => c.id)).toContain(id);
    expect((await listConversations(owner)).map((c) => c.id)).not.toContain(mine);
  });

  it('archiving: your own, or a colleague’s only with users.manage; a stranger’s id is NOT_FOUND', async () => {
    const { API_FUNCTIONS } = await import('@/db/api');
    const owner = contextFor(ownerId, 'owner');
    const ownersOwn = await createConversation(owner);
    const clients = await createConversation(contextFor(clientUserId, 'client'));
    await expect(API_FUNCTIONS.archive_conversation!(clientFor(clientUserId), { p_conversation: ownersOwn }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await API_FUNCTIONS.archive_conversation!(clientFor(ownerId), { p_conversation: clients })).toBe(clients);
    expect((await row('ai_conversations', clients))!.status).toBe('archived');
    await expect(findConversation(contextFor(clientUserId, 'client'), clients)).rejects.toBeInstanceOf(NotFound);
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
        denial_reason: null, output_hash: 'AB'.repeat(32), output_summary: { rows: 1 }, duration_ms: 12,
        error: null, returned_ids: [snapshotId], returned_hashes: [],
      }],
      bundle: {
        calculation_run_id: null,
        items: [{ item_type: 'metric_snapshot', ref_id: snapshotId, ref_revision_no: null, query_descriptor: null,
          descriptor_hash: null, label: 'Revenue, May 2026', claim: null, assurance_level: 'verified' }],
      },
    });
    expect(evidenceBundleId).toMatch(/^[0-9a-f-]{36}$/);

    const message = (await row('ai_messages', messageId))!;
    expect(message, 'assistant content is NULL; status and tokens are server facts')
      .toMatchObject({ role: 'assistant', content: null, grounding_status: 'passed', input_tokens: 120, evidence_bundle_id: evidenceBundleId });
    const calls = await orgCollection(fs(), orgId, 'ai_tool_calls').where('message_id', '==', messageId).get();
    expect(calls.size).toBe(1);
    expect(calls.docs[0]!.get('output_hash'), 'a bytea is lowercase hex').toBe('ab'.repeat(32));
    expect(await row('evidence_bundles', evidenceBundleId!)).toMatchObject({ kind: 'ai_response', created_by_type: 'ai', origin_id: messageId });
    const items = await orgCollection(fs(), orgId, 'evidence_items').where('bundle_id', '==', evidenceBundleId).get();
    expect(items.docs.map((d) => d.get('ref_id'))).toEqual([snapshotId]);
    const audit = await fs().collection('audit_events').where('target_id', '==', messageId).get();
    expect(audit.docs.map((d) => d.get('action'))).toEqual(['ai.answered']);
    expect(audit.docs[0]!.get('actor_user_id')).toBe(ownerId);
    expect((await row('ai_conversations', conversationId))!.title).toBe('Why revenue fell');
  });

  it('refuses a bundle citing an id no tool returned — the database, not the loop, decides', async () => {
    const before = (await orgCollection(fs(), orgId, 'ai_messages').where('conversation_id', '==', conversationId).get()).size;
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
    // Nothing of the refused turn is stored: the message and its bundle were one write.
    expect((await orgCollection(fs(), orgId, 'ai_messages').where('conversation_id', '==', conversationId).get()).size).toBe(before);
  });

  it('refuses a repeated tool-call sequence (ai_tool_calls_sequence_unique)', async () => {
    const call = {
      sequence: 1, tool_name: 'get_metric', input: {}, authorized: true, denial_reason: null, output_hash: null,
      output_summary: {}, duration_ms: 1, error: null, returned_ids: [], returned_hashes: [],
    };
    await expect(persistAssistantTurn(actor(ownerId), {
      organizationId: orgId, conversationId,
      assistant: {
        structured_response: null, grounding_status: 'failed', grounding_report: null, period_context: null,
        prompt_version: 'test', model: null, input_tokens: 0, output_tokens: 0, latency_ms: 1, title: null,
      },
      toolCalls: [call, call], bundle: null,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a failed turn is stored for review with no bundle', async () => {
    const { messageId, evidenceBundleId } = await persistAssistantTurn(actor(ownerId), {
      organizationId: orgId, conversationId,
      assistant: {
        structured_response: null, grounding_status: 'failed', grounding_report: { reason: 'timeout' },
        period_context: null, prompt_version: 'test', model: null, input_tokens: 0, output_tokens: 0,
        latency_ms: 45000, title: null,
      },
      toolCalls: [], bundle: null,
    });
    expect(evidenceBundleId).toBeNull();
    expect((await row('ai_messages', messageId))!.grounding_report).toEqual({ reason: 'timeout' });
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
    await setOrgQuota(orgId, { ai_quota_daily: 1 });
    await expect(persistUserTurn(actor(ownerId), {
      organizationId: orgId, conversationId, message: 'one more',
    })).rejects.toBeInstanceOf(QuotaExceeded);
    await setOrgQuota(orgId, null);
  });

  it('a monthly ceiling already spent refuses the turn too', async () => {
    await setOrgQuota(orgId, { ai_token_ceiling_monthly: 100 });
    await expect(persistUserTurn(actor(ownerId), {
      organizationId: orgId, conversationId, message: 'one more',
    })).rejects.toThrow(/monthly analyst allowance/);
    await setOrgQuota(orgId, null);
  });

  it('is the server’s alone: a user handle cannot persist a turn', async () => {
    const { SERVER_FUNCTIONS } = await import('@/db/api_server');
    await expect(SERVER_FUNCTIONS.ai_persist_turn!(clientFor(ownerId), {
      p_actor: ownerId, p_org: orgId, p_conversation: conversationId, p_user_message: 'forged',
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await globalRow(fs(), 'profiles', ownerId).get()).exists).toBe(true);
  });
});
