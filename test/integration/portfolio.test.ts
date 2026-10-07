import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { isMotionError } from '@/core/errors';
import {
  loadOpportunities, loadPortfolio, loadPortfolioActions, loadPortfolioAlerts, loadPortfolioReport, resolvePortfolioContext,
  type PortfolioContext, type PortfolioView,
} from '@/modules/portfolio';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * The Command Centre's boundary (ADR-112 §2, §4; brief §7, §8, §18, §19).
 *
 * Five callers, five organisations. What each may see is asserted at three layers that must agree:
 * the resolver (who has a portfolio, and over which organisations), the read model (what the
 * portfolio's own statements return for them), and the database (what RLS returns when the
 * resolver is BYPASSED and a foreign organisation's id is put straight into the statement — the
 * adversarial path). A count that leaked across that line would fail here before any page saw it.
 */

const RUN = `pf${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.portfolio.itest`;
const one = (s: string) => adminSql(`with q as (${s}) select * from q`).trim();

let ownerAB: string; let employee: string; let superAdmin: string; let clientC: string; let clientOnly: string; let stranger: string; let adminD: string;
let A: string; let B: string; let C: string; let D: string; let E: string;
const named = new Map<string, string>();

async function createOrg(who: string, name: string): Promise<string> {
  const r = await clientFor(who).schema('api').rpc('create_organization', { p_name: name });
  if (r.error) throw new Error(r.error.message);
  const id = r.data as unknown as string;
  named.set(id, name);
  return id;
}

const period = (org: string) => one(`select id from public.fiscal_periods where organization_id='${org}' and period_start='2026-07-01'`);
const olderPeriod = (org: string) => one(`select id from public.fiscal_periods where organization_id='${org}' and period_start='2026-06-01'`);

function seedRun(org: string, periodId: string): string {
  return one(`insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
    values ('${org}','recalc_manual','1.0.0','${periodId}','${periodId}','2026-09-15','succeeded') returning id`);
}
function seedScore(org: string, periodId: string, runId: string, score: number | null) {
  const id = one(`insert into public.health_scores (organization_id, period_id, calculation_run_id, score, dimensions_used, dimensions_total, breakdown, config_version)
    values ('${org}','${periodId}','${runId}',${score === null ? 'null' : score},5,6,'[]'::jsonb,'health.config.v1') returning id`);
  adminSql(`update public.fiscal_periods set is_complete = true where id='${periodId}'`);
  adminSql(`insert into public.health_current (organization_id, period_id, health_score_id, calculation_run_id) values ('${org}','${periodId}','${id}','${runId}')`);
}
function seedAlert(org: string, periodId: string, runId: string, severity: string, title: string, status = 'open') {
  return one(`insert into public.alerts (organization_id, period_id, rule_key, rule_version, severity, key_kind, calculation_run_id, title, explanation, status, first_seen_at, dedupe_key)
    values ('${org}','${periodId}','cash.decline','1','${severity}','state','${runId}','${title}','seeded','${status}',now() - interval '3 days','${RUN}-${title}') returning id`);
}
function seedAction(org: string, title: string, priority: string, due: string | null, status = 'open', owner: string | null = null) {
  return one(`insert into public.actions (organization_id, title, priority, due_date, status, source_type, owner_user_id${status === 'completed' ? ', completed_at' : ''})
    values ('${org}','${title}','${priority}',${due === null ? 'null' : `'${due}'`},'${status}','user',${owner === null ? 'null' : `'${owner}'`}${status === 'completed' ? ', now()' : ''}) returning id`);
}

const ctxFor = async (user: string): Promise<PortfolioContext> => {
  const db = clientFor(user, { email: `${user}@${DOMAIN}` });
  const ctx = await resolvePortfolioContext(db, user, `itest-${RUN}`);
  return { ...ctx, now: () => new Date('2026-09-15T12:00:00Z') };
};

