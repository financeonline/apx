import 'server-only';
import type { DocumentData, Query } from 'firebase-admin/firestore';
import { arg, type DbFunctions } from '../registry';
import { acrossOrgs, orgCollection, orgRow, type OrgTable } from '../schema';
import { uidOf, type Db } from '../types';
import { adviserOrgIds } from '../app/access';

/**
 * `api.portfolio_*` — the Command Centre's reads across the companies an adviser looks after
 * (ADR-112, ADR-114), ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8).
 *
 * The scope is the SQL's `app.portfolio_scope(p_orgs)`: the organisations where the caller is
 * platform staff (`super_admin` or an assigned `employee`) — `adviserOrgIds` — narrowed to `p_orgs`
 * when given. A company admin holds no portfolio, so for anyone else every function returns
 * nothing, as it did.
 *
 * The rows come from collection-group queries (`acrossOrgs`) restricted to that scope with
 * `organization_id in (…)`. A Firestore query takes at most 30 disjunctions, so the scope is read in
 * chunks sized for the status list it is combined with. Ordering on enum ranks (priority, severity)
 * and the row caps are applied in TypeScript, after the merge, exactly as the SQL ordered.
 */

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const OPEN_ACTION = ['open', 'in_progress'];
const FINISHED_ACTION = ['completed', 'dismissed'];
const STANDING_ALERT = ['open', 'acknowledged'];

/** `app.portfolio_scope(p_orgs)`. */
async function scopeOf(db: Db, args: Record<string, unknown>): Promise<string[]> {
  const only = arg.arr<string>(args, 'p_orgs');
  return adviserOrgIds(db.fs, uidOf(db), only);
}

/** `least(greatest(coalesce(p_limit, fallback), 0), 500)`. */
function capOf(args: Record<string, unknown>, fallback: number): number {
  return Math.min(Math.max(arg.num(args, 'p_limit') ?? fallback, 0), 500);
}

/**
 * Every row of `table` in the scope whose `status` is one of `statuses`; `refine` adds a range
 * and order the index supports (the caller merges and re-orders the chunks).
 */
async function scopedRows(
  db: Db, table: OrgTable, orgIds: readonly string[], statuses: readonly string[], refine?: (q: Query) => Query,
): Promise<DocumentData[]> {
  if (orgIds.length === 0) return [];
  const size = Math.max(1, Math.floor(30 / statuses.length));
  const chunks: string[][] = [];
  for (let i = 0; i < orgIds.length; i += size) chunks.push(orgIds.slice(i, i + size));
  const snaps = await Promise.all(chunks.map((chunk) => {
    const q = acrossOrgs(db.fs, table).where('organization_id', 'in', chunk).where('status', 'in', [...statuses]);
    return (refine ? refine(q) : q).get();
  }));
  return snaps.flatMap((s) => s.docs.map((d) => d.data()));
}

const cmp = (a: unknown, b: unknown): number => {
  const x = a as string | number;
  const y = b as string | number;
  return x < y ? -1 : x > y ? 1 : 0;
};
/** `order by x asc nulls last`. */
const cmpNullsLast = (a: unknown, b: unknown): number => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return cmp(a, b);
};

function actionRow(a: DocumentData): Record<string, unknown> {
  return {
    id: a.id, organization_id: a.organization_id, title: a.title, priority: a.priority, status: a.status,
    owner_user_id: a.owner_user_id ?? null, due_date: a.due_date ?? null, source_type: a.source_type,
    evidence_bundle_id: a.evidence_bundle_id ?? null, created_at: a.created_at,
    completed_at: a.completed_at ?? null, updated_at: a.updated_at,
  };
}

/** `api.portfolio_finished_actions`: actions completed or dismissed since a time, newest first. */
async function portfolio_finished_actions(db: Db, args: Record<string, unknown>): Promise<unknown[]> {
  const scope = await scopeOf(db, args);
  const since = arg.str(args, 'p_since');
  const cap = capOf(args, 50);
  if (cap === 0) return [];
  const rows = await scopedRows(db, 'actions', scope, FINISHED_ACTION, (q) => {
    const ranged = since ? q.where('updated_at', '>=', new Date(since).toISOString()) : q;
    return ranged.orderBy('updated_at', 'desc').limit(cap);
  });
  return rows.sort((a, b) => cmp(b.updated_at, a.updated_at) || cmp(a.id, b.id)).slice(0, cap).map(actionRow);
}

/** One `p_lens` of the open-actions list. */
function inLens(a: DocumentData, lens: string | null, today: string | null, until: string | null, uid: string | null): boolean {
  const due = (a.due_date as string | null | undefined) ?? null;
  switch (lens) {
    case 'attention': return true;
    case 'overdue': return due !== null && today !== null && due < today;
    case 'due_soon': return due !== null && today !== null && until !== null && due >= today && due <= until;
    case 'high': return a.priority === 'critical' || a.priority === 'high';
    case 'mine': return uid !== null && a.owner_user_id === uid;
    default: return false;
  }
}

