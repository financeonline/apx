import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadPortfolio, loadPortfolioActions, loadPortfolioAlerts, resolvePortfolioContext, type PortfolioContext } from '@/modules/portfolio';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * The Command Centre for large portfolios (ADR-117; final release audit of 33a182f, F-5).
 *
 * F-5: the detail reads were GETs carrying every organisation id in the URL; at 201 organisations
 * the gateway answered 414 and the whole Command Centre failed. The resolver and the aggregate were
 * also cut at PostgREST's 1,000 rows (L-6). Every read is now an RPC whose scope the database
 * derives from the caller's CURRENT adviser organisations; a list sent in the body can only narrow
 * it. This suite holds 1,005 organisations: a super admin reads all of them, an employee with 250
 * assignments reads exactly those, and a body with forged ids reads nothing it should not.
 *
 * The Command Centre is APX staff only (owner, 2026-10-14; ADR-112 addendum): a company owner or
 * client reads nothing through these functions — not even their own organisation (20261018000030).
 */

const RUN = `pt${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.portfoliotransport.itest`;
const BULK = 1_005;
const ASSIGNED = 250;

let superAdmin: string; let employee: string; let employeeOne: string; let owner: string; let clientUser: string;
let bulk: string[] = [];
let far: string[] = [];
let own = '';

const ctxFor = async (user: string): Promise<PortfolioContext> => {
  const ctx = await resolvePortfolioContext(clientFor(user, { email: `${user}@${DOMAIN}` }), user, `itest-${RUN}`);
  return { ...ctx, now: () => new Date('2026-09-15T12:00:00Z') };
};

/** Counts every HTTP request the Supabase client makes while `run` executes. */
async function requestsDuring<T>(run: () => Promise<T>): Promise<{ result: T; requests: string[] }> {
  const real = globalThis.fetch;
  const requests: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
    return real(input, init);
  });
  try {
    return { result: await run(), requests };
  } finally {
    spy.mockRestore();
  }
}

beforeAll(() => {
  superAdmin = createAuthUser(`super@${DOMAIN}`);
  employee = createAuthUser(`employee@${DOMAIN}`);
  employeeOne = createAuthUser(`employee-one@${DOMAIN}`);
  owner = createAuthUser(`owner@${DOMAIN}`);
  clientUser = createAuthUser(`client@${DOMAIN}`);
  adminSql(`insert into public.platform_users (user_id, platform_role) values ('${superAdmin}','super_admin'), ('${employee}','employee'), ('${employeeOne}','employee')`);
  bulk = adminSql(`with q as (insert into public.organizations (slug, name)
      select '${RUN}-' || g, 'PT Bulk ' || lpad(g::text, 4, '0') || ' ${RUN}' from generate_series(1, ${BULK}) g returning id)
    select id from q order by id`).split('\n').map((s) => s.trim()).filter(Boolean);
  // The three organisations with the highest ids: the last rows of the aggregate's second page.
  far = bulk.slice(-3);
  adminSql(`insert into public.actions (organization_id, title, priority, due_date, status, source_type)
    select o, 'Far overdue action', 'high', '2026-01-15', 'open', 'user' from unnest(array['${far.join("','")}']::uuid[]) o`);
  // An employee assigned to 250 of them (past 200, where the old URL overflowed), including the far three.
  const assigned = [...bulk.slice(0, ASSIGNED - 3), ...far];
  adminSql(`insert into public.organization_assignments (organization_id, employee_user_id)
    select o, '${employee}' from unnest(array['${assigned.join("','")}']::uuid[]) o`);
  // A second employee assigned to one organisation only — the narrow scope a forged body must not widen.
  own = bulk[0]!;
  adminSql(`insert into public.organization_assignments (organization_id, employee_user_id) values ('${own}','${employeeOne}')`);
  // A company owner of that same organisation, who is a client in another; and a client.
  adminSql(`insert into public.organization_memberships (organization_id, user_id, role, status) values
    ('${own}','${owner}','owner','active'), ('${far[0]}','${owner}','client','active'), ('${far[1]}','${clientUser}','client','active')`);
}, 300_000);

afterAll(() => {
  adminSql(`delete from public.organizations where slug like '${RUN}-%';
            delete from public.platform_users where user_id in ('${superAdmin}','${employee}','${employeeOne}');
            delete from auth.users where email like '%@${DOMAIN}';`);
}, 300_000);

describe('a super admin over more than a thousand organisations', () => {
  it('the Command Centre loads, whole: every organisation, and the counts of the last page', async () => {
    const started = Date.now();
    const { result: view, requests } = await requestsDuring(async () => loadPortfolio(await ctxFor(superAdmin)));
    const ms = Date.now() - started;
    const ids = new Set(view.clients.map((c) => c.organisation.id));
    expect(bulk.every((id) => ids.has(id))).toBe(true);
    for (const id of far) {
      expect(view.clients.find((c) => c.organisation.id === id)?.counts).toMatchObject({ actionsOpen: 1, actionsOverdue: 1 });
    }
    // No request per organisation: the resolver and the aggregate in pages of 1,000, plus two feeds.
    expect(requests.every((r) => r.startsWith('POST /rest/v1/rpc/'))).toBe(true);
    expect(requests.length).toBeLessThanOrEqual(1 + Math.ceil(view.clients.length / 1_000) * 2 + 2);
    console.log(`[F-5] super admin: ${view.clients.length} organisations, ${requests.length} requests, ${ms} ms (local, not a benchmark)`, requests);
  }, 120_000);

  it('the alerts and action lenses load over the same scope', async () => {
    const ctx = await ctxFor(superAdmin);
    const view = await loadPortfolio(ctx);
    const actions = await loadPortfolioActions(ctx, view, 'overdue');
    expect(actions.rows.filter((a) => far.includes(a.organizationId))).toHaveLength(3);
    await expect(loadPortfolioAlerts(ctx, view)).resolves.toMatchObject({ truncated: expect.any(Boolean) });
  }, 120_000);
});