beforeAll(async () => {
  ownerAB = createAuthUser(`owner-ab@${DOMAIN}`);
  adminD = createAuthUser(`admin-d@${DOMAIN}`);
  clientC = createAuthUser(`client-c@${DOMAIN}`);
  employee = createAuthUser(`employee@${DOMAIN}`);
  superAdmin = createAuthUser(`super@${DOMAIN}`);
  stranger = createAuthUser(`stranger@${DOMAIN}`);
  clientOnly = createAuthUser(`client-only@${DOMAIN}`);
  adminSql(`insert into public.platform_users (user_id, platform_role) values ('${employee}','employee'), ('${superAdmin}','super_admin')`);

  A = await createOrg(ownerAB, `PF Alpha ${RUN}`);
  B = await createOrg(ownerAB, `PF Beta ${RUN}`);
  C = await createOrg(adminD, `PF Gamma ${RUN}`);   // adminD owns C; clientC is a client of C
  D = await createOrg(clientC, `PF Delta ${RUN}`);  // clientC owns D — a mixed-role person
  E = await createOrg(adminD, `PF Epsilon ${RUN}`);   // adminD owns E too; nobody else reaches it but the super admin

  adminSql(`insert into public.organization_memberships (organization_id, user_id, role, status) values ('${C}','${clientC}','client','active'), ('${C}','${clientOnly}','client','active')`);
  adminSql(`insert into public.organization_memberships (organization_id, user_id, role, status) values ('${D}','${adminD}','admin','active')`);
  adminSql(`insert into public.organization_assignments (organization_id, employee_user_id) values ('${A}','${employee}'), ('${B}','${employee}')`);

  // Facts, written the way the jobs write them.
  for (const [org, score, prev] of [[A, 35, 62], [B, 85, 84], [C, 50, 50]] as const) {
    const earlier = seedRun(org, olderPeriod(org));
    seedScore(org, olderPeriod(org), earlier, prev);
    const run = seedRun(org, period(org));
    seedScore(org, period(org), run, score);
    named.set(`run:${org}`, run);
  }
  seedAlert(A, period(A), named.get(`run:${A}`)!, 'critical', 'A critical');
  seedAlert(A, period(A), named.get(`run:${A}`)!, 'high', 'A high');
  seedAlert(A, period(A), named.get(`run:${A}`)!, 'medium', 'A resolved', 'resolved');
  seedAlert(B, period(B), named.get(`run:${B}`)!, 'low', 'B low');
  seedAlert(C, period(C), named.get(`run:${C}`)!, 'critical', 'C critical');
  seedAction(A, 'A overdue', 'medium', '2026-09-01');
  seedAction(A, 'A undated urgent', 'critical', null, 'open', employee);
  seedAction(B, 'B done', 'low', null, 'completed');
  seedAction(C, 'C overdue', 'high', '2026-08-01');
}, 120_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id in ('${A}','${B}','${C}','${D}','${E}');
            delete from public.platform_users where user_id in ('${employee}','${superAdmin}');
            delete from auth.users where email like '%@${DOMAIN}';`);
});

const names = (ctx: PortfolioContext) => ctx.organisations.map((o) => o.name).sort();
/** The capped detail lists, as the alerts and actions pages read them. */
async function details(ctx: PortfolioContext, view: PortfolioView) {
  const [alerts, actions] = await Promise.all([loadPortfolioAlerts(ctx, view), loadPortfolioActions(ctx, view, 'attention')]);
  return { alerts: alerts.rows, actions: actions.rows };
}

describe('who has a portfolio, and over what (ADR-112 §2)', () => {
  it('an employee: assigned organisations only', async () => {
    const ctx = await ctxFor(employee);
    expect(names(ctx)).toEqual([named.get(A), named.get(B)]);
    expect(ctx.organisations.every((o) => o.role === 'employee')).toBe(true);
  });

  it('an owner of two organisations: both, as owner', async () => {
    const ctx = await ctxFor(ownerAB);
    expect(names(ctx)).toEqual([named.get(A), named.get(B)]);
  });

  it('an admin: the organisation they administer and the one they own', async () => {
    const ctx = await ctxFor(adminD);
    expect(names(ctx)).toEqual([named.get(C), named.get(D), named.get(E)].sort());
  });

  it('a client of C who owns D sees D only: a client membership advises nothing', async () => {
    const ctx = await ctxFor(clientC);
    expect(names(ctx)).toEqual([named.get(D)]);
  });

  it('a super admin sees every organisation', async () => {
    const ctx = await ctxFor(superAdmin);
    for (const org of [A, B, C, D, E]) expect(ctx.organisationIds).toContain(org);
  });

  it('a stranger, and a client-only member, get NOT_FOUND — the same answer', async () => {
    await expect(ctxFor(stranger)).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'NOT_FOUND');
    await expect(ctxFor(clientOnly)).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'NOT_FOUND');
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
    const ctx = await ctxFor(ownerAB);
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

  it('the same for the owner of D forging E, an organisation they are no member of, into their portfolio', async () => {
    const real = await ctxFor(clientC);
    const forged: PortfolioContext = {
      ...real,
      organisations: [...real.organisations, { id: E, slug: 'epsilon', name: 'Epsilon', status: 'active', role: 'owner' }],
      organisationIds: [...real.organisationIds, E],
    };
    adminSql(`insert into public.actions (organization_id, title, priority, status, source_type) values ('${E}','E secret','critical','open','user')`);
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
    adminSql(`update public.organization_assignments set status='revoked' where organization_id='${B}' and employee_user_id='${employee}'`);
    try {
      const ctx = await ctxFor(employee);
      expect(names(ctx)).toEqual([named.get(A)]);
      const view = await loadPortfolio(ctx);
      expect(view.counts.clients).toBe(1);
      expect((await details(ctx, view)).alerts.some((a) => a.organizationId === B)).toBe(false);
      // And with A revoked too, the employee has an EMPTY Command Centre (ADR-114 §6) — no organisation,
      // no count, no row — not a 404.
      adminSql(`update public.organization_assignments set status='revoked' where organization_id='${A}' and employee_user_id='${employee}'`);
      const empty = await ctxFor(employee);
      expect(empty.organisations).toEqual([]);
      const emptyView = await loadPortfolio(empty);
      expect(emptyView.counts.clients).toBe(0);
      expect(emptyView.counts.criticalAlerts).toBe(0);
    } finally {
      adminSql(`update public.organization_assignments set status='active' where employee_user_id='${employee}'`);
    }
  });
});

describe('an eligible employee with no assignment has an empty Command Centre (ADR-114 §6)', () => {
  let unassigned: string;
  beforeAll(() => {
    unassigned = createAuthUser(`unassigned@${DOMAIN}`);
    adminSql(`insert into public.platform_users (user_id, platform_role) values ('${unassigned}','employee')`);
  });
  afterAll(() => { adminSql(`delete from public.platform_users where user_id='${unassigned}'`); });

  it('an empty portfolio — no organisation, no count — not the uniform 404', async () => {
    const ctx = await ctxFor(unassigned);
    expect(ctx.organisations).toEqual([]);
    const view = await loadPortfolio(ctx);
    expect(view.counts).toMatchObject({ clients: 0, criticalAlerts: 0, openActions: 0, needingAttention: 0 });
    expect(view.clients).toEqual([]);
  });

  it('a suspended platform account: NOT_FOUND', async () => {
    adminSql(`update public.platform_users set status='suspended' where user_id='${unassigned}'`);
    try {
      await expect(ctxFor(unassigned)).rejects.toSatisfy((e) => isMotionError(e) && e.code === 'NOT_FOUND');
    } finally {
      adminSql(`update public.platform_users set status='active' where user_id='${unassigned}'`);
    }
  });
});

describe('advisory opportunities follow the same boundary (ADR-148)', () => {
  // A's and C's latest months carry a marketing score of 80: "campaigns paying back" for both.
  const marketing = `'[{"key":"marketing_efficiency","included":true,"score":80,"rules":[{"rule":"M1","points":20,"result":">= 3x","value":"3.2","skipped_reason":null}]}]'::jsonb`;
  beforeAll(() => {
    adminSql(`set session_replication_role = replica;
      update public.health_scores set breakdown = ${marketing}
       where id in (select health_score_id from public.health_current where organization_id in ('${A}','${C}') and period_id in ('${period(A)}','${period(C)}'));`);
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

  it('the super admin sees A\'s and C\'s; the database function gives a stranger nothing', async () => {
    const admin = await ctxFor(superAdmin);
    const view = await loadPortfolio(admin);
    // A super admin sees every organisation in the database; this file's own are A, C (and B, without one).
    const ours = new Set([A, B, C, D, E]);
    expect((await loadOpportunities(admin, view)).map((e) => e.organizationId).filter((id) => ours.has(id)).sort()).toEqual([A, C].sort());
    const { data, error } = await clientFor(stranger, { email: `stranger@${DOMAIN}` }).schema('api')
      .rpc('portfolio_health_breakdowns', { p_orgs: [A, B, C] });
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
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