/** `api.portfolio_open_actions`: the open actions under one lens, most urgent first. */
async function portfolio_open_actions(db: Db, args: Record<string, unknown>): Promise<unknown[]> {
  const scope = await scopeOf(db, args);
  const lens = arg.str(args, 'p_lens');
  const today = arg.str(args, 'p_today');
  const until = arg.str(args, 'p_due_soon_until');
  const cap = capOf(args, 500);
  const uid = uidOf(db);
  const rows = (await scopedRows(db, 'actions', scope, OPEN_ACTION)).filter((a) => inLens(a, lens, today, until, uid));
  return rows
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
      || cmpNullsLast(a.due_date, b.due_date) || cmp(a.created_at, b.created_at) || cmp(a.id, b.id))
    .slice(0, cap)
    .map(actionRow);
}

/** The alert rows with their current revision's evidence bundle (the SQL's left join). */
async function alertRows(db: Db, alerts: DocumentData[]): Promise<Record<string, unknown>[]> {
  const withRevision = alerts.filter((a) => typeof a.current_revision_id === 'string' && a.current_revision_id);
  const revisions = withRevision.length
    ? await db.fs.getAll(...withRevision.map((a) => orgRow(db.fs, a.organization_id, 'alert_revisions', a.current_revision_id)))
    : [];
  const bundle = new Map(revisions.filter((r) => r.exists)
    .map((r) => [`${r.get('organization_id')}:${r.id}`, (r.get('evidence_bundle_id') as string | null) ?? null]));
  return alerts.map((a) => ({
    id: a.id, organization_id: a.organization_id, rule_key: a.rule_key, severity: a.severity, status: a.status,
    title: a.title, period_id: a.period_id, first_seen_at: a.first_seen_at, last_evaluated_at: a.last_evaluated_at,
    action_id: a.action_id ?? null,
    evidence_bundle_id: a.current_revision_id ? (bundle.get(`${a.organization_id}:${a.current_revision_id}`) ?? null) : null,
  }));
}

/** `api.portfolio_recent_alerts`: standing alerts first seen since a time, newest first. */
async function portfolio_recent_alerts(db: Db, args: Record<string, unknown>): Promise<unknown[]> {
  const scope = await scopeOf(db, args);
  const since = arg.str(args, 'p_since');
  const cap = capOf(args, 50);
  if (cap === 0) return [];
  const rows = await scopedRows(db, 'alerts', scope, STANDING_ALERT, (q) => {
    const ranged = since ? q.where('first_seen_at', '>=', new Date(since).toISOString()) : q;
    return ranged.orderBy('first_seen_at', 'desc').limit(cap);
  });
  const page = rows.sort((a, b) => cmp(b.first_seen_at, a.first_seen_at) || cmp(a.id, b.id)).slice(0, cap);
  return alertRows(db, page);
}

/** `api.portfolio_standing_alerts`: every standing alert, most severe and oldest first. */
async function portfolio_standing_alerts(db: Db, args: Record<string, unknown>): Promise<unknown[]> {
  const scope = await scopeOf(db, args);
  const cap = capOf(args, 500);
  const rows = await scopedRows(db, 'alerts', scope, STANDING_ALERT);
  const page = rows
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
      || cmp(a.first_seen_at, b.first_seen_at) || cmp(a.id, b.id))
    .slice(0, cap);
  return alertRows(db, page);
}

interface ScoredMonth {
  readonly organization_id: string;
  readonly score: DocumentData;
  readonly period: DocumentData;
}

/**
 * Each organisation's scored, COMPLETE months, newest first: `health_current` joined to its score
 * and its fiscal period (`p.is_complete`), the SQL's `row_number() over (… order by period_start desc)`.
 */
async function scoredMonths(db: Db, orgIds: readonly string[]): Promise<Map<string, ScoredMonth[]>> {
  const out = new Map<string, ScoredMonth[]>();
  if (orgIds.length === 0) return out;
  const chunks: string[][] = [];
  for (let i = 0; i < orgIds.length; i += 30) chunks.push(orgIds.slice(i, i + 30));
  const current = (await Promise.all(chunks.map((c) => acrossOrgs(db.fs, 'health_current')
    .where('organization_id', 'in', c).get()))).flatMap((s) => s.docs.map((d) => d.data()));
  if (current.length === 0) return out;
  const [scores, periods] = await Promise.all([
    db.fs.getAll(...current.map((h) => orgRow(db.fs, h.organization_id, 'health_scores', String(h.health_score_id)))),
    db.fs.getAll(...current.map((h) => orgRow(db.fs, h.organization_id, 'fiscal_periods', String(h.period_id)))),
  ]);
  current.forEach((h, i) => {
    const s = scores[i]!;
    const p = periods[i]!;
    if (!s.exists || !p.exists || p.get('is_complete') !== true) return;
    const list = out.get(h.organization_id) ?? [];
    list.push({ organization_id: h.organization_id, score: s.data()!, period: p.data()! });
    out.set(h.organization_id, list);
  });
  for (const list of out.values()) list.sort((a, b) => cmp(b.period.period_start, a.period.period_start));
  return out;
}

