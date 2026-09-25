import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  ALERT_DETAIL_CAP, loadPortfolio, loadPortfolioActions, loadPortfolioAlerts, resolvePortfolioContext,
  truncationNote, type PortfolioContext,
} from '@/modules/portfolio';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * The Command Centre at scale (ADR-114; audit of bab3a68, HIGH-A and HIGH-B).
 *
 * HIGH-A: counts and attention reasons were derived from a detail list capped at 1,000 rows,
 * newest first — 3 critical alerts older than 1,050 newer ones vanished from the counts, from their
 * client's row and from the attention queue. HIGH-B: health was read unordered and unpaginated, so
 * PostgREST's `max_rows` (1,000) silently dropped scored months — 45 clients with 24 scored months
 * showed 6 as "Not yet scored".
 *
 * Organisations are created by one person each (`create_organization` is throttled per person) and
 * the portfolio holder is added as their admin: an admin advises (ADR-112).
 */

const RUN = `ps${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.portfolioscale.itest`;
const one = (s: string) => adminSql(`with q as (${s}) select * from q`).trim();

let adviser: string; let healthAdviser: string; let stranger: string;
let X: string; let Y: string; let Z: string;
const big: string[] = [];
const all: string[] = [];
const edge: Record<'none' | 'one' | 'gap' | 'incomplete', string> = { none: '', one: '', gap: '', incomplete: '' };

async function orgFor(holder: string, name: string): Promise<string> {
  const creator = createAuthUser(`creator-${all.length}@${DOMAIN}`);
  const r = await clientFor(creator).schema('api').rpc('create_organization', { p_name: name });
  if (r.error) throw new Error(r.error.message);
  const id = r.data as unknown as string;
  all.push(id);
  if (holder !== '') adminSql(`insert into public.organization_memberships (organization_id, user_id, role, status) values ('${id}','${holder}','admin','active')`);
  return id;
}

const ctxFor = async (user: string): Promise<PortfolioContext> => {
  const ctx = await resolvePortfolioContext(clientFor(user, { email: `${user}@${DOMAIN}` }), user, `itest-${RUN}`);
  return { ...ctx, now: () => new Date('2026-09-15T12:00:00Z') };
};

function seedAlerts(org: string, n: number, severity: string, ageDays: number) {
  const p = one(`select id from public.fiscal_periods where organization_id='${org}' and period_start='2026-08-01'`);
  const run = one(`insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status) values ('${org}','recalc_manual','1.0.0','${p}','${p}','2026-09-15','succeeded') returning id`);
  adminSql(`insert into public.alerts (organization_id, period_id, rule_key, rule_version, severity, key_kind, calculation_run_id, title, explanation, status, first_seen_at, dedupe_key)
    select '${org}','${p}','cash.decline','1','${severity}','state','${run}','${severity} ' || g,'seeded','open',
           now() - interval '${ageDays} days' + (g || ' seconds')::interval,'${RUN}-${org}-${severity}-' || g
      from generate_series(1, ${n}) g`);
}

function seedActions(org: string, n: number, priority: string, due: string | null, ageDays: number) {
  adminSql(`insert into public.actions (organization_id, title, priority, due_date, status, source_type, created_at)
    select '${org}', '${priority} action ' || g, '${priority}', ${due === null ? 'null' : `'${due}'`}, 'open', 'user',
           now() - interval '${ageDays} days' + (g || ' seconds')::interval
      from generate_series(1, ${n}) g`);
}

/** Score every complete month of `org`; `score(periodStart)` returns the score or null to skip the month. */
function scoreMonths(org: string, complete: 'all' | 'past', score: (periodStart: string) => number | null) {
  adminSql(`update public.fiscal_periods set is_complete = ${complete === 'all' ? 'true' : `(period_start < '2026-09-01')`} where organization_id='${org}'`);
  const periods = adminSql(`select id || '|' || period_start from public.fiscal_periods where organization_id='${org}' order by period_start`)
    .split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('|') as [string, string]);
  const run = one(`insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
    values ('${org}','recalc_manual','1.0.0','${periods[0]![0]}','${periods[periods.length - 1]![0]}','2026-09-15','succeeded') returning id`);
  const values = periods.flatMap(([id, start]) => {
    const s = score(start);
    return s === null ? [] : [`('${org}','${id}','${run}',${s},5,6,'[]'::jsonb,'health.config.v1')`];
  });
  if (values.length === 0) return;
  adminSql(`with s as (insert into public.health_scores (organization_id, period_id, calculation_run_id, score, dimensions_used, dimensions_total, breakdown, config_version)
      values ${values.join(',')} returning id, period_id, calculation_run_id)
    insert into public.health_current (organization_id, period_id, health_score_id, calculation_run_id) select '${org}', period_id, id, calculation_run_id from s`);
}

