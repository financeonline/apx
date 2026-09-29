import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { isMotionError } from '@/core/errors';
import { beginPortfolioTurn } from '@/core/db/server-rpc';
import type { ModelCall, ModelResponse, ModelTransport } from '@/modules/ai';
import { BRIEFING_TOOL, askAdviser, listAdviserTurns, resolvePortfolioContext, type PortfolioContext } from '@/modules/portfolio';
import { adminSql, clientFor, createAuthUser, sqlstate } from './setup';

/**
 * The adviser analyst's boundary (ADR-113; brief §13, §19, §20).
 *
 * The model is a fake here, and a recording one: what matters is what it is HANDED (only the
 * caller's organisations), what the database ACCEPTS as a scope (only organisations the actor
 * advises), and what the server KEEPS of an answer (only references the digest issued and numbers
 * the digest states). A model that names an unassigned client, cites a foreign alert or invents a
 * figure is corrected or refused by the server, not by the prompt.
 */

const RUN = `pa${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.portfolioai.itest`;
const one = (s: string) => adminSql(`with q as (${s}) select * from q`).trim();

let employee: string; let ownerC: string; let clientOnly: string;
let A: string; let B: string; let C: string;
let alertA: string; let alertC: string;

async function createOrg(who: string, name: string): Promise<string> {
  const r = await clientFor(who).schema('api').rpc('create_organization', { p_name: name });
  if (r.error) throw new Error(r.error.message);
  return r.data as unknown as string;
}
const period = (org: string) => one(`select id from public.fiscal_periods where organization_id='${org}' and period_start='2026-07-01'`);
function seedAlert(org: string, severity: string, title: string): string {
  const p = period(org);
  const run = one(`insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
    values ('${org}','recalc_manual','1.0.0','${p}','${p}','2026-09-15','succeeded') returning id`);
  return one(`insert into public.alerts (organization_id, period_id, rule_key, rule_version, severity, key_kind, calculation_run_id, title, explanation, status, first_seen_at, dedupe_key)
    values ('${org}','${p}','cash.decline','1','${severity}','state','${run}','${title}','seeded','open',now() - interval '2 days','${RUN}-${title}') returning id`);
}

const ctxFor = async (user: string, aal: 'aal1' | 'aal2' = 'aal1'): Promise<PortfolioContext> => {
  const db = clientFor(user, { aal, email: `${user}@${DOMAIN}` });
  const ctx = await resolvePortfolioContext(db, user, `itest-${RUN}`);
  return { ...ctx, now: () => new Date('2026-09-15T12:00:00Z') };
};

/**
 * The v3 submission (ADR-116) from a compact one: a string headline, client summary or note is ONE
 * text statement — the model's own prose, which may carry nothing quantitative. A client may give
 * `statements` instead, to cite facts ({ kind: 'facts', facts: [ids] }), which the server renders.
 */
type Statement = { kind: 'text'; text: string } | { kind: 'facts'; facts: string[]; text?: string };
function v3(reply: unknown): unknown {
  if (reply === null || typeof reply !== 'object' || !('mode' in reply)) return reply;
  const r = reply as { headline: string | Statement[]; clients: Array<{ ref: string; summary?: string; statements?: Statement[]; because: string[] }>; notes: Array<string | Statement[]>; limitations: string[]; mode: string };
  const text = (t: string): Statement[] => [{ kind: 'text', text: t }];
  return {
    mode: r.mode,
    headline: typeof r.headline === 'string' ? text(r.headline) : r.headline,
    clients: r.clients.map((c) => ({ ref: c.ref, statements: c.statements ?? text(c.summary ?? ''), because: c.because })),
    notes: r.notes.map((n) => ({ statements: typeof n === 'string' ? text(n) : n })),
    limitations: r.limitations,
  };
}

/** A model that answers with whatever the test hands it, and records the call it was given. */
function fakeModel(reply: (call: ModelCall) => unknown): { transport: ModelTransport; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const transport: ModelTransport = async (call) => {
    calls.push(call);
    return {
      content: [{ type: 'tool_use', id: 'tu_1', name: BRIEFING_TOOL, input: v3(reply(call)) }] as unknown as ModelResponse['content'],
      stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 50 }, model: 'fake-model',
    };
  };
  return { transport, calls };
}

