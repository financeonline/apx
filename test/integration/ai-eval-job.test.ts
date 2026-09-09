import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { enqueueServerJob } from '@/core/db';
import { drainJobs, evalDeps } from '@/modules/jobs';
import { LIVE_QUESTIONS, REFUSAL_TEMPLATES, SUBMIT_ANSWER_TOOL, type ModelCall, type ModelResponse, type ModelTransport } from '@/modules/ai';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * The `ai.eval` job (AI_ARCHITECTURE.md §12; ADR-081): the live run, driven end to end through the
 * queue against a real computed organisation, with the model replaced by a script that reads the
 * question and answers it the way a correct model would — a tool call for the resolved month, then
 * a grounded submission quoting the tool — or refuses with the fixed template.
 */

const RUN = `ej${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.evaljob.itest`;

let ownerId: string;
let orgId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

/** A model that reads the conversation and behaves: refuses what it must, grounds what it can. */
function scriptedModel(): ModelTransport {
  const used = new Map<string, number>();
  return async (call: ModelCall): Promise<ModelResponse> => {
    const text = (blocks: unknown): string => JSON.stringify(blocks);
    const question = text(call.messages.find((m) => m.role === 'user')?.content ?? '').toLowerCase();
    const submit = (input: unknown): ModelResponse => ({
      content: [{ type: 'tool_use', id: `tu-${Math.random().toString(36).slice(2, 8)}`, name: SUBMIT_ANSWER_TOOL, input, caller: { type: 'direct' } } as ModelResponse['content'][number]],
      stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 40 }, model: 'scripted',
    });
    const refusal = (opening: string) => submit({
      mode: 'refusal',
      direct_answer: { statement: `${opening} See your Home page.`, kind: 'inference', period: null, evidence_refs: [], numbers: [], entity_refs: [] },
      key_findings: [], causes: [], risks: [], opportunities: [], recommended_actions: [],
      confidence: { data_quality_notes: [] }, evidence: [], unsupported: [],
    });
    if (question.includes('afford')) return refusal(REFUSAL_TEMPLATES.affordability);
    if (question.includes('what happens if')) return refusal(REFUSAL_TEMPLATES.scenario);
    if (question.includes('lasagne')) return refusal(REFUSAL_TEMPLATES.off_topic);

    const key = question;
    const turn = (used.get(key) ?? 0) + 1;
    used.set(key, turn);
    if (turn === 1) {
      // The month the server resolved is in the tenant section of the system prompt.
      const system = call.system.map((s) => s.text).join('\n');
      const label = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b/.exec(system)?.[0] ?? 'May 2026';
      return {
        content: [{ type: 'tool_use', id: 'tu-1', name: 'get_metric', input: { metric_key: 'revenue', period: label }, caller: { type: 'direct' } } as ModelResponse['content'][number]],
        stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 20 }, model: 'scripted',
      };
    }
    const last = call.messages[call.messages.length - 1]!;
    const blocks = last.content as Array<{ type: string; content?: string }>;
    const reply = blocks.find((b) => b.type === 'tool_result')?.content ?? '';
    const display = /"display":"(£[\d,]+)"/.exec(reply)?.[1] ?? '';
    const snapshot = /"snapshot_id":"([0-9a-f-]{36})"/.exec(reply)?.[1] ?? '';
    const period = /"period":\{"id":"[0-9a-f-]{36}","label":"([^"]+)"/.exec(reply)?.[1] ?? 'May 2026';
    const statement = {
      statement: `Sales were ${display} in ${period}.`, kind: 'deterministic_calculation', period,
      evidence_refs: [{ type: 'metric_snapshot', id: snapshot }],
      numbers: [{ text: display, tool_call_seq: 1, path: 'value', metric_key: 'revenue', entity_id: null }],
      entity_refs: [],
    };
    return submit({
      mode: 'answer', direct_answer: statement, key_findings: [statement], causes: [], risks: [], opportunities: [], recommended_actions: [],
      confidence: { data_quality_notes: [] }, evidence: statement.evidence_refs, unsupported: [],
    });
  };
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest EvalJob ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  const revenueAccount = one(`select id from public.accounts where organization_id = '${orgId}' and standard_category = 'revenue' and is_system`);
  const documentId = one(`
    insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${orgId}', '${orgId}/evaljob/gl.csv', 'gl.csv', 'text/csv', 10, decode('ea','hex'), 'ready', 'general_ledger') returning id`);
  const batchId = one(`
    insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at)
    values ('${orgId}', '${documentId}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '2026-05-01', '2026-05-31', now()) returning id`);
  const rowId = one(`
    insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
    values ('${orgId}', '${batchId}', 2, 'csv:row:2', '{}'::jsonb, '{}'::jsonb, 'committed') returning id`);
  const entryId = one(`
    insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status, source_document_id, import_batch_id, import_row_id, source_ref)
    values ('${orgId}', '2026-05-31', '${revenueAccount}', 'credit', 20000.00, '00000000-0000-0000-0000-000000000000', 'accepted', '${documentId}', '${batchId}', '${rowId}', 'csv:row:2') returning id`);
  adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id) values ('${orgId}', 'ledger_entries', '${entryId}', 'accepted', '${batchId}')`);
  const jobId = adminSql(`
    insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${orgId}', 'calculation.run', '{"trigger":"recalc_manual","as_of":"2026-06-15"}'::jsonb, 3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
});

