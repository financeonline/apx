import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { enqueueServerJob } from '@/core/db';
import { drainJobs, evalDeps } from '@/modules/jobs';
import { LIVE_QUESTIONS, REFUSAL_TEMPLATES, SUBMIT_ANSWER_TOOL, type ModelCall, type ModelResponse, type ModelTransport } from '@/modules/ai';
import { globalRow, orgCollection } from '@/db/schema';
import { addCommittedBatch, dropUsers, dropWhere, enqueue, makeOrg, postLedger } from './ai-fixtures';
import { createAuthUser, deleteOrg, drainUntilFinished, fs } from './setup';

/**
 * The `ai.eval` job (AI_ARCHITECTURE.md §12; ADR-081): the live run, driven end to end through the
 * queue against a real computed organisation, with the model replaced by a script that reads the
 * question and answers it the way a correct model would — a tool call for the resolved month, then
 * a grounded submission quoting the tool — or refuses with the fixed template.
 */

const RUN = `ej${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.evaljob.itest.motion`;

let ownerId: string;
let orgId: string;

const job = async (id: string) => (await globalRow(fs(), 'jobs', id).get()).data() ?? {};

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
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest EvalJob ${RUN}`);

  const batch = await addCommittedBatch(orgId, {
    importType: 'general_ledger', targetTable: 'ledger_entries', periodStart: '2026-05-01', periodEnd: '2026-05-31',
    filename: 'gl.csv', documentKind: 'general_ledger',
  });
  await postLedger(orgId, batch, { category: 'revenue', direction: 'credit', amount: '20000.00', date: '2026-05-31', line: 2 });
  const jobId = await enqueue(orgId, 'calculation.run', { trigger: 'recalc_manual', as_of: '2026-06-15' });
  expect(await drainUntilFinished(drainJobs, jobId)).toBe('succeeded');
}, 120_000);

afterAll(async () => {
  evalDeps.transport = undefined;
  await deleteOrg(orgId);
  await dropWhere('jobs', 'organization_id', [orgId]);
  await dropUsers(DOMAIN);
});

describe('the ai.eval job', () => {
  // Thirteen questions as one person: the runner waits out the product's 10/min throttle once.
  it('asks every live question as the requester, under the user throttle, and records the metrics on the job', { timeout: 180_000 }, async () => {
    evalDeps.transport = scriptedModel();
    const jobId = await enqueueServerJob({ userId: ownerId, requestId: `itest-${RUN}` }, { organizationId: orgId, jobType: 'ai.eval' });
    const status = await drainUntilFinished(drainJobs, jobId);
    const row = await job(jobId);
    const failed = ((row.result as { cases?: Array<{ ok: boolean }> } | null)?.cases ?? []).filter((c) => !c.ok);
    expect(status, `${String(row.status)}|${String(row.attempts)}/${String(row.max_attempts)}|${String(row.last_error ?? '-')} cases=${JSON.stringify(failed)}`).toBe('succeeded');

    const result = row.result as {
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
    const assistant = await orgCollection(fs(), orgId, 'ai_messages').where('role', '==', 'assistant').get();
    expect(assistant.size).toBe(LIVE_QUESTIONS.length);
  });

  it('refuses to run with nobody to act as', async () => {
    const jobId = await enqueue(orgId, 'ai.eval', {}, 1, null);
    expect(await drainUntilFinished(drainJobs, jobId)).not.toBe('succeeded');
    expect(String((await job(jobId)).last_error)).toMatch(/nobody did/);
  });
});