const handed = (call: ModelCall) => call.system.map((s) => s.text).join('\n');

beforeAll(async () => {
  employee = createAuthUser(`employee@${DOMAIN}`);
  ownerC = createAuthUser(`owner-c@${DOMAIN}`);
  clientOnly = createAuthUser(`client-only@${DOMAIN}`);
  adminSql(`insert into public.platform_users (user_id, platform_role) values ('${employee}','employee')`);
  // `app.org_role_of` (the api_server side) reads TOTP enrolment from the profile, not from the JWT.
  adminSql(`update public.profiles set mfa_enrolled_at = now() where id = '${employee}'`);
  A = await createOrg(ownerC, `PA Alpha ${RUN}`);
  B = await createOrg(ownerC, `PA Beta ${RUN}`);
  C = await createOrg(ownerC, `PA Gamma Secret ${RUN}`);
  adminSql(`insert into public.organization_assignments (organization_id, employee_user_id) values ('${A}','${employee}'), ('${B}','${employee}')`);
  adminSql(`insert into public.organization_memberships (organization_id, user_id, role, status) values ('${A}','${clientOnly}','client','active')`);
  alertA = seedAlert(A, 'critical', 'Alpha cash runway is short');
  alertC = seedAlert(C, 'critical', 'Gamma secret alert');
}, 120_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id in ('${A}','${B}','${C}');
            delete from public.platform_users where user_id in ('${employee}');
            delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('what the model is handed', () => {
  it('an employee with two assigned clients: the digest names those two and nothing of the third', async () => {
    const model = fakeModel(() => ({ mode: 'answer', headline: 'Alpha needs attention.', clients: [{ ref: 'client:1', summary: 'A critical alert stands.', because: ['alert:1'] }], notes: [], limitations: [] }));
    const ctx = await ctxFor(employee, 'aal2');
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
    const scope = adminSql(`select scope_organization_ids from public.portfolio_ai_turns where id='${result.turnId}'`).trim();
    expect(scope).toContain(A); expect(scope).toContain(B); expect(scope).not.toContain(C);
  });

  it('the employee asks about the unassigned client: the model never saw it, and cannot introduce it', async () => {
    // The model "answers" about a client:3 that does not exist in the digest and cites the secret alert by a made-up ref.
    const model = fakeModel(() => ({
      mode: 'answer', headline: 'One client is in trouble.',
      clients: [{ ref: 'client:3', summary: 'Gamma secret alert stands.', because: ['alert:2'] }, { ref: 'client:1', summary: 'Alpha has a critical alert.', because: ['alert:1'] }],
      notes: [], limitations: [],
    }));
    const ctx = await ctxFor(employee, 'aal2');
    const result = await askAdviser(ctx, `Tell me about PA Gamma Secret ${RUN}`, { transport: model.transport });
    expect(handed(model.calls[0]!)).not.toContain('Gamma');
    expect(result.status).toBe('degraded');
    expect(result.briefing!.clients.map((c) => c.ref)).toEqual(['client:1']);
    // Nothing of Gamma's survives: not its client entry, not its alert, not its id.
    const stored = adminSql(`select answer::text from public.portfolio_ai_turns where id='${result.turnId}'`);
    expect(stored).not.toContain('Gamma');
    expect(stored).not.toContain(alertC);
    expect(stored).not.toContain(C);
  });

  it('a client-only member has no adviser analyst at all', async () => {
    await expect(ctxFor(clientOnly)).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'NOT_FOUND');
  });
});

