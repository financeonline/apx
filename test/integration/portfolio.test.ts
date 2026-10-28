import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { isMotionError } from '@/core/errors';
import {
  loadOpportunities, loadPortfolio, loadPortfolioActions, loadPortfolioAlerts, loadPortfolioReport, resolvePortfolioContext,
  type PortfolioContext, type PortfolioView,
} from '@/modules/portfolio';
import { clientFor, createAuthUser, fs, rpc } from './setup';
import {
  actionDoc, addMember, alertDoc, assign, cleanup, periodOf, platformUser, seedOrg, seedRun,
  seedScore, setAssignmentStatus,
} from './portfolio-fixtures';
import { orgRow } from '@/db/schema';

/**
 * The Command Centre's boundary (ADR-112 §2, §4; brief §7, §8, §18, §19).
 *
 * Five organisations; staff callers who advise some of them, and company logins who advise none.
 * What each may see is asserted at three layers that must agree: the resolver (who has a portfolio,
 * and over which organisations), the read model (what the portfolio's own statements return for
 * them), and the database (what RLS returns when the resolver is BYPASSED and a foreign
 * organisation's id is put straight into the statement — the adversarial path). A count that leaked
 * across that line would fail here before any page saw it.
 *
 * The Command Centre is APX staff only (owner, 2026-10-14; ADR-112 addendum): the super admin, and
 * the Financial Analysts (`employee`) over their assignments. A company's owner, admin or client has
 * none — the uniform 404 from the resolver, and nothing from the database's portfolio functions even
 * for their OWN organisations (20261018000030). The owners and admins below still create and hold the
 * organisations; the portfolio actors are employees and the super admin.
 */

const RUN = `pf${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.portfolio.itest.motion`;

let ownerAB: string; let employee: string; let employeeD: string; let superAdmin: string; let clientC: string; let clientOnly: string; let stranger: string; let adminD: string; let adminOnly: string;
let A: string; let B: string; let C: string; let D: string; let E: string;
const named = new Map<string, string>();
const users: string[] = [];

async function person(local: string): Promise<string> {
  const id = await createAuthUser(`${local}@${DOMAIN}`);
  users.push(id);
  return id;
}

/** An organisation and its owner's membership — what `create_organization` leaves behind. */
async function createOrg(owner: string, name: string): Promise<string> {
  const id = await seedOrg(name);
  await addMember(id, owner, 'owner');
  named.set(id, name);
  return id;
}

const period = (org: string) => periodOf(org, '2026-07-01');
const olderPeriod = (org: string) => periodOf(org, '2026-06-01');
const threeDaysAgo = () => new Date(Date.now() - 3 * 86_400_000).toISOString();

async function seedAlert(org: string, periodId: string, runId: string, severity: string, title: string, status = 'open') {
  const doc = alertDoc(org, periodId, runId, severity, title, { status, firstSeenAt: threeDaysAgo(), dedupe: `${RUN}-${title}` });
  await orgRow(fs(), org, 'alerts', String(doc.id)).set(doc);
}
async function seedAction(org: string, title: string, priority: string, due: string | null, status = 'open', owner: string | null = null) {
  const doc = actionDoc(org, title, priority, due, { status, owner });
  await orgRow(fs(), org, 'actions', String(doc.id)).set(doc);
}

const ctxFor = async (user: string): Promise<PortfolioContext> => {
  const db = clientFor(user, { email: `${user}@${DOMAIN}` });
  const ctx = await resolvePortfolioContext(db, user, `itest-${RUN}`);
  return { ...ctx, now: () => new Date('2026-09-15T12:00:00Z') };
};