afterAll(() => {
  evalDeps.transport = undefined;
  adminSql(`
    delete from public.organizations where name like 'ITest EvalJob%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest EvalJob %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.evaljob.itest' and created_at < now() - interval '1 hour';`);
});

describe('the ai.eval job', () => {
  // Thirteen questions as one person: the runner waits out the product's 10/min throttle once.
  it('asks every live question as the requester, under the user throttle, and records the metrics on the job', { timeout: 180_000 }, async () => {
    evalDeps.transport = scriptedModel();
    const jobId = await enqueueServerJob({ userId: ownerId, requestId: `itest-${RUN}` }, { organizationId: orgId, jobType: 'ai.eval' });
    const row = () => adminSql(`select status || '|' || attempts || '/' || max_attempts || '|' || coalesce(last_error, '-') || ' cases=' || coalesce((select jsonb_agg(c) filter (where (c ->> 'ok') = 'false') from jsonb_array_elements(result -> 'cases') c)::text, '-') from public.jobs where id = '${jobId}'`);
    expect(await drainUntilFinished(drainJobs, jobId), row()).toBe('succeeded');

    const result = JSON.parse(adminSql(`select result::text from public.jobs where id = '${jobId}'`)) as {
      metrics: { cases: number; failures: number; groundingFirstPassRate: number; refusalCorrectness: number };
      cases: Array<{ id: string; ok: boolean; outcome: string }>;
      prompt_version: string; below_target: string[];
    };
    expect(result.cases).toHaveLength(LIVE_QUESTIONS.length);
    expect(result.metrics.failures, JSON.stringify(result.cases.filter((c) => !c.ok))).toBe(0);
    expect(result.metrics.groundingFirstPassRate).toBe(1);
    expect(result.metrics.refusalCorrectness).toBe(1);
    expect(result.below_target).toEqual([]);
    expect(result.prompt_version).toMatch(/^analyst-/);

    // Every question left a real, server-persisted turn behind it.
    expect(adminSql(`select count(*) from public.ai_messages where organization_id = '${orgId}' and role = 'assistant'`)).toBe(String(LIVE_QUESTIONS.length));
  });

  it('refuses to run with nobody to act as', async () => {
    const jobId = adminSql(`
      insert into public.jobs (organization_id, job_type, payload, max_attempts)
      values ('${orgId}', 'ai.eval', '{}'::jsonb, 1) returning id`).split('\n')[0]!.trim();
    expect(await drainUntilFinished(drainJobs, jobId)).not.toBe('succeeded');
    expect(adminSql(`select last_error from public.jobs where id = '${jobId}'`)).toMatch(/nobody did/);
  });
});
