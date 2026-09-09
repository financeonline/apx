import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { QuotaExceeded } from '@/core/errors';
import { drainJobs } from '@/modules/jobs';
import {
  answer, createConversation, FALLBACK_MESSAGE, SUBMIT_ANSWER_TOOL, REFUSAL_TEMPLATES,
  type ModelCall, type ModelResponse, type ModelTransport, type SubmitAnswer,
} from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

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
const DOMAIN = `${RUN}.answer.itest`;

let ownerId: string;
let orgId: string;
let mayPeriodId: string;
let revenueSnapshot: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

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
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Answer ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  mayPeriodId = one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-05-01'`);

  const revenueAccount = one(`select id from public.accounts where organization_id = '${orgId}' and standard_category = 'revenue' and is_system`);
  const documentId = one(`
    insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${orgId}', '${orgId}/answer/gl.csv', 'gl.csv', 'text/csv', 10, decode('e9','hex'), 'ready', 'general_ledger') returning id`);
  const batchId = one(`
    insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at)
    values ('${orgId}', '${documentId}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '2026-05-01', '2026-05-31', now()) returning id`);
  const rowId = one(`
    insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
    values ('${orgId}', '${batchId}', 2, 'csv:row:2', '{}'::jsonb, '{}'::jsonb, 'committed') returning id`);
  const entryId = one(`
    insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status, source_document_id, import_batch_id, import_row_id, source_ref)
    values ('${orgId}', '2026-05-10', '${revenueAccount}', 'credit', 20000.00, '00000000-0000-0000-0000-000000000000', 'accepted', '${documentId}', '${batchId}', '${rowId}', 'csv:row:2') returning id`);
  adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id) values ('${orgId}', 'ledger_entries', '${entryId}', 'accepted', '${batchId}')`);

  const jobId = adminSql(`
    insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${orgId}', 'calculation.run', '{"trigger":"recalc_manual","as_of":"2026-06-15"}'::jsonb, 3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
  revenueSnapshot = one(`
    select c.snapshot_id::text from public.metric_current c
     where c.organization_id = '${orgId}' and c.period_id = '${mayPeriodId}' and c.metric_key = 'revenue' and c.dimension_type = 'none'`);
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Answer%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Answer %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.answer.itest' and created_at < now() - interval '1 hour';`);
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
    const diagnostics = () => adminSql(`
      select 'report=' || coalesce(m.grounding_report::text, '-') || ' || tool=' || coalesce(
        (select t.tool_name || ' ok=' || (t.error is null) || ' err=' || coalesce(t.error, '-') || ' summary=' || coalesce(t.output_summary::text, '-')
           from public.ai_tool_calls t where t.message_id = m.id limit 1), '-')
        from public.ai_messages m where m.id = '${out.messageId}'`);
    expect(out.groundingStatus, diagnostics()).toBe('passed');
    expect(statuses).toEqual(['get_metric']);
    expect(out.toolCalls).toBe(1);
    expect(out.evidenceBundleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.answer?.direct_answer.statement).toContain(revenueDisplay);
    expect(revenueDisplay).toMatch(/^£/);

    // Persisted by the server: the assistant row, the tool call, the bundle citing the snapshot.
    const row = adminSql(`select grounding_status || '|' || input_tokens || '|' || output_tokens from public.ai_messages where id = '${out.messageId}'`);
    expect(row).toBe('passed|300|100');
    expect(adminSql(`select count(*) from public.ai_tool_calls where message_id = '${out.messageId}' and authorized`)).toBe('1');
    expect(adminSql(`select ref_id::text from public.evidence_items where bundle_id = '${out.evidenceBundleId}' and item_type = 'metric_snapshot'`)).toBe(revenueSnapshot);
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
    expect(adminSql(`select coalesce(content, 'NULL') from public.ai_messages where id = '${out.messageId}'`)).toBe('NULL');
    expect(adminSql(`select structured_response::text from public.ai_messages where id = '${out.messageId}'`)).not.toContain('999,999');
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
    expect(out.answer?.unsupported.some((u) => /marketing/i.test(u.topic))).toBe(true);
    // The recommendation rested on a removed statement's evidence alone... but its refs cite the
    // revenue snapshot, which no surviving statement cites either — so it goes.
    expect(out.answer?.recommended_actions).toEqual([]);
    // The removed text lives only in the report.
    const report = adminSql(`select grounding_report::text from public.ai_messages where id = '${out.messageId}'`);
    expect(report).toContain('9,999');
    expect(adminSql(`select structured_response::text from public.ai_messages where id = '${out.messageId}'`)).not.toContain('9,999');
  });
});

describe('failure is honest (§7.8, §10.2)', () => {
  it('a model error after the retry is stored as failed with no bundle', async () => {
    const transport: ModelTransport = async () => { throw new Error('ECONNRESET'); };
    const { out } = await turn(transport);
    expect(out.groundingStatus).toBe('failed');
    expect(out.answer).toBeNull();
    expect(out.evidenceBundleId).toBeNull();
    expect(adminSql(`select grounding_report ->> 'reason' from public.ai_messages where id = '${out.messageId}'`)).toMatch(/model_error|upstream/);
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
    expect(adminSql(`select grounding_report ->> 'reason' from public.ai_messages where id = '${out.messageId}'`)).toBe('inadmissible_after_retry');
  });

  it('the quota is charged before any model call, and an exhausted organisation never reaches the model', async () => {
    adminSql(`insert into public.platform_org_settings (organization_id, ai_quota_daily) values ('${orgId}', 0) on conflict (organization_id) do update set ai_quota_daily = 0`);
    let modelCalled = false;
    const transport: ModelTransport = async () => { modelCalled = true; throw new Error('should not be called'); };
    await expect(turn(transport)).rejects.toBeInstanceOf(QuotaExceeded);
    expect(modelCalled).toBe(false);
    adminSql(`delete from public.platform_org_settings where organization_id = '${orgId}'`);
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
