import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { isMotionError } from '@/core/errors';
import { beginPortfolioTurn } from '@/core/db/server-rpc';
import { canReadPortfolioTurn } from '@/db/rls';
import { globalRow, newId, nowIso, orgRow } from '@/db/schema';
import type { ModelCall, ModelResponse, ModelTransport } from '@/modules/ai';
import { BRIEFING_TOOL, askAdviser, listAdviserTurns, resolvePortfolioContext, type PortfolioContext } from '@/modules/portfolio';
import { addMember, addPlatformUser, assign, dropUsers, dropWhere, makeOrg, periodOf } from './ai-fixtures';
import { clientFor, createAuthUser, deleteOrg, fs, rpc } from './setup';

/**
 * The adviser analyst's boundary (ADR-113; brief §13, §19, §20).
 *
 * The model is a fake here, and a recording one: what matters is what it is HANDED (only the
 * caller's organisations), what the database ACCEPTS as a scope (only organisations the actor
 * advises), and what the server KEEPS of an answer (only references the digest issued and numbers
 * the digest states). A model that names an unassigned client, cites a foreign alert or invents a
 * figure is corrected or refused by the server, not by the prompt.
 *
 * The adviser analyst is part of the Command Centre, and so APX staff only (owner, 2026-10-14;
 * ADR-112 addendum): a company's owner, admin or client has no analyst — the resolver's 404, and the
 * database refuses to open a turn for them even over their own organisation (20261018000030).
 */

const RUN = `pa${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.portfolioai.itest.motion`;

let employee: string; let ownerC: string; let adminA: string; let clientOnly: string;
let A: string; let B: string; let C: string;
let alertA: string; let alertC: string;

async function createOrg(who: string, name: string): Promise<string> {
  return makeOrg(who, name);
}
async function seedAlert(org: string, severity: string, title: string): Promise<string> {
  const p = periodOf(org, '2026-07-01');
  const run = newId();
  const id = newId();
  const now = nowIso();
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
  await orgRow(fs(), org, 'calculation_runs', run).set({
    id: run, organization_id: org, job_id: null, trigger: 'recalc_manual', trigger_ref_id: null, engine_version: '1.0.0',
    period_from: p, period_to: p, as_of: '2026-09-15', as_of_ts: now, status: 'succeeded', failure_reason: null,
    stale: false, input_fingerprint: null, chunks: [], progress: {}, started_at: now, finished_at: now,
    duration_ms: 1, error: null, stats: {}, created_at: now, updated_at: now,
  });
  await orgRow(fs(), org, 'alerts', id).set({
    id, organization_id: org, rule_key: 'cash.decline', rule_version: '1', severity, metric_key: null, period_id: p,
    subject_type: 'none', subject_id: null, title, explanation: 'seeded', threshold_summary: {},
    recommended_next_step: null, current_revision_id: null, status: 'open', status_changed_by: null,
    status_changed_at: null, status_reason_code: 'user', status_reason: null, action_id: null,
    dedupe_key: `${RUN}-${title}`, key_kind: 'state', calculation_run_id: run, first_seen_at: twoDaysAgo,
    reopened_at: null, dismissed_at: null, last_evaluated_at: now, created_at: twoDaysAgo, updated_at: now,
  });
  return id;
}

/** A stored turn as its reader would get it by id: the doc, under `portfolio_ai_turns_select`. */
async function readById(user: string, turnId: string): Promise<Array<Record<string, unknown>>> {
  const snap = await globalRow(fs(), 'portfolio_ai_turns', turnId).get();
  if (!snap.exists) return [];
  const turn = snap.data() as { user_id: string; scope_organization_ids: string[] };
  return (await canReadPortfolioTurn(clientFor(user, { email: `${user}@${DOMAIN}` }), turn)) ? [snap.data()!] : [];
}
const stored = async (turnId: string) => (await globalRow(fs(), 'portfolio_ai_turns', turnId).get()).data()!;
const storedAnswer = async (turnId: string) => JSON.stringify((await stored(turnId)).answer ?? null);
const turnsOf = async (user: string) => (await fs().collection('portfolio_ai_turns').where('user_id', '==', user).get()).size;

const ctxFor = async (user: string): Promise<PortfolioContext> => {
  const db = clientFor(user, { email: `${user}@${DOMAIN}` });
  const ctx = await resolvePortfolioContext(db, user, `itest-${RUN}`);
  return { ...ctx, now: () => new Date('2026-09-15T12:00:00Z') };
};