beforeAll(async () => {
  ownerAB = await person('owner-ab');
  adminD = await person('admin-d');
  clientC = await person('client-c');
  employee = await person('employee');
  employeeD = await person('employee-d');
  superAdmin = await person('super');
  stranger = await person('stranger');
  clientOnly = await person('client-only');
  adminOnly = await person('admin-only');
  await platformUser(employee, 'employee');
  await platformUser(employeeD, 'employee');
  await platformUser(superAdmin, 'super_admin');

  A = await createOrg(ownerAB, `ITest PF Alpha ${RUN}`);
  B = await createOrg(ownerAB, `ITest PF Beta ${RUN}`);
  C = await createOrg(adminD, `ITest PF Gamma ${RUN}`);   // adminD owns C; clientC is a client of C
  D = await createOrg(clientC, `ITest PF Delta ${RUN}`);  // clientC owns D — a mixed-role person
  E = await createOrg(adminD, `ITest PF Epsilon ${RUN}`);   // adminD owns E too; nobody else reaches it but the super admin

  await addMember(C, clientC, 'client');
  await addMember(C, clientOnly, 'client');
  await addMember(D, adminD, 'admin');
  // A company admin and nothing else: an admin of A, a member of no other organisation.
  await addMember(A, adminOnly, 'admin');
  // The staff: one Financial Analyst over A and B, another over D alone; E is assigned to nobody.
  await assign(A, employee);
  await assign(B, employee);
  await assign(D, employeeD);

  // Facts, written the way the jobs write them.
  for (const [org, score, prev] of [[A, 35, 62], [B, 85, 84], [C, 50, 50]] as const) {
    const earlier = await seedRun(org, olderPeriod(org));
    await seedScore(org, olderPeriod(org), earlier, prev);
    const run = await seedRun(org, period(org));
    await seedScore(org, period(org), run, score);
    named.set(`run:${org}`, run);
  }
  await seedAlert(A, period(A), named.get(`run:${A}`)!, 'critical', 'A critical');
  await seedAlert(A, period(A), named.get(`run:${A}`)!, 'high', 'A high');
  await seedAlert(A, period(A), named.get(`run:${A}`)!, 'medium', 'A resolved', 'resolved');
  await seedAlert(B, period(B), named.get(`run:${B}`)!, 'low', 'B low');
  await seedAlert(C, period(C), named.get(`run:${C}`)!, 'critical', 'C critical');
  await seedAction(A, 'A overdue', 'medium', '2026-09-01');
  await seedAction(A, 'A undated urgent', 'critical', null, 'open', employee);
  await seedAction(B, 'B done', 'low', null, 'completed');
  await seedAction(C, 'C overdue', 'high', '2026-08-01');
}, 120_000);

afterAll(async () => {
  await cleanup([A, B, C, D, E].filter(Boolean), users);
}, 120_000);

const names = (ctx: PortfolioContext) => ctx.organisations.map((o) => o.name).sort();
/** The capped detail lists, as the alerts and actions pages read them. */
async function details(ctx: PortfolioContext, view: PortfolioView) {
  const [alerts, actions] = await Promise.all([loadPortfolioAlerts(ctx, view), loadPortfolioActions(ctx, view, 'attention')]);
  return { alerts: alerts.rows, actions: actions.rows };
}

const notFound = (e: unknown) => isMotionError(e) && e.code === 'NOT_FOUND';

describe('who has a portfolio, and over what (ADR-112 §2, as amended 2026-10-14)', () => {
  it('an employee: assigned organisations only', async () => {
    const ctx = await ctxFor(employee);
    expect(names(ctx)).toEqual([named.get(A), named.get(B)]);
    expect(ctx.organisations.every((o) => o.role === 'employee')).toBe(true);
  });

  it('a second employee: their own assignment only — D, not their colleague\'s A and B, not unassigned E', async () => {
    const ctx = await ctxFor(employeeD);
    expect(names(ctx)).toEqual([named.get(D)]);
    expect(ctx.organisations.every((o) => o.role === 'employee')).toBe(true);
  });

  it('a super admin sees every organisation', async () => {
    const ctx = await ctxFor(superAdmin);
    for (const org of [A, B, C, D, E]) expect(ctx.organisationIds).toContain(org);
    expect(ctx.organisations.filter((o) => [A, B, C, D, E].includes(o.id)).every((o) => o.role === 'super_admin')).toBe(true);
  });

  it('a stranger, and a client-only member, get NOT_FOUND — the same answer', async () => {
    await expect(ctxFor(stranger)).rejects.toSatisfy(notFound);
    await expect(ctxFor(clientOnly)).rejects.toSatisfy(notFound);
  });
});

