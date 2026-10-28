import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { QuotaExceeded } from '@/core/errors';
import { drainJobs } from '@/modules/jobs';
import {
  answer, createConversation, FALLBACK_MESSAGE, SUBMIT_ANSWER_TOOL, REFUSAL_TEMPLATES,
  type ModelCall, type ModelResponse, type ModelTransport, type SubmitAnswer,
} from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { orgCollection, orgRow } from '@/db/schema';
import {
  addCommittedBatch, currentSnapshot, dropUsers, dropWhere, enqueue, makeOrg, periodOf, postLedger, setOrgQuota,
} from './ai-fixtures';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs } from './setup';

/**
 * The analyst turn, end to end, against a real computed organisation and a SCRIPTED model
 * (AI_ARCHITECTURE.md §2, §7.8, §14; TEST_STRATEGY.md §10.2).
 *
 * The transport is a script: each test says exactly what "the model" returns, so what is under
 * test is the loop's ORDER and the server's decisions — the user turn charged first, tools run and
 * re-authorised, text discarded, the contract validated, grounding judged, degradation by removal,
 * the bundle built from what the tools returned, and every fact persisted by the server. No key,
 * no network, and the same script always produces the same verdict.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `an${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.answer.itest.motion`;

let ownerId: string;
let orgId: string;
let mayPeriodId: string;
let revenueSnapshot: string;

/** The stored assistant message of a turn, as the server wrote it. */
const message = async (id: string) => (await orgRow(fs(), orgId, 'ai_messages', id).get()).data()!;

function contextFor(userId: string, role: 'owner' | 'client' = 'owner'): AccessContext {
  return {
    userId, orgId, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-06-15T00:00:00Z'), organizationStatus: 'active',
  };
}

const uses = (name: string, input: unknown, id = `tu-${Math.random().toString(36).slice(2, 8)}`): ModelResponse => ({
  content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } } as ModelResponse['content'][number]],
  stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 20 }, model: 'scripted',
});

/** A model that follows a fixed script of responses, then keeps answering with the last one. */
function scripted(responses: readonly ModelResponse[]): ModelTransport & { calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  let i = 0;
  const transport = (async (call: ModelCall) => {
    calls.push(call);
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return r;
  }) as ModelTransport & { calls: ModelCall[] };
  transport.calls = calls;
  return transport;
}

function statement(text: string, over: Partial<SubmitAnswer['direct_answer']> = {}): SubmitAnswer['direct_answer'] {
  return { statement: text, kind: 'verified_fact', period: 'May 2026', evidence_refs: [], numbers: [], entity_refs: [], ...over };
}