describe('an employee with two hundred and fifty assignments', () => {
  it('reads exactly the assigned organisations — past the old 200-id URL limit', async () => {
    const ctx = await ctxFor(employee);
    expect(ctx.organisationIds).toHaveLength(ASSIGNED);
    const { result: view, requests } = await requestsDuring(() => loadPortfolio(ctx));
    expect(view.clients).toHaveLength(ASSIGNED);
    expect(view.counts.overdueActions).toBe(3);
    // The whole-portfolio reads send no list of ids at all: the database derives the scope.
    expect(requests.every((r) => r.startsWith('POST /rest/v1/rpc/'))).toBe(true);
    const actions = await loadPortfolioActions(ctx, view, 'overdue');
    expect(actions.rows.map((a) => a.organizationId).sort()).toEqual([...far].sort());
    expect(actions.total).toBe(3);
  }, 120_000);
});

describe('a list in the body never widens the scope', () => {
  const call = (user: string, fn: string, args: Record<string, unknown>) =>
    clientFor(user, { email: `${user}@${DOMAIN}` }).schema('api').rpc(fn, args);

  it('an employee asking for foreign organisations gets only their assigned one', async () => {
    const asked = [own, far[0]!, far[2]!];
    const summary = await call(employeeOne, 'portfolio_summary', { p_orgs: asked, p_today: '2026-09-15', p_due_soon_until: '2026-09-29' });
    expect(summary.error).toBeNull();
    expect((summary.data as Array<{ organization_id: string }>).map((r) => r.organization_id)).toEqual([own]);
    const actions = await call(employeeOne, 'portfolio_open_actions', { p_orgs: asked, p_lens: 'attention', p_today: '2026-09-15', p_due_soon_until: '2026-09-29', p_limit: 500 });
    expect(actions.error).toBeNull();
    expect(actions.data).toEqual([]);
  });

  it('a company owner gets nothing at all — not even their own organisation (owner, 2026-10-14)', async () => {
    for (const p_orgs of [[own], [own, far[0]!, far[2]!], null]) {
      const summary = await call(owner, 'portfolio_summary', { p_orgs, p_today: '2026-09-15', p_due_soon_until: '2026-09-29' });
      expect(summary.error).toBeNull();
      expect(summary.data).toEqual([]);
    }
  });

  it('a client, and an owner over their own organisation and the one they are only a client of, read nothing', async () => {
    for (const [user, org] of [[clientUser, far[1]!], [owner, far[0]!], [owner, own]] as const) {
      for (const [fn, args] of [
        ['portfolio_open_actions', { p_orgs: [org], p_lens: 'attention', p_today: '2026-09-15', p_due_soon_until: '2026-09-29', p_limit: 500 }],
        ['portfolio_open_actions', { p_orgs: null, p_lens: 'overdue', p_today: '2026-09-15', p_due_soon_until: '2026-09-29', p_limit: 500 }],
        ['portfolio_finished_actions', { p_orgs: null, p_since: '2000-01-01T00:00:00Z', p_limit: 50 }],
        ['portfolio_standing_alerts', { p_orgs: [org], p_limit: 500 }],
        ['portfolio_recent_alerts', { p_orgs: null, p_since: '2000-01-01T00:00:00Z', p_limit: 50 }],
      ] as const) {
        const r = await call(user, fn, args);
        expect(r.error, `${fn}`).toBeNull();
        expect((r.data as Array<{ organization_id: string }>).filter((row) => row.organization_id === org), `${fn} ${user === owner ? 'owner' : 'client'}`).toEqual([]);
      }
    }
  });

  it('a random id reads nothing, and the cap cannot be raised past 500', async () => {
    const random = await call(superAdmin, 'portfolio_open_actions', { p_orgs: ['00000000-0000-4000-8000-000000000000'], p_lens: 'attention', p_today: '2026-09-15', p_due_soon_until: '2026-09-29', p_limit: 500 });
    expect(random.data).toEqual([]);
    const capped = await call(superAdmin, 'portfolio_open_actions', { p_orgs: null, p_lens: 'attention', p_today: '2026-09-15', p_due_soon_until: '2026-09-29', p_limit: 100_000 });
    expect((capped.data as unknown[]).length).toBeLessThanOrEqual(500);
  });

  it('anon cannot call the reads at all', async () => {
    const { createClient } = await import('@supabase/supabase-js');
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    const r = await anon.schema('api').rpc('portfolio_open_actions', { p_orgs: null, p_lens: 'attention', p_today: '2026-09-15', p_due_soon_until: '2026-09-29', p_limit: 500 });
    expect(r.error).not.toBeNull();
  });
});