describe('a company login has no Command Centre — not even over its own companies (owner, 2026-10-14)', () => {
  it('a company owner of two organisations gets NOT_FOUND — the same answer as a stranger', async () => {
    await expect(ctxFor(ownerAB)).rejects.toSatisfy(notFound);
  });

  it('a company admin gets NOT_FOUND', async () => {
    await expect(ctxFor(adminOnly)).rejects.toSatisfy(notFound);
  });

  it('a company client gets NOT_FOUND', async () => {
    await expect(ctxFor(clientOnly)).rejects.toSatisfy(notFound);
  });

  it('mixed company roles add up to nothing: an owner of C and E who administers D, and a client of C who owns D', async () => {
    await expect(ctxFor(adminD)).rejects.toSatisfy(notFound);
    await expect(ctxFor(clientC)).rejects.toSatisfy(notFound);
  });

  it('the database agrees: every portfolio function returns nothing to them, even for their own organisations', async () => {
    // The resolver is bypassed here: each login asks the portfolio's own functions, with its own JWT,
    // for exactly the organisations it holds a company role in — and for the whole scope (NULL).
    const own: Array<[string, string, string[]]> = [
      [ownerAB, 'owner-ab', [A, B]], [adminOnly, 'admin-only', [A]], [clientOnly, 'client-only', [C]],
      [adminD, 'admin-d', [C, D, E]], [clientC, 'client-c', [C, D]],
    ];
    for (const [user, local, orgs] of own) {
      const db = clientFor(user, { email: `${local}@${DOMAIN}` });
      for (const p_orgs of [orgs, null]) {
        for (const [fn, args] of [
          ['portfolio_summary', { p_orgs, p_today: '2026-09-15', p_due_soon_until: '2026-09-29' }],
          ['portfolio_standing_alerts', { p_orgs, p_limit: 500 }],
          ['portfolio_recent_alerts', { p_orgs, p_since: '2000-01-01T00:00:00Z', p_limit: 50 }],
          ['portfolio_open_actions', { p_orgs, p_lens: 'attention', p_today: '2026-09-15', p_due_soon_until: '2026-09-29', p_limit: 500 }],
          ['portfolio_finished_actions', { p_orgs, p_since: '2000-01-01T00:00:00Z', p_limit: 50 }],
          ['portfolio_health_breakdowns', { p_orgs }],
        ] as const) {
          const r = await rpc(db, fn, args);
          expect(r.error, `${fn} for ${local}`).toBeNull();
          expect(r.data ?? [], `${fn} for ${local} over ${p_orgs === null ? 'the whole scope' : 'its own organisations'}`).toEqual([]);
        }
      }
    }
  });
});

describe('the read model counts over the authorised population only (ADR-112 §4)', () => {
  it('the employee\'s counts are A and B\'s, and never C\'s', async () => {
    const ctx = await ctxFor(employee);
    const view = await loadPortfolio(ctx);
    expect(view.counts).toEqual({
      clients: 2, needingAttention: 1, healthy: 1, unscored: 0, alertsStanding: 3,
      criticalAlerts: 1, highAlerts: 1, openActions: 2, overdueActions: 1,
      dueSoonActions: 0, urgentActions: 1, myActions: 1,
    });
    const { alerts, actions } = await details(ctx, view);
    // Worst first: the alert engine's own order.
    expect(alerts.map((a) => a.title)).toEqual(['A critical', 'A high', 'B low']);
    // `byUrgency`: critical first, then by due date.
    expect(actions.map((a) => a.title)).toEqual(['A undated urgent', 'A overdue']);
    // B's week: an action finished just now, and an alert first seen three days ago — newest first.
    expect(view.recent.filter((r) => r.organizationId === B).map((r) => [r.kind, r.label]))
      .toEqual([['action_completed', 'B done'], ['alert_raised', 'B low']]);
  });

  it('ranks A above B: critical alert first, with the health fall and the overdue action behind it', async () => {
    const view = await loadPortfolio(await ctxFor(employee));
    expect(view.attention.map((c) => c.organisation.id)).toEqual([A]);
    const a = view.attention[0]!;
    expect(a.attention!.reasons.map((r) => r.kind)).toEqual([
      'critical_alert', 'health_band_fell', 'health_at_risk', 'overdue_action', 'high_alert', 'urgent_action',
    ]);
    expect(a.health).toMatchObject({ score: 35, band: 'at_risk', previous: { score: 62, band: 'stable' } });
    expect(a.trend).toBe('down');
    const b = view.clients.find((c) => c.organisation.id === B)!;
    expect(b.attention).toBeNull();
    expect(b.health).toMatchObject({ score: 85, band: 'strong' });
    expect(b.trend).toBe('up');
  });

  it('a resolved alert is not standing, and a completed action is not open', async () => {
    const ctx = await ctxFor(employee);
    const { alerts, actions } = await details(ctx, await loadPortfolio(ctx));
    expect(alerts.some((a) => a.title === 'A resolved')).toBe(false);
    expect(actions.some((a) => a.title === 'B done')).toBe(false);
  });

  it('the super admin\'s counts include C and an unscored organisation is not a zero', async () => {
    const view = await loadPortfolio(await ctxFor(superAdmin));
    expect(view.counts.criticalAlerts).toBeGreaterThanOrEqual(2);
    const d = view.clients.find((c) => c.organisation.id === D)!;
    expect(d.health).toBeNull();
    expect(d.attention).toBeNull();
    expect(view.counts.unscored).toBeGreaterThanOrEqual(2);
  });
});