beforeAll(async () => {
  adviser = createAuthUser(`adviser@${DOMAIN}`);
  healthAdviser = createAuthUser(`health-adviser@${DOMAIN}`);
  stranger = createAuthUser(`stranger@${DOMAIN}`);

  // ---- HIGH-A: X holds 1,050 NEW low alerts and 1,020 NEW low actions; Y's serious facts are OLD ----
  X = await orgFor(adviser, `PS X ${RUN}`);
  Y = await orgFor(adviser, `PS Y ${RUN}`);
  Z = await orgFor(stranger, `PS Z unauthorised ${RUN}`);
  seedAlerts(X, 1050, 'low', 1);
  seedAlerts(Y, 3, 'critical', 60);
  seedAlerts(Z, 200, 'critical', 90);
  seedActions(X, 1020, 'low', null, 1);
  seedActions(Y, 2, 'medium', '2026-08-01', 60);
  seedActions(Y, 1, 'critical', '2026-12-01', 60);
  seedActions(Z, 300, 'critical', '2026-01-01', 90);

  // ---- HIGH-B: 45 clients, 24 complete months each; the latest month At risk, the one before Stable ----
  for (let i = 0; i < 45; i += 1) {
    const org = await orgFor(healthAdviser, `PS Health ${String(i).padStart(2, '0')} ${RUN}`);
    big.push(org);
    scoreMonths(org, 'all', (start) => (start === '2027-08-01' ? 35 : 70));
  }
  // Edge cases, same portfolio.
  edge.none = await orgFor(healthAdviser, `PS Edge none ${RUN}`);
  edge.one = await orgFor(healthAdviser, `PS Edge one ${RUN}`);
  scoreMonths(edge.one, 'past', (start) => (start === '2026-08-01' ? 64 : null));
  edge.gap = await orgFor(healthAdviser, `PS Edge gap ${RUN}`);
  // The latest complete month (Aug 2026) has no score; Jul and Jun do.
  scoreMonths(edge.gap, 'past', (start) => (start === '2026-07-01' ? 58 : start === '2026-06-01' ? 81 : null));
  edge.incomplete = await orgFor(healthAdviser, `PS Edge incomplete ${RUN}`);
  // A score written for an INCOMPLETE month is not the latest complete month's.
  scoreMonths(edge.incomplete, 'past', (start) => (start === '2026-10-01' ? 12 : start === '2026-08-01' ? 77 : start === '2026-07-01' ? 76 : null));
}, 900_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id in (${all.map((o) => `'${o}'`).join(',')});
            delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('HIGH-A — counts and attention come from the full population, not a capped list', () => {
  it('1,053 standing alerts: every count is complete, and Y\'s old critical alerts still count', async () => {
    const view = await loadPortfolio(await ctxFor(adviser));
    expect(view.counts.criticalAlerts).toBe(3);
    expect(view.counts.alertsStanding).toBe(1053);
    const y = view.clients.find((c) => c.organisation.id === Y)!;
    expect(y.counts.alertsStanding).toBe(3);
    expect(y.counts.alertsCritical).toBe(3);
  });

  it('Y is in the attention queue, first, with the critical-alert reason', async () => {
    const view = await loadPortfolio(await ctxFor(adviser));
    expect(view.attention[0]?.organisation.id).toBe(Y);
    expect(view.attention[0]!.attention!.reasons.map((r) => r.label)).toContain('3 critical alerts');
  });

  it('1,023 open actions: every count is complete, and Y\'s old overdue and urgent actions still count', async () => {
    const view = await loadPortfolio(await ctxFor(adviser));
    expect(view.counts.openActions).toBe(1023);
    expect(view.counts.overdueActions).toBe(2);
    expect(view.counts.urgentActions).toBe(1);
    const y = view.clients.find((c) => c.organisation.id === Y)!;
    expect(y.attention!.reasons.map((r) => [r.kind, r.count])).toEqual(expect.arrayContaining([['overdue_action', 2], ['urgent_action', 1]]));
  });

  it('a capped detail list keeps the complete total, puts the worst first, and says it is capped', async () => {
    const ctx = await ctxFor(adviser);
    const view = await loadPortfolio(ctx);
    const alerts = await loadPortfolioAlerts(ctx, view);
    expect(alerts.rows).toHaveLength(ALERT_DETAIL_CAP);
    expect(alerts.total).toBe(1053);
    expect(alerts.truncated).toBe(true);
    expect(alerts.rows.slice(0, 3).map((a) => [a.organizationId, a.severity])).toEqual([[Y, 'critical'], [Y, 'critical'], [Y, 'critical']]);
    expect(truncationNote(alerts, 'worst first')).toMatch(/Showing the first 500 of 1,053/);

    const overdue = await loadPortfolioActions(ctx, view, 'overdue');
    expect(overdue.rows.map((a) => a.organizationId)).toEqual([Y, Y]);
    expect(overdue.total).toBe(2);
    expect(overdue.truncated).toBe(false);
    const open = await loadPortfolioActions(ctx, view, 'attention');
    expect(open.total).toBe(1023);
    expect(open.truncated).toBe(true);
    // `byUrgency`: the one critical action leads the list, although it is among the oldest.
    expect(open.rows[0]).toMatchObject({ organizationId: Y, priority: 'critical' });
  });

  it('an unauthorised organisation with hundreds of critical alerts and overdue actions changes nothing', async () => {
    const view = await loadPortfolio(await ctxFor(adviser));
    expect(view.clients.some((c) => c.organisation.id === Z)).toBe(false);
    expect(view.counts.criticalAlerts).toBe(3);
    expect(view.counts.overdueActions).toBe(2);
  });
});

describe('HIGH-B — health for every client, from its latest two complete scored months', () => {
  it('45 clients × 24 scored months: none shows "Not yet scored"; each has the right latest and previous month', async () => {
    const view = await loadPortfolio(await ctxFor(healthAdviser));
    const rows = view.clients.filter((c) => big.includes(c.organisation.id));
    expect(rows).toHaveLength(45);
    expect(rows.filter((c) => c.health === null)).toEqual([]);
    for (const row of rows) {
      expect(row.health).toMatchObject({ periodStart: '2027-08-01', score: 35, band: 'at_risk', previous: { periodStart: '2027-07-01', score: 70, band: 'stable' } });
      expect(row.attention!.reasons.map((r) => r.kind)).toEqual(expect.arrayContaining(['health_band_fell', 'health_at_risk']));
    }
    expect(view.attention.filter((c) => big.includes(c.organisation.id))).toHaveLength(45);
  });

  it('edge cases: none, one, a gap, and a score on an incomplete month', async () => {
    const view = await loadPortfolio(await ctxFor(healthAdviser));
    const of = (id: string) => view.clients.find((c) => c.organisation.id === id)!;
    // No scored month: no health — an absence, never a zero.
    expect(of(edge.none).health).toBeNull();
    // One scored month: that month, no previous, no trend.
    expect(of(edge.one).health).toMatchObject({ periodStart: '2026-08-01', score: 64, previous: null });
    expect(of(edge.one).trend).toBeNull();
    // The latest complete month is unscored: the latest SCORED complete month stands, with its own previous.
    expect(of(edge.gap).health).toMatchObject({ periodStart: '2026-07-01', score: 58, previous: { periodStart: '2026-06-01', score: 81 } });
    expect(of(edge.gap).attention!.reasons.map((r) => r.kind)).toEqual(expect.arrayContaining(['health_band_fell']));
    // A score on an incomplete month is ignored.
    expect(of(edge.incomplete).health).toMatchObject({ periodStart: '2026-08-01', score: 77, previous: { periodStart: '2026-07-01', score: 76 } });
    expect(view.counts.unscored).toBe(1);
  });
});