/** `api.portfolio_health_breakdowns`: each company's latest complete month's score, dimension by dimension. */
async function portfolio_health_breakdowns(db: Db, args: Record<string, unknown>): Promise<unknown[]> {
  const scope = await scopeOf(db, args);
  const months = await scoredMonths(db, scope);
  const latest = [...months.values()].map((list) => list[0]!).sort((a, b) => cmp(a.organization_id, b.organization_id));
  const bundles = await Promise.all(latest.map((l) => orgCollection(db.fs, l.organization_id, 'evidence_bundles')
    .where('kind', '==', 'health_score').where('origin_table', '==', 'health_scores')
    .where('origin_id', '==', l.score.id).limit(1).get()));
  return latest.map((l, i) => {
    const breakdown = Array.isArray(l.score.breakdown) ? (l.score.breakdown as Array<Record<string, unknown>>) : [];
    return {
      organization_id: l.organization_id,
      health_score_id: l.score.id,
      period_label: l.period.label,
      config_version: l.score.config_version,
      evidence_bundle_id: bundles[i]!.empty ? null : (bundles[i]!.docs[0]!.get('id') as string),
      dimensions: breakdown.map((d) => ({
        key: d.key == null ? null : String(d.key),
        included: d.included == null ? null : d.included === true || d.included === 'true',
        score: d.score ?? null,
        rules: (Array.isArray(d.rules) ? (d.rules as Array<Record<string, unknown>>) : []).map((r) => ({
          rule: r.rule == null ? null : String(r.rule),
          points: r.points ?? null,
          result: r.result == null ? null : String(r.result),
          value: r.value == null ? null : typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value),
          skipped: r.skipped_reason == null ? null : String(r.skipped_reason),
        })),
      })),
    };
  });
}

/**
 * `api.portfolio_summary`: one row per company in scope — its standing alerts, open actions and
 * latest complete health score, with the month before when it was scored on the same config.
 */
async function portfolio_summary(db: Db, args: Record<string, unknown>): Promise<unknown[]> {
  const scope = await scopeOf(db, args);
  const today = arg.str(args, 'p_today');
  const until = arg.str(args, 'p_due_soon_until');
  const uid = uidOf(db);
  const [alerts, actions, months] = await Promise.all([
    scopedRows(db, 'alerts', scope, STANDING_ALERT),
    scopedRows(db, 'actions', scope, OPEN_ACTION),
    scoredMonths(db, scope),
  ]);

  const counts = new Map<string, Record<string, number>>();
  const bump = (org: string, key: string) => {
    const c = counts.get(org) ?? {};
    c[key] = (c[key] ?? 0) + 1;
    counts.set(org, c);
  };
  for (const a of alerts) {
    bump(a.organization_id, 'standing');
    if (a.severity === 'critical') bump(a.organization_id, 'critical');
    if (a.severity === 'high') bump(a.organization_id, 'high');
  }
  for (const a of actions) {
    const org = a.organization_id as string;
    const due = (a.due_date as string | null | undefined) ?? null;
    const overdue = due !== null && today !== null && due < today;
    const urgent = a.priority === 'critical' || a.priority === 'high';
    bump(org, 'open');
    if (overdue) bump(org, 'overdue');
    if (due !== null && today !== null && until !== null && due >= today && due <= until) bump(org, 'due_soon');
    if (urgent) bump(org, 'urgent');
    if (urgent && !overdue) bump(org, 'urgent_on_time');
    if (uid !== null && a.owner_user_id === uid) bump(org, 'mine');
  }

  return [...scope].sort(cmp).map((org) => {
    const c = counts.get(org) ?? {};
    const list = months.get(org) ?? [];
    const h1 = list[0] ?? null;
    const h2 = h1 && list[1] && list[1].score.config_version === h1.score.config_version ? list[1] : null;
    return {
      organization_id: org,
      alerts_standing: c.standing ?? 0, alerts_critical: c.critical ?? 0, alerts_high: c.high ?? 0,
      actions_open: c.open ?? 0, actions_overdue: c.overdue ?? 0, actions_due_soon: c.due_soon ?? 0,
      actions_urgent: c.urgent ?? 0, actions_urgent_on_time: c.urgent_on_time ?? 0, actions_mine: c.mine ?? 0,
      health_score_id: h1?.score.id ?? null,
      health_period_id: h1?.period.id ?? null,
      health_period_start: h1?.period.period_start ?? null,
      health_period_label: h1?.period.label ?? null,
      health_score: h1?.score.score ?? null,
      health_dimensions_used: h1?.score.dimensions_used ?? null,
      health_dimensions_total: h1?.score.dimensions_total ?? null,
      previous_period_start: h2?.period.period_start ?? null,
      previous_period_label: h2?.period.label ?? null,
      previous_score: h2?.score.score ?? null,
    };
  });
}

/** `api.*` functions of this area, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8). */
export const functions: DbFunctions = {
  portfolio_finished_actions,
  portfolio_health_breakdowns,
  portfolio_open_actions,
  portfolio_recent_alerts,
  portfolio_standing_alerts,
  portfolio_summary,
};