/**
 * The v4 submission (ADR-118) from a compact one. The model's contract is blocks of references;
 * a string headline, client `summary` or note stands for what a misbehaving model might send in
 * their place — its own words — and becomes ONE text block, which the server never renders.
 */
type Block = Record<string, unknown> & { kind: string };
function v4(reply: unknown): unknown {
  if (reply === null || typeof reply !== 'object' || !('mode' in reply)) return reply;
  const r = reply as { mode: string; headline: string | Block[]; clients: Array<{ ref: string; summary?: string; blocks?: Block[]; because: string[] }>; notes: Array<string | Block[]>; limitations: string[] };
  const words = (t: string): Block[] => [{ kind: 'text', text: t }];
  return {
    mode: r.mode,
    headline: typeof r.headline === 'string' ? words(r.headline) : r.headline,
    clients: r.clients.map((c) => ({ ref: c.ref, blocks: c.blocks ?? words(c.summary ?? ''), because: c.because })),
    notes: r.notes.map((n) => ({ blocks: typeof n === 'string' ? words(n) : n })),
    limitations: r.limitations,
  };
}

/** MOTION's own attention reason for Alpha's critical alert, as a block. */
const ALPHA_CRITICAL = { kind: 'attention', reasons: ['client:1/attention/critical_alert'] };

/** A model that answers with whatever the test hands it, and records the call it was given. */
function fakeModel(reply: (call: ModelCall) => unknown): { transport: ModelTransport; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const transport: ModelTransport = async (call) => {
    calls.push(call);
    return {
      content: [{ type: 'tool_use', id: 'tu_1', name: BRIEFING_TOOL, input: v4(reply(call)) }] as unknown as ModelResponse['content'],
      stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 50 }, model: 'fake-model',
    };
  };
  return { transport, calls };
}

const handed = (call: ModelCall) => call.system.map((s) => s.text).join('\n');

beforeAll(async () => {
  employee = await createAuthUser(`employee@${DOMAIN}`);
  ownerC = await createAuthUser(`owner-c@${DOMAIN}`);
  adminA = await createAuthUser(`admin-a@${DOMAIN}`);
  clientOnly = await createAuthUser(`client-only@${DOMAIN}`);
  await addPlatformUser(employee, 'employee');
  A = await createOrg(ownerC, `PA Alpha ${RUN}`);
  B = await createOrg(ownerC, `PA Beta ${RUN}`);
  C = await createOrg(ownerC, `PA Gamma Secret ${RUN}`);
  await assign(A, employee); await assign(B, employee);
  await addMember(A, clientOnly, 'client'); await addMember(A, adminA, 'admin');
  alertA = await seedAlert(A, 'critical', 'Alpha cash runway is short');
  alertC = await seedAlert(C, 'critical', 'Gamma secret alert');
}, 120_000);

afterAll(async () => {
  for (const org of [A, B, C]) if (org) await deleteOrg(org);
  const users = (await fs().collection('profiles').where('email', '>=', '').get()).docs
    .filter((d) => String(d.get('email')).endsWith(`@${DOMAIN}`)).map((d) => d.id);
  await dropWhere('portfolio_ai_turns', 'user_id', users);
  await dropUsers(DOMAIN);
});