describe('what the database accepts as a scope', () => {
  it('refuses a scope with an organisation the actor does not advise, before any row exists', async () => {
    const before = adminSql(`select count(*) from public.portfolio_ai_turns where user_id='${employee}'`).trim();
    await expect(beginPortfolioTurn({ userId: employee, requestId: 'x' }, {
      question: 'q', scopeOrganizationIds: [A, C], promptVersion: 'adviser-v1.0',
    })).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'PERMISSION_DENIED');
    expect(adminSql(`select count(*) from public.portfolio_ai_turns where user_id='${employee}'`).trim()).toBe(before);
    // And a client membership is not an adviser role.
    await expect(beginPortfolioTurn({ userId: clientOnly, requestId: 'x' }, {
      question: 'q', scopeOrganizationIds: [A], promptVersion: 'adviser-v1.0',
    })).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'PERMISSION_DENIED');
  });

  it('a user JWT cannot write the turn table or call the server functions', async () => {
    const db = clientFor(employee, { aal: 'aal2', email: `${employee}@${DOMAIN}` });
    const insert = await db.from('portfolio_ai_turns').insert({ user_id: employee, question: 'q', scope_organization_ids: [A], prompt_version: 'x' });
    expect(insert.error, 'insert refused').not.toBeNull();
    const call = await db.schema('api_server').rpc('portfolio_ai_begin_turn', { p_actor: employee, p_question: 'q', p_scope: [A], p_prompt_version: 'x' });
    expect(call.error, 'api_server refused to a user').not.toBeNull();
    expect(sqlstate(call.error)).not.toBe('00000');
  });

  it('another user cannot read the employee\'s turns', async () => {
    const db = clientFor(ownerC, { email: `${ownerC}@${DOMAIN}` });
    const { data, error } = await db.from('portfolio_ai_turns').select('id');
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
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
    const ctx = await ctxFor(employee, 'aal2');
    const result = await askAdviser(ctx, 'Summarise', { transport: model.transport });
    expect(result.status).toBe('degraded');
    const [alpha, beta] = result.briefing!.clients;
    expect(alpha!.summary).not.toContain('23%');
    expect(alpha!.summary).toContain('critical alert');
    expect(beta!.because).toEqual([]);
    expect(result.briefing!.notes).toEqual([]);
    const stored = adminSql(`select answer::text from public.portfolio_ai_turns where id='${result.turnId}'`);
    expect(stored).not.toContain('412');
    expect(stored).not.toContain('23%');
  });

  it('M-1: a figure written in words is removed, and the turn is stored degraded — never "Grounded"', async () => {
    // The independent audit's P7: this sentence was persisted with grounding_status = passed and
    // rendered under the Grounded badge. The badge is read from grounding_status (analyst/page.tsx).
    const model = fakeModel(() => ({
      mode: 'answer', headline: 'Alpha needs attention.',
      clients: [{ ref: 'client:1', summary: 'Revenue fell by twenty per cent and cash runway is one and a half months. Costs doubled.', because: ['alert:1'] }],
      notes: ['Margin halved across the portfolio.'], limitations: [],
    }));
    const ctx = await ctxFor(employee, 'aal2');
    const result = await askAdviser(ctx, 'What changed?', { transport: model.transport });
    expect(result.status).toBe('degraded');
    const stored = adminSql(`select grounding_status || '|' || answer::text from public.portfolio_ai_turns where id='${result.turnId}'`);
    expect(stored.startsWith('degraded|')).toBe(true);
    for (const words of ['twenty per cent', 'one and a half', 'doubled', 'halved']) expect(stored).not.toContain(words);
    const turns = await listAdviserTurns(ctx);
    expect(turns.find((t) => t.id === result.turnId)?.groundingStatus).toBe('degraded');
  });

  it('ADR-116: the model cites facts; the server writes every figure, and the answer is Grounded', async () => {
    const model = fakeModel(() => ({
      mode: 'answer',
      headline: [{ kind: 'facts', facts: ['portfolio/needing_attention'] }, { kind: 'text', text: 'Alpha needs attention first.' }],
      clients: [{
        ref: 'client:1',
        statements: [
          // The model tries to put its own figure beside the fact; it is never shown.
          { kind: 'facts', facts: ['client:1/critical_alerts', 'client:1/open_actions'], text: 'Alpha has 40 critical alerts' },
          { kind: 'text', text: 'Its cash alert is the one to act on.' },
        ],
        because: ['alert:1'],
      }],
      notes: [], limitations: [],
    }));
    const ctx = await ctxFor(employee, 'aal2');
    const result = await askAdviser(ctx, 'Where first?', { transport: model.transport });
    expect(result.status).toBe('passed');
    const alpha = result.briefing!.clients[0]!;
    expect(alpha.summary).toBe(`PA Alpha ${RUN} has 1 standing critical alert and 0 open actions. Its cash alert is the one to act on.`);
    expect(alpha.facts).toEqual(['client:1/critical_alerts', 'client:1/open_actions']);
    // What the model was shown of each fact is the sentence the server writes — not a number to reuse.
    expect(handed(model.calls[0]!)).toContain(`PA Alpha ${RUN} has 1 standing critical alert.`);
    const stored = adminSql(`select grounding_status || '|' || answer::text from public.portfolio_ai_turns where id='${result.turnId}'`);
    expect(stored.startsWith('passed|')).toBe(true);
    expect(stored).not.toContain('40 critical');
  });

  it('F-1/F-3: prose that states or swaps a figure is removed, and the turn is not Grounded', async () => {
    const model = fakeModel(() => ({
      mode: 'answer', headline: 'Alpha needs attention first.',
      clients: [{ ref: 'client:1', statements: [
        { kind: 'text', text: 'It has 3 critical alerts as well as 1 open action.' },
        { kind: 'facts', facts: ['client:1/critical_alerts'] },
      ], because: [] }],
      notes: ['Twelve clients need attention.'], limitations: [],
    }));
    const result = await askAdviser(await ctxFor(employee, 'aal2'), 'Summarise', { transport: model.transport });
    expect(result.status).toBe('degraded');
    expect(result.briefing!.clients[0]!.summary).toBe(`PA Alpha ${RUN} has 1 standing critical alert.`);
    expect(result.briefing!.notes).toEqual([]);
    expect(adminSql(`select grounding_status from public.portfolio_ai_turns where id='${result.turnId}'`).trim()).toBe('degraded');
  });

  it('L-2: a cited title that is a number does not launder a figure', async () => {
    const titled = seedAlert(A, 'high', '3');
    try {
      const model = fakeModel((call) => {
        // Every digest string arrives wrapped as <data name="…">…</data> (untrustedJson).
        const ref = /(alert:\d+)<\/data>[^{}]*?title[^{}]*?>3<\/data>/.exec(handed(call))?.[1];
        if (ref === undefined) throw new Error('the seeded title is not in the digest');
        return { mode: 'answer', headline: 'Alpha needs attention.', clients: [{ ref: 'client:1', summary: 'Revenue fell 3% this quarter.', because: [ref] }], notes: [], limitations: [] };
      });
      const result = await askAdviser(await ctxFor(employee, 'aal2'), 'Revenue?', { transport: model.transport });
      expect(result.status).toBe('degraded');
      expect(adminSql(`select answer::text from public.portfolio_ai_turns where id='${result.turnId}'`)).not.toContain('3%');
    } finally {
      adminSql(`delete from public.alerts where id='${titled}'`);
    }
  });

  it('a refusal carries no clients and is not_applicable', async () => {
    const model = fakeModel(() => ({ mode: 'refusal', headline: 'That is outside this portfolio.', clients: [], notes: [], limitations: [] }));
    const result = await askAdviser(await ctxFor(employee, 'aal2'), 'Write me a poem', { transport: model.transport });
    expect(result.status).toBe('not_applicable');
    expect(result.briefing!.clients).toEqual([]);
  });

  it('a malformed submission is recorded as failed, never rendered', async () => {
    const model = fakeModel(() => ({ nonsense: true }));
    const ctx = await ctxFor(employee, 'aal2');
    const result = await askAdviser(ctx, 'Anything', { transport: model.transport });
    expect(result.status).toBe('failed');
    expect(result.briefing).toBeNull();
    expect(adminSql(`select status || '|' || coalesce(answer::text,'NULL') from public.portfolio_ai_turns where id='${result.turnId}'`).trim()).toBe('failed|NULL');
  });

  it('cites only the digest\'s own references, resolved to real alert ids', async () => {
    const model = fakeModel(() => ({ mode: 'answer', headline: 'Alpha first.', clients: [{ ref: 'client:1', summary: 'A critical alert stands.', because: ['alert:1'] }], notes: [], limitations: ['Financial figures are not in the data.'] }));
    const ctx = await ctxFor(employee, 'aal2');
    const result = await askAdviser(ctx, 'Where first?', { transport: model.transport });
    const turn = (await listAdviserTurns(ctx))[0]!;
    expect(result.status).toBe('passed');
    expect(turn.answer!.refs).toEqual([{ ref: 'alert:1', kind: 'alert', id: alertA, organizationId: A, title: 'Alpha cash runway is short' }]);
  });
});

