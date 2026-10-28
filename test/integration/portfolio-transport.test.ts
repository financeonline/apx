import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPortfolio, loadPortfolioActions, loadPortfolioAlerts, resolvePortfolioContext, type PortfolioContext } from '@/modules/portfolio';
import { anonClient, clientFor, createAuthUser, fs, rpc } from './setup';
import { actionDoc, addMember, assignmentDoc, cleanup, orgDoc, platformUser } from './portfolio-fixtures';
import { globalRow, newId, orgRow } from '@/db/schema';

/**
 * The Command Centre for large portfolios (ADR-117; final release audit of 33a182f, F-5).
 *
 * F-5: the detail reads were GETs carrying every organisation id in the URL; at 201 organisations
 * the gateway answered 414 and the whole Command Centre failed. The resolver and the aggregate were
 * also cut at PostgREST's 1,000 rows (L-6). Every read is now an `api.portfolio_*` function whose
 * scope is derived from the caller's CURRENT adviser organisations; a list passed in can only
 * narrow it. (On Firestore there is no URL or HTTP row cap left to overflow; what this suite still
 * proves is completeness and scope at that size.) This suite holds 1,005 organisations: a super admin reads all of them, an employee with 250
 * assignments reads exactly those, and a body with forged ids reads nothing it should not.
 *
 * The Command Centre is APX staff only (owner, 2026-10-14; ADR-112 addendum): a company owner or
 * client reads nothing through these functions — not even their own organisation (20261018000030).
 */

const RUN = `pt${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.portfoliotransport.itest.motion`;
const BULK = 1_005;
const ASSIGNED = 250;

let superAdmin: string; let employee: string; let employeeOne: string; let owner: string; let clientUser: string;
let bulk: string[] = [];
let far: string[] = [];
let own = '';
const users: string[] = [];

const ctxFor = async (user: string): Promise<PortfolioContext> => {
  const ctx = await resolvePortfolioContext(clientFor(user, { email: `${user}@${DOMAIN}` }), user, `itest-${RUN}`);
  return { ...ctx, now: () => new Date('2026-09-15T12:00:00Z') };
};

beforeAll(async () => {
  superAdmin = await createAuthUser(`super@${DOMAIN}`);
  employee = await createAuthUser(`employee@${DOMAIN}`);
  employeeOne = await createAuthUser(`employee-one@${DOMAIN}`);
  owner = await createAuthUser(`owner@${DOMAIN}`);
  clientUser = await createAuthUser(`client@${DOMAIN}`);
  users.push(superAdmin, employee, employeeOne, owner, clientUser);
  await platformUser(superAdmin, 'super_admin');
  await platformUser(employee, 'employee');
  await platformUser(employeeOne, 'employee');

  bulk = Array.from({ length: BULK }, () => newId()).sort();
  const writer = fs().bulkWriter();
  bulk.forEach((id, g) => {
    void writer.set(globalRow(fs(), 'organizations', id),
      orgDoc(id, `ITest PT Bulk ${String(g + 1).padStart(4, '0')} ${RUN}`, `itest-${RUN}-${g + 1}`));
  });
  // The three organisations with the highest ids: the last rows of the old aggregate's second page.
  far = bulk.slice(-3);
  for (const o of far) {
    const a = actionDoc(o, 'Far overdue action', 'high', '2026-01-15');
    void writer.set(orgRow(fs(), o, 'actions', String(a.id)), a);
  }
  // An employee assigned to 250 of them (past 200, where the old URL overflowed), including the far three.
  for (const o of [...bulk.slice(0, ASSIGNED - 3), ...far]) {
    void writer.set(orgRow(fs(), o, 'organization_assignments', employee), assignmentDoc(o, employee));
  }
  // A second employee assigned to one organisation only — the narrow scope a forged body must not widen.
  own = bulk[0]!;
  void writer.set(orgRow(fs(), own, 'organization_assignments', employeeOne), assignmentDoc(own, employeeOne));
  await writer.close();
  // A company owner of that same organisation, who is a client in another; and a client.
  await addMember(own, owner, 'owner');
  await addMember(far[0]!, owner, 'client');
  await addMember(far[1]!, clientUser, 'client');
}, 300_000);

afterAll(async () => {
  await cleanup(bulk, users);
}, 300_000);

describe('a super admin over more than a thousand organisations', () => {
  it('the Command Centre loads, whole: every organisation, and the counts of the last page', async () => {
    const started = Date.now();
    const view = await loadPortfolio(await ctxFor(superAdmin));
    const ms = Date.now() - started;
    const ids = new Set(view.clients.map((c) => c.organisation.id));
    expect(bulk.every((id) => ids.has(id))).toBe(true);
    for (const id of far) {
      expect(view.clients.find((c) => c.organisation.id === id)?.counts).toMatchObject({ actionsOpen: 1, actionsOverdue: 1 });
    }
    console.log(`[F-5] super admin: ${view.clients.length} organisations, ${ms} ms (local, not a benchmark)`);
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
    const view = await loadPortfolio(ctx);
    expect(view.clients).toHaveLength(ASSIGNED);
    expect(view.counts.overdueActions).toBe(3);
    const actions = await loadPortfolioActions(ctx, view, 'overdue');
    expect(actions.rows.map((a) => a.organizationId).sort()).toEqual([...far].sort());
    expect(actions.total).toBe(3);
  }, 120_000);
});

describe('a list in the body never widens the scope', () => {
  const call = (user: string, fn: string, args: Record<string, unknown>) =>
    rpc(clientFor(user, { email: `${user}@${DOMAIN}` }), fn, args);

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

  it('anon reads nothing', async () => {
    // On PostgreSQL `anon` had no grant and was refused outright; here nobody signed in has no adviser
    // scope, so every read is empty — the same outcome for the data.
    const r = await rpc(anonClient(), 'portfolio_open_actions', { p_orgs: null, p_lens: 'attention', p_today: '2026-09-15', p_due_soon_until: '2026-09-29', p_limit: 500 });
    expect(r.error).toBeNull();
    expect(r.data).toEqual([]);
  });
});