describe('what the model is handed', () => {
  it('an employee with two assigned clients: the digest names those two and nothing of the third', async () => {
    const model = fakeModel(() => ({ mode: 'answer', headline: [{ kind: 'facts', facts: ['portfolio/needing_attention'] }], clients: [{ ref: 'client:1', blocks: [ALPHA_CRITICAL], because: ['alert:1'] }], notes: [], limitations: [] }));
    const ctx = await ctxFor(employee);
    const result = await askAdviser(ctx, 'Which clients need attention?', { transport: model.transport });
    expect(model.calls).toHaveLength(1);
    const text = handed(model.calls[0]!);
    expect(text).toContain(`PA Alpha ${RUN}`);
    expect(text).toContain(`PA Beta ${RUN}`);
    expect(text).not.toContain('Gamma');
    expect(text).not.toContain(C);
    expect(text).not.toContain(alertC);
    expect(result.status).toBe('passed');
    expect(result.digest.clients.map((c) => c.id).sort()).toEqual([A, B].sort());
    // Recorded with the scope the resolver gave, and readable by its owner only.
    const turns = await listAdviserTurns(ctx);
    expect(turns[0]).toMatchObject({ question: 'Which clients need attention?', status: 'answered', groundingStatus: 'passed' });
    const scope = (await stored(result.turnId)).scope_organization_ids as string[];
    expect(scope).toContain(A); expect(scope).toContain(B); expect(scope).not.toContain(C);
  });

  it('the employee asks about the unassigned client: the model never saw it, and cannot introduce it', async () => {
    // The model "answers" about a client:3 that does not exist in the digest and cites the secret alert by a made-up ref.
    const model = fakeModel(() => ({
      mode: 'answer', headline: 'One client is in trouble.',
      clients: [{ ref: 'client:3', summary: 'Gamma secret alert stands.', because: ['alert:2'] }, { ref: 'client:1', summary: 'Alpha has a critical alert.', because: ['alert:1'] }],
      notes: [], limitations: [],
    }));
    const ctx = await ctxFor(employee);
    const result = await askAdviser(ctx, `Tell me about PA Gamma Secret ${RUN}`, { transport: model.transport });
    expect(handed(model.calls[0]!)).not.toContain('Gamma');
    expect(result.status).toBe('degraded');
    expect(result.briefing!.clients.map((c) => c.ref)).toEqual(['client:1']);
    // Nothing of Gamma's survives: not its client entry, not its alert, not its id.
    const answer = await storedAnswer(result.turnId);
    expect(answer).not.toContain('Gamma');
    expect(answer).not.toContain(alertC);
    expect(answer).not.toContain(C);
  });

  it('a client-only member has no adviser analyst at all', async () => {
    await expect(ctxFor(clientOnly)).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'NOT_FOUND');
  });

  it('nor has a company owner or admin — not even over their own organisations (owner, 2026-10-14)', async () => {
    // ownerC owns A, B and C; adminA administers A. Neither is APX staff.
    await expect(ctxFor(ownerC)).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'NOT_FOUND');
    await expect(ctxFor(adminA)).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'NOT_FOUND');
  });
});

describe('what the database accepts as a scope', () => {
  it('refuses a scope with an organisation the actor does not advise, before any row exists', async () => {
    const before = await turnsOf(employee);
    await expect(beginPortfolioTurn({ userId: employee, requestId: 'x' }, {
      question: 'q', scopeOrganizationIds: [A, C], promptVersion: 'adviser-v1.0',
    })).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'PERMISSION_DENIED');
    expect(await turnsOf(employee)).toBe(before);
    // And a client membership is not an adviser role.
    await expect(beginPortfolioTurn({ userId: clientOnly, requestId: 'x' }, {
      question: 'q', scopeOrganizationIds: [A], promptVersion: 'adviser-v1.0',
    })).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'PERMISSION_DENIED');
  });

  it('refuses a company owner and a company admin over their OWN organisations — staff only (20261018000030)', async () => {
    for (const [user, scope] of [[ownerC, [A, B, C]], [ownerC, [A]], [adminA, [A]]] as const) {
      const before = await turnsOf(user);
      await expect(beginPortfolioTurn({ userId: user, requestId: 'x' }, {
        question: 'q', scopeOrganizationIds: [...scope], promptVersion: 'adviser-v1.0',
      })).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'PERMISSION_DENIED');
      expect(await turnsOf(user)).toBe(before);
    }
  });

  it('a turn a company owner stored before the change is no longer readable to them (the read policy reads current adviser access)', async () => {
    // Written as the server would have written it when owners still had a Command Centre.
    const turn = newId();
    await globalRow(fs(), 'portfolio_ai_turns', turn).set({
      id: turn, user_id: ownerC, question: 'Before the change', scope_organization_ids: [A], status: 'pending',
      answer: null, grounding_status: null, model: null, prompt_version: 'adviser-v1.0', input_tokens: null,
      output_tokens: null, created_at: nowIso(), finished_at: null,
    });
    try {
      expect(await readById(ownerC, turn)).toEqual([]);
    } finally {
      await globalRow(fs(), 'portfolio_ai_turns', turn).delete();
    }
  });

  it('a user handle cannot call the server functions', async () => {
    const db = clientFor(employee, { email: `${employee}@${DOMAIN}` });
    const begin = await rpc(db, 'portfolio_ai_begin_turn', { p_actor: employee, p_question: 'q', p_scope: [A], p_prompt_version: 'x' }, { server: true });
    expect(begin.error, 'api_server refused to a user').toMatchObject({ code: 'PERMISSION_DENIED' });
    const finish = await rpc(db, 'portfolio_ai_finish_turn', { p_actor: employee, p_turn: newId(), p_answer: null, p_grounding: 'failed' }, { server: true });
    expect(finish.error).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('another user cannot read the employee\'s turns', async () => {
    const turns = await fs().collection('portfolio_ai_turns').where('user_id', '==', employee).get();
    expect(turns.size).toBeGreaterThan(0);
    for (const t of turns.docs) expect(await readById(ownerC, t.id)).toEqual([]);
  });
});