describe('HIGH-C — a stored turn is readable only while its author CURRENTLY advises its whole scope', () => {
  let adviser: string; let clientOfA: string;
  const answer = () => ({ mode: 'answer', headline: 'Alpha first.', clients: [{ ref: 'client:1', summary: 'A critical alert stands.', because: ['alert:1'] }], notes: [], limitations: [] });
  const readById = async (user: string, turnId: string, aal: 'aal1' | 'aal2' = 'aal2') => {
    const { data, error } = await clientFor(user, { aal, email: `${user}@${DOMAIN}` }).from('portfolio_ai_turns').select('id, answer').eq('id', turnId);
    expect(error).toBeNull();
    return data ?? [];
  };
  const assign = (org: string, status: 'active' | 'revoked') =>
    adminSql(`insert into public.organization_assignments (organization_id, employee_user_id, status) values ('${org}','${adviser}','${status}')
              on conflict (organization_id, employee_user_id) do update set status = excluded.status`);

  beforeAll(() => {
    adviser = createAuthUser(`adviser2@${DOMAIN}`);
    clientOfA = createAuthUser(`client-of-a@${DOMAIN}`);
    adminSql(`insert into public.platform_users (user_id, platform_role) values ('${adviser}','employee')`);
    adminSql(`update public.profiles set mfa_enrolled_at = now() where id = '${adviser}'`);
    adminSql(`insert into public.organization_memberships (organization_id, user_id, role, status) values ('${A}','${clientOfA}','client','active')`);
  });
  afterAll(() => { adminSql(`delete from public.platform_users where user_id='${adviser}'`); });

  it('A–C: readable while assigned; gone on the next request after revocation; back on reassignment', async () => {
    assign(A, 'active'); assign(B, 'revoked');
    const ctx = await ctxFor(adviser, 'aal2');
    expect(ctx.organisationIds).toEqual([A]);
    const turn = await askAdviser(ctx, 'Where first?', { transport: fakeModel(answer).transport });
    expect(await readById(adviser, turn.turnId)).toHaveLength(1);
    expect((await listAdviserTurns(ctx)).map((t) => t.id)).toContain(turn.turnId);

    assign(A, 'revoked');
    // G: the database itself, with the adviser's own JWT, returns nothing — and so does the service.
    expect(await readById(adviser, turn.turnId)).toEqual([]);
    expect((await listAdviserTurns({ ...ctx, organisations: [], organisationIds: [] })).map((t) => t.id)).not.toContain(turn.turnId);

    assign(A, 'active');
    expect(await readById(adviser, turn.turnId)).toHaveLength(1);
  });

  it('D: a turn over two organisations is unreadable once either leaves the author\'s scope', async () => {
    assign(A, 'active'); assign(B, 'active');
    const ctx = await ctxFor(adviser, 'aal2');
    expect([...ctx.organisationIds].sort()).toEqual([A, B].sort());
    const turn = await askAdviser(ctx, 'Both?', { transport: fakeModel(answer).transport });
    expect(await readById(adviser, turn.turnId)).toHaveLength(1);
    assign(B, 'revoked');
    expect(await readById(adviser, turn.turnId)).toEqual([]);
    assign(B, 'active');
    expect(await readById(adviser, turn.turnId)).toHaveLength(1);
  });

  it('E–F: a client of the organisation, and another adviser of the same organisations, cannot read it by id', async () => {
    assign(A, 'active'); assign(B, 'revoked');
    const turn = await askAdviser(await ctxFor(adviser, 'aal2'), 'Mine?', { transport: fakeModel(answer).transport });
    expect(await readById(clientOfA, turn.turnId, 'aal1')).toEqual([]);
    // ownerC owns A, B and C — a current adviser of the scope, but not the author.
    expect(await readById(ownerC, turn.turnId, 'aal1')).toEqual([]);
    // The author's own aal1 session advises nothing, so reads nothing.
    expect(await readById(adviser, turn.turnId, 'aal1')).toEqual([]);
  });
});