describe('the adversarial path: the resolver bypassed, a foreign id in the statement', () => {
  it('RLS returns nothing of C to the employee even when C\'s id is put in every query', async () => {
    const real = await ctxFor(employee);
    const forged: PortfolioContext = {
      ...real,
      organisations: [...real.organisations, { id: C, slug: 'gamma', name: 'Gamma', status: 'active', role: 'employee' }],
      organisationIds: [...real.organisationIds, C],
    };
    const view = await loadPortfolio(forged);
    const c = view.clients.find((row) => row.organisation.id === C)!;
    expect(c.health).toBeNull();
    expect(c.counts.alertsStanding).toBe(0);
    expect(c.counts.actionsOpen).toBe(0);
    const { alerts, actions } = await details(forged, view);
    expect(alerts.some((a) => a.organizationId === C)).toBe(false);
    expect(actions.some((a) => a.organizationId === C)).toBe(false);
    // The counts moved by exactly the forged (empty) client, and by nothing of C's.
    expect(view.counts.criticalAlerts).toBe(1);
    expect(view.counts.overdueActions).toBe(1);
  });

  it('the same for the employee of D forging E, an organisation they are not assigned, into their portfolio', async () => {
    const real = await ctxFor(employeeD);
    expect(real.organisationIds).toEqual([D]);
    const forged: PortfolioContext = {
      ...real,
      organisations: [...real.organisations, { id: E, slug: 'epsilon', name: 'Epsilon', status: 'active', role: 'employee' }],
      organisationIds: [...real.organisationIds, E],
    };
    const secret = actionDoc(E, 'E secret', 'critical', null);
    await orgRow(fs(), E, 'actions', String(secret.id)).set(secret);
    const view = await loadPortfolio(forged);
    const { alerts, actions } = await details(forged, view);
    expect(alerts).toEqual([]);
    expect(actions).toEqual([]);
    expect(view.counts.openActions).toBe(0);
    expect(view.clients.find((row) => row.organisation.id === E)!.health).toBeNull();
  });
});

describe('an assignment revoked stops working on the next request', () => {
  it('B leaves the employee\'s portfolio, and its facts with it', async () => {
    await setAssignmentStatus(B, employee, 'revoked');
    try {
      const ctx = await ctxFor(employee);
      expect(names(ctx)).toEqual([named.get(A)]);
      const view = await loadPortfolio(ctx);
      expect(view.counts.clients).toBe(1);
      expect((await details(ctx, view)).alerts.some((a) => a.organizationId === B)).toBe(false);
      // And with A revoked too, the employee has an EMPTY Command Centre (ADR-114 §6) — no organisation,
      // no count, no row — not a 404.
      await setAssignmentStatus(A, employee, 'revoked');
      const empty = await ctxFor(employee);
      expect(empty.organisations).toEqual([]);
      const emptyView = await loadPortfolio(empty);
      expect(emptyView.counts.clients).toBe(0);
      expect(emptyView.counts.criticalAlerts).toBe(0);
    } finally {
      await setAssignmentStatus(A, employee, 'active');
      await setAssignmentStatus(B, employee, 'active');
    }
  });
});