describe('what the server keeps of an answer', () => {
  it('drops a citation of another client\'s alert and a number the digest does not state', async () => {
    const model = fakeModel(() => ({
      mode: 'answer', headline: 'Two clients; one needs attention.',
      clients: [
        { ref: 'client:1', summary: 'Revenue fell 23% and the runway is 1.5 months.', because: ['alert:1'] },
        { ref: 'client:2', summary: 'Nothing stands.', because: ['alert:1'] },
      ],
      notes: ['Portfolio cash is £412,000.'], limitations: [],
    }));
    const ctx = await ctxFor(employee);
    const result = await askAdviser(ctx, 'Summarise', { transport: model.transport });
    expect(result.status).toBe('degraded');
    const [alpha, beta] = result.briefing!.clients;
    expect(alpha!.summary).not.toContain('23%');
    expect(alpha!.summary).toContain('critical alert');
    expect(beta!.because).toEqual([]);
    expect(result.briefing!.notes).toEqual([]);
    const answer = await storedAnswer(result.turnId);
    // Ids are random and can contain "412" by chance (seen in a local run); the fabricated number
    // must be absent from everything else the answer stores.
    const withoutIds = answer.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');
    expect(withoutIds).not.toContain('412');
    expect(answer).not.toContain('23%');
  });

  it('M-1: a figure written in words is removed, and the turn is stored degraded — never "Grounded"', async () => {
    // The independent audit's P7: this sentence was persisted with grounding_status = passed and
    // rendered under the Grounded badge. The badge is read from grounding_status (analyst/page.tsx).
    const model = fakeModel(() => ({
      mode: 'answer', headline: 'Alpha needs attention.',
      clients: [{ ref: 'client:1', summary: 'Revenue fell by twenty per cent and cash runway is one and a half months. Costs doubled.', because: ['alert:1'] }],
      notes: ['Margin halved across the portfolio.'], limitations: [],
    }));
    const ctx = await ctxFor(employee);
    const result = await askAdviser(ctx, 'What changed?', { transport: model.transport });
    expect(result.status).toBe('degraded');
    const row = await stored(result.turnId);
    const both = `${String(row.grounding_status)}|${JSON.stringify(row.answer)}`;
    expect(both.startsWith('degraded|')).toBe(true);
    for (const words of ['twenty per cent', 'one and a half', 'doubled', 'halved']) expect(both).not.toContain(words);
    const turns = await listAdviserTurns(ctx);
    expect(turns.find((t) => t.id === result.turnId)?.groundingStatus).toBe('degraded');
  });

  it('ADR-118: the model chooses references; the server writes every sentence, stores it, and the answer is Grounded', async () => {
    const model = fakeModel(() => ({
      mode: 'answer',
      headline: [{ kind: 'facts', facts: ['portfolio/needing_attention'] }, { kind: 'phrase', phrase: 'look_first', ref: 'client:1' }],
      clients: [{
        ref: 'client:1',
        blocks: [
          { kind: 'facts', facts: ['client:1/critical_alerts', 'client:1/open_actions'] },
          ALPHA_CRITICAL,
          { kind: 'source', ref: 'alert:1' },
          { kind: 'phrase', phrase: 'health_unavailable' },
        ],
        because: [],
      }],
      notes: [], limitations: ['figures_elsewhere'],
    }));
    const ctx = await ctxFor(employee);
    const result = await askAdviser(ctx, 'Where first?', { transport: model.transport });
    expect(result.status).toBe('passed');
    const alpha = result.briefing!.clients[0]!;
    expect(alpha.summary).toBe(
      `PA Alpha ${RUN} has 1 standing critical alert and 0 open actions. PA Alpha ${RUN}: 1 critical alert. `
      + `PA Alpha ${RUN}: alert “Alpha cash runway is short” (critical, open). PA Alpha ${RUN} has not been scored yet, so its health is not available.`,
    );
    expect(alpha.because).toEqual(['alert:1']);
    expect(result.briefing!.headline.text).toBe(`1 client needs attention. Look at PA Alpha ${RUN} first.`);
    // What the model was shown: each fact as the sentence the server writes, and the phrase library.
    const shown = handed(model.calls[0]!);
    expect(shown).toContain(`PA Alpha ${RUN} has 1 standing critical alert.`);
    expect(shown).toContain('Look at {client} first.');
    // Stored as rendered, passed; the page shows the stored status (journey 15).
    const row = await stored(result.turnId);
    const both = `${String(row.grounding_status)}|${JSON.stringify(row.answer)}`;
    expect(both.startsWith('passed|')).toBe(true);
    expect((await listAdviserTurns(ctx)).find((t) => t.id === result.turnId)?.groundingStatus).toBe('passed');
  });

  it('brief §22: fabricated text and values beside a correct fact are discarded, and the turn is not Grounded', async () => {
    const model = fakeModel(() => ({
      mode: 'answer', headline: [{ kind: 'facts', facts: ['portfolio/needing_attention'] }],
      clients: [{ ref: 'client:1', blocks: [
        { kind: 'facts', facts: ['client:1/critical_alerts'], text: 'Alpha has 40 critical alerts', value: 40 },
        { kind: 'text', text: 'They have been resolved.' },
        { kind: 'facts', facts: ['client:2/open_actions'] },
      ], because: [] }],
      notes: ['Twelve clients need attention.', [{ kind: 'phrase', phrase: 'portfolio_clear' }]], limitations: [],
    }));
    const result = await askAdviser(await ctxFor(employee), 'Summarise', { transport: model.transport });
    expect(result.status).toBe('degraded');
    expect(result.briefing!.clients[0]!.summary).toBe(`PA Alpha ${RUN} has 1 standing critical alert.`);
    expect(result.briefing!.notes).toEqual([]);
    const row = await stored(result.turnId);
    const both = `${String(row.grounding_status)}|${JSON.stringify(row.answer)}`;
    expect(both.startsWith('degraded|')).toBe(true);
    // Word-bounded: the stored JSON carries random UUIDs, which may contain "40" (…-400b-…).
    for (const words of [/\b40\b/, /resolved/, /Twelve/, /Nothing in the portfolio/]) expect(both).not.toMatch(words);
  });

  it('L-2: a cited title that is a number does not launder a figure', async () => {
    const titled = await seedAlert(A, 'high', '3');
    try {
      const model = fakeModel((call) => {
        // Every digest string arrives wrapped as <data name="…">…</data> (untrustedJson).
        const ref = /(alert:\d+)<\/data>[^{}]*?title[^{}]*?>3<\/data>/.exec(handed(call))?.[1];
        if (ref === undefined) throw new Error('the seeded title is not in the digest');
        return { mode: 'answer', headline: 'Alpha needs attention.', clients: [{ ref: 'client:1', summary: 'Revenue fell 3% this quarter.', because: [ref] }], notes: [], limitations: [] };
      });
      const result = await askAdviser(await ctxFor(employee), 'Revenue?', { transport: model.transport });
      expect(result.status).toBe('degraded');
      expect(await storedAnswer(result.turnId)).not.toContain('3%');
    } finally {
      await orgRow(fs(), A, 'alerts', titled).delete();
    }
  });

  it('a refusal carries no clients and is not_applicable', async () => {
    const model = fakeModel(() => ({ mode: 'refusal', headline: [{ kind: 'phrase', phrase: 'outside_scope' }], clients: [], notes: [], limitations: [] }));
    const result = await askAdviser(await ctxFor(employee), 'Write me a poem', { transport: model.transport });
    expect(result.status).toBe('not_applicable');
    expect(result.briefing!.headline.text).toBe('That is outside what the Command Centre can answer.');
    expect(result.briefing!.clients).toEqual([]);
  });

  it('a malformed submission is recorded as failed, never rendered', async () => {
    const model = fakeModel(() => ({ nonsense: true }));
    const ctx = await ctxFor(employee);
    const result = await askAdviser(ctx, 'Anything', { transport: model.transport });
    expect(result.status).toBe('failed');
    expect(result.briefing).toBeNull();
    const row = await stored(result.turnId);
    expect(`${String(row.status)}|${row.answer === null ? 'NULL' : JSON.stringify(row.answer)}`).toBe('failed|NULL');
  });

  it('cites only the digest\'s own references, resolved to real alert ids', async () => {
    const model = fakeModel(() => ({ mode: 'answer', headline: [{ kind: 'phrase', phrase: 'look_first', ref: 'client:1' }], clients: [{ ref: 'client:1', blocks: [ALPHA_CRITICAL], because: ['alert:1'] }], notes: [], limitations: ['figures_elsewhere'] }));
    const ctx = await ctxFor(employee);
    const result = await askAdviser(ctx, 'Where first?', { transport: model.transport });
    const turn = (await listAdviserTurns(ctx))[0]!;
    expect(result.status).toBe('passed');
    expect(turn.answer!.refs).toEqual([{ ref: 'alert:1', kind: 'alert', id: alertA, organizationId: A, title: 'Alpha cash runway is short' }]);
  });
});