function submission(over: Partial<SubmitAnswer>): SubmitAnswer {
  return {
    mode: 'answer',
    direct_answer: statement('x'),
    key_findings: [], causes: [], risks: [], opportunities: [], recommended_actions: [],
    confidence: { data_quality_notes: [] }, evidence: [], unsupported: [],
    ...over,
  };
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest Answer ${RUN}`);
  mayPeriodId = periodOf(orgId, '2026-05-01');

  const batch = await addCommittedBatch(orgId, {
    importType: 'general_ledger', targetTable: 'ledger_entries', periodStart: '2026-05-01', periodEnd: '2026-05-31',
    filename: 'gl.csv', documentKind: 'general_ledger',
  });
  await postLedger(orgId, batch, { category: 'revenue', direction: 'credit', amount: '20000.00', date: '2026-05-10', line: 2 });

  const jobId = await enqueue(orgId, 'calculation.run', { trigger: 'recalc_manual', as_of: '2026-06-15' });
  expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
  revenueSnapshot = await currentSnapshot(orgId, mayPeriodId, 'revenue');
}, 120_000);

afterAll(async () => {
  await deleteOrg(orgId);
  await dropWhere('jobs', 'organization_id', [orgId]);
  await dropUsers(DOMAIN);
});

async function turn(transport: ModelTransport, message = 'How was revenue in May 2026?', ctx = contextFor(ownerId)) {
  const conversationId = await createConversation(ctx);
  const statuses: string[] = [];
  const out = await answer({
    ctx, conversationId, message, transport,
    resolveAccess: async () => ctx,
    onStatus: (e) => statuses.push(e.tool),
    now: new Date('2026-06-15T00:00:00Z'),
  });
  return { out, statuses, conversationId };
}

describe('a grounded answer (§2 happy path)', () => {
  it('calls a tool, grounds the figure, builds a bundle from what the tool returned, and persists it all', async () => {
    let revenueDisplay = '';
    const transport = scripted([
      uses('get_metric', { metric_key: 'revenue', period: 'May 2026' }, 'tu-1'),
      // The second call sees the tool result; the script reads the display value out of it.
      {
        get content() {
          // The tool result is a JSON string inside a tool_result block; read it as the model would.
          const last = transport.calls[transport.calls.length - 1]!;
          const blocks = last.messages[last.messages.length - 1]!.content as Array<{ type: string; content?: string }>;
          const reply = blocks.find((b) => b.type === 'tool_result')?.content ?? '';
          revenueDisplay = /"display":"(£[\d,]+)"/.exec(reply)?.[1] ?? '';
          return [{ type: 'tool_use', id: 'tu-2', name: SUBMIT_ANSWER_TOOL, caller: { type: 'direct' },
            input: submission({
              direct_answer: statement(`Revenue was ${revenueDisplay} in May 2026.`, {
                evidence_refs: [{ type: 'metric_snapshot', id: revenueSnapshot }],
                numbers: [{ text: revenueDisplay, tool_call_seq: 1, path: 'value', metric_key: 'revenue', entity_id: null }],
              }),
              key_findings: [statement(`Revenue was ${revenueDisplay} in May 2026.`, {
                evidence_refs: [{ type: 'metric_snapshot', id: revenueSnapshot }],
                numbers: [{ text: revenueDisplay, tool_call_seq: 1, path: 'value', metric_key: 'revenue', entity_id: null }],
              })],
              evidence: [{ type: 'metric_snapshot', id: revenueSnapshot }],
            }) } as ModelResponse['content'][number]];
        },
        stopReason: 'tool_use', usage: { inputTokens: 200, outputTokens: 80 }, model: 'scripted',
      } as ModelResponse,
    ]);

    const { out, statuses } = await turn(transport);
    // On failure, surface the server's own reason and the tool's record rather than the outcome.
    const stored = await message(out.messageId);
    const calls = await orgCollection(fs(), orgId, 'ai_tool_calls').where('message_id', '==', out.messageId).get();
    const diagnostics = `report=${JSON.stringify(stored.grounding_report)} || tool=${JSON.stringify(calls.docs[0]?.data() ?? null)}`;
    expect(out.groundingStatus, diagnostics).toBe('passed');
    expect(statuses).toEqual(['get_metric']);
    expect(out.toolCalls).toBe(1);
    expect(out.evidenceBundleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.answer?.direct_answer.statement).toContain(revenueDisplay);
    expect(revenueDisplay).toMatch(/^£/);

    // Persisted by the server: the assistant row, the tool call, the bundle citing the snapshot.
    expect(`${stored.grounding_status}|${stored.input_tokens}|${stored.output_tokens}`).toBe('passed|300|100');
    expect(calls.docs.filter((d) => d.get('authorized') === true)).toHaveLength(1);
    const items = await orgCollection(fs(), orgId, 'evidence_items').where('bundle_id', '==', out.evidenceBundleId).get();
    expect(items.docs.filter((d) => d.get('item_type') === 'metric_snapshot').map((d) => d.get('ref_id'))).toEqual([revenueSnapshot]);
  });

  it('the forced final call carries tool_choice = submit_answer once the budget is spent, and text blocks are never stored', async () => {
    const transport = scripted([
      { content: [{ type: 'text', text: 'Let me think about revenue being £999,999…' } as ModelResponse['content'][number]], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'scripted' },
      uses(SUBMIT_ANSWER_TOOL, submission({ mode: 'refusal', direct_answer: statement(REFUSAL_TEMPLATES.off_topic, { period: null, kind: 'inference' }) })),
    ]);
    const { out } = await turn(transport, 'Write me a poem');
    expect(out.groundingStatus).toBe('not_applicable');
    expect(transport.calls[1]!.toolChoice).toEqual({ type: 'tool', name: SUBMIT_ANSWER_TOOL });
    // F-C-08: the text block's figure is nowhere.
    const stored = await message(out.messageId);
    expect(stored.content).toBeNull();
    expect(JSON.stringify(stored.structured_response)).not.toContain('999,999');
  });
});

describe('grounding failure degrades by removal, never by caveat (§7.8, F-C-14, R2-C-04)', () => {
  it('a fabricated figure is removed on the second failure, its topic is digit-free, and no Create action survives', async () => {
    const fabricated = () => submission({
      direct_answer: statement('Marketing spend was £9,999 in May 2026.', {
        evidence_refs: [{ type: 'metric_snapshot', id: revenueSnapshot }],
        numbers: [{ text: '£9,999', tool_call_seq: 1, path: 'nowhere', metric_key: 'marketing', entity_id: null }],
      }),
      key_findings: [statement('Marketing spend was £9,999 in May 2026.', {
        evidence_refs: [{ type: 'metric_snapshot', id: revenueSnapshot }],
        numbers: [{ text: '£9,999', tool_call_seq: 1, path: 'nowhere', metric_key: 'marketing', entity_id: null }],
      })],
      recommended_actions: [{
        title: statement('Cut marketing', { kind: 'recommendation', period: null, evidence_refs: [{ type: 'metric_snapshot', id: revenueSnapshot }] }),
        issue: statement('It is high', { kind: 'recommendation', period: null, evidence_refs: [{ type: 'metric_snapshot', id: revenueSnapshot }] }),
        recommendation: statement('Reduce it', { kind: 'recommendation', period: null, evidence_refs: [{ type: 'metric_snapshot', id: revenueSnapshot }] }),
        priority: 'high',
      }],
      evidence: [{ type: 'metric_snapshot', id: revenueSnapshot }],
    });
    const transport = scripted([
      uses('get_metric', { metric_key: 'revenue', period: 'May 2026' }),
      uses(SUBMIT_ANSWER_TOOL, fabricated()),
      uses(SUBMIT_ANSWER_TOOL, fabricated()),   // the regeneration repeats the mistake
    ]);
    const { out } = await turn(transport);
    expect(out.groundingStatus).toBe('degraded');
    // The regeneration was asked for with the reason, wrapped as data.
    const regen = transport.calls[2]!.messages[transport.calls[2]!.messages.length - 1]!;
    expect(JSON.stringify(regen.content)).toMatch(/could not be verified/);
    expect(JSON.stringify(regen.content)).toContain('<data name=\\"reason\\">');

    const rendered = JSON.stringify(out.answer);
    expect(rendered).not.toContain('9,999');
    expect(out.answer?.direct_answer.statement).toBe('I could not verify some figures for this question. Here is what the data shows:');
    expect(out.answer?.unsupported.every((u) => !/\d/.test(u.topic))).toBe(true);
    // R2-C-04 (ADR-081): the topic is built from what the server knows. "marketing" was the MODEL's
    // metric_key on a path no tool returned — model text — so it is not echoed; the period is.
    expect(out.answer?.unsupported.length).toBeGreaterThan(0);
    expect(out.answer?.unsupported.some((u) => /marketing/i.test(u.topic))).toBe(false);
    expect(out.answer?.unsupported.some((u) => /May/.test(u.topic))).toBe(true);
    // The recommendation rested on a removed statement's evidence alone... but its refs cite the
    // revenue snapshot, which no surviving statement cites either — so it goes.
    expect(out.answer?.recommended_actions).toEqual([]);
    // The removed text lives only in the report.
    const stored = await message(out.messageId);
    expect(JSON.stringify(stored.grounding_report)).toContain('9,999');
    expect(JSON.stringify(stored.structured_response)).not.toContain('9,999');
  });
});

describe('failure is honest (§7.8, §10.2)', () => {
  it('a model error after the retry is stored as failed with no bundle', async () => {
    const transport: ModelTransport = async () => { throw new Error('ECONNRESET'); };
    const { out } = await turn(transport);
    expect(out.groundingStatus).toBe('failed');
    expect(out.answer).toBeNull();
    expect(out.evidenceBundleId).toBeNull();
    expect(String((await message(out.messageId)).grounding_report?.reason)).toMatch(/model_error|upstream/);
    expect(FALLBACK_MESSAGE).toMatch(/unavailable/);
  });

  it('an inadmissible mode after the retry is failed, not rendered as a considered decision (R2-C-06)', async () => {
    // "no_data" while a tool returned figures: inadmissible, twice.
    const bad = () => submission({ mode: 'no_data', direct_answer: statement('There is no data.', { period: null, kind: 'inference', evidence_refs: [{ type: 'metric_snapshot', id: revenueSnapshot }] }) });
    const transport = scripted([
      uses('get_metric', { metric_key: 'revenue', period: 'May 2026' }),
      uses(SUBMIT_ANSWER_TOOL, bad()),
      uses(SUBMIT_ANSWER_TOOL, bad()),
    ]);
    const { out } = await turn(transport);
    expect(out.groundingStatus).toBe('failed');
    expect((await message(out.messageId)).grounding_report?.reason).toBe('inadmissible_after_retry');
  });

  it('the quota is charged before any model call, and an exhausted organisation never reaches the model', async () => {
    await setOrgQuota(orgId, { ai_quota_daily: 0 });
    let modelCalled = false;
    const transport: ModelTransport = async () => { modelCalled = true; throw new Error('should not be called'); };
    await expect(turn(transport)).rejects.toBeInstanceOf(QuotaExceeded);
    expect(modelCalled).toBe(false);
    await setOrgQuota(orgId, null);
  });
});

describe('the prompt (§9)', () => {
  it('caches sections 1–6 with no tenant text, and puts the organisation after the breakpoint', async () => {
    const transport = scripted([uses(SUBMIT_ANSWER_TOOL, submission({ mode: 'refusal', direct_answer: statement(REFUSAL_TEMPLATES.off_topic, { period: null, kind: 'inference' }) }))]);
    await turn(transport, 'hello');
    const system = transport.calls[0]!.system;
    expect(system[0]!.cached).toBe(true);
    expect(system[0]!.text).not.toContain(`ITest Answer ${RUN}`);
    expect(system[1]!.cached).toBe(false);
    expect(system[1]!.text).toContain(`ITest Answer ${RUN}`);
    expect(system[1]!.text).toContain('period_context');
    // The question arrives wrapped.
    const last = transport.calls[0]!.messages[transport.calls[0]!.messages.length - 1]!;
    expect(last.content).toBe('<user_question>hello</user_question>');
  });
});