describe('an eligible employee with no assignment has an empty Command Centre (ADR-114 §6)', () => {
  let unassigned: string;
  beforeAll(async () => {
    unassigned = await person('unassigned');
    await platformUser(unassigned, 'employee');
  });

  it('an empty portfolio — no organisation, no count — not the uniform 404', async () => {
    const ctx = await ctxFor(unassigned);
    expect(ctx.organisations).toEqual([]);
    const view = await loadPortfolio(ctx);
    expect(view.counts).toMatchObject({ clients: 0, criticalAlerts: 0, openActions: 0, needingAttention: 0 });
    expect(view.clients).toEqual([]);
  });

  it('a suspended platform account: NOT_FOUND', async () => {
    await fs().collection('platform_users').doc(unassigned).update({ status: 'suspended' });
    try {
      await expect(ctxFor(unassigned)).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'NOT_FOUND');
    } finally {
      await fs().collection('platform_users').doc(unassigned).update({ status: 'active' });
    }
  });
});

describe('advisory opportunities follow the same boundary (ADR-148)', () => {
  // A's and C's latest months carry a marketing score of 80: "campaigns paying back" for both.
  const marketing = [{ key: 'marketing_efficiency', included: true, score: 80, rules: [{ rule: 'M1', points: 20, result: '>= 3x', value: '3.2', skipped_reason: null }] }];
  beforeAll(async () => {
    for (const org of [A, C]) {
      const current = await orgRow(fs(), org, 'health_current', period(org)).get();
      await orgRow(fs(), org, 'health_scores', String(current.get('health_score_id'))).update({ breakdown: marketing });
    }
  });

  it('the employee sees A\'s, never C\'s — even with C forged into the context', async () => {
    const real = await ctxFor(employee);
    const view = await loadPortfolio(real);
    expect((await loadOpportunities(real, view)).map((e) => [e.organizationId, e.opportunities.map((o) => o.kind)]))
      .toEqual([[A, ['campaigns_paying_back']]]);
    const forged: PortfolioContext = {
      ...real,
      organisations: [...real.organisations, { id: C, slug: 'gamma', name: 'Gamma', status: 'active', role: 'employee' }],
      organisationIds: [...real.organisationIds, C],
    };
    const forgedView = await loadPortfolio(forged);
    expect((await loadOpportunities(forged, forgedView, [C]))).toEqual([]);
    expect((await loadOpportunities(forged, forgedView)).map((e) => e.organizationId)).toEqual([A]);
  });

  it('the super admin sees A\'s and C\'s; the database function gives a stranger, and A\'s own owner, nothing', async () => {
    const admin = await ctxFor(superAdmin);
    const view = await loadPortfolio(admin);
    // A super admin sees every organisation in the database; this file's own are A, C (and B, without one).
    const ours = new Set([A, B, C, D, E]);
    expect((await loadOpportunities(admin, view)).map((e) => e.organizationId).filter((id) => ours.has(id)).sort()).toEqual([A, C].sort());
    const { data, error } = await rpc(clientFor(stranger, { email: `stranger@${DOMAIN}` }),
      'portfolio_health_breakdowns', { p_orgs: [A, B, C] });
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
    // A's own owner: a company login, so no portfolio — A's breakdown is not served to them here.
    const own = await rpc(clientFor(ownerAB, { email: `owner-ab@${DOMAIN}` }),
      'portfolio_health_breakdowns', { p_orgs: [A] });
    expect(own.error).toBeNull();
    expect(own.data ?? []).toEqual([]);
  });
});

describe('the portfolio report covers the caller\'s portfolio and nothing else (ADR-149)', () => {
  it('the employee\'s report is A and B, attention first; the super admin\'s includes C', async () => {
    const report = await loadPortfolioReport(await ctxFor(employee));
    expect(report.clients.map((c) => c.organizationId)).toEqual([A, B]);
    expect(report.clients[0]!.attention.length).toBeGreaterThan(0);
    expect(report.counts.clients).toBe(2);
    const admin = await loadPortfolioReport(await ctxFor(superAdmin));
    expect(admin.clients.map((c) => c.organizationId)).toEqual(expect.arrayContaining([A, B, C]));
  });
});