describe('HIGH-C — a stored turn is readable only while its author CURRENTLY advises its whole scope', () => {
  let adviser: string; let clientOfA: string;
  const answer = () => ({ mode: 'answer', headline: [{ kind: 'phrase', phrase: 'look_first', ref: 'client:1' }], clients: [{ ref: 'client:1', blocks: [ALPHA_CRITICAL], because: ['alert:1'] }], notes: [], limitations: [] });
  const assign2 = (org: string, status: 'active' | 'revoked') => assign(org, adviser, status);

  beforeAll(async () => {
    adviser = await createAuthUser(`adviser2@${DOMAIN}`);
    clientOfA = await createAuthUser(`client-of-a@${DOMAIN}`);
    await addPlatformUser(adviser, 'employee');
    await addMember(A, clientOfA, 'client');
  });

  it('A–C: readable while assigned; gone on the next request after revocation; back on reassignment', async () => {
    await assign2(A, 'active'); await assign2(B, 'revoked');
    const ctx = await ctxFor(adviser);
    expect(ctx.organisationIds).toEqual([A]);
    const turn = await askAdviser(ctx, 'Where first?', { transport: fakeModel(answer).transport });
    expect(await readById(adviser, turn.turnId)).toHaveLength(1);
    expect((await listAdviserTurns(ctx)).map((t) => t.id)).toContain(turn.turnId);

    await assign2(A, 'revoked');
    // G: the read policy itself, for the adviser, returns nothing — and so does the service.
    expect(await readById(adviser, turn.turnId)).toEqual([]);
    expect((await listAdviserTurns({ ...ctx, organisations: [], organisationIds: [] })).map((t) => t.id)).not.toContain(turn.turnId);

    await assign2(A, 'active');
    expect(await readById(adviser, turn.turnId)).toHaveLength(1);
  });

  it('D: a turn over two organisations is unreadable once either leaves the author\'s scope', async () => {
    await assign2(A, 'active'); await assign2(B, 'active');
    const ctx = await ctxFor(adviser);
    expect([...ctx.organisationIds].sort()).toEqual([A, B].sort());
    const turn = await askAdviser(ctx, 'Both?', { transport: fakeModel(answer).transport });
    expect(await readById(adviser, turn.turnId)).toHaveLength(1);
    await assign2(B, 'revoked');
    expect(await readById(adviser, turn.turnId)).toEqual([]);
    await assign2(B, 'active');
    expect(await readById(adviser, turn.turnId)).toHaveLength(1);
  });

  it('E–F: a client of the organisation, its owner, and another adviser of the same organisations, cannot read it by id', async () => {
    await assign2(A, 'active'); await assign2(B, 'revoked');
    const turn = await askAdviser(await ctxFor(adviser), 'Mine?', { transport: fakeModel(answer).transport });
    expect(await readById(clientOfA, turn.turnId)).toEqual([]);
    // ownerC owns A, B and C — a company login, which advises nothing (owner, 2026-10-14).
    expect(await readById(ownerC, turn.turnId)).toEqual([]);
    // `employee` is assigned A and B — a current adviser of the scope, but not the author.
    expect((await ctxFor(employee)).organisationIds).toContain(A);
    expect(await readById(employee, turn.turnId)).toEqual([]);
  });
});
