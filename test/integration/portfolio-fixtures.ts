import { auth } from '@/db/firestore';
import { periodWindow } from '@/db/app/org-create';
import { ensurePeriods, periodId } from '@/db/app/shared';
import { globalRow, newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import { deleteOrg, fs } from './setup';

/**
 * Fixtures for the Command Centre suites (portfolio, portfolio-scale, portfolio-transport), written
 * straight to the emulator in the shapes FIRESTORE_DATA_MODEL.md §3 gives — what the SQL fixtures
 * inserted with `adminSql`. Organisations are seeded here rather than through `api.create_organization`
 * (throttled to three a day per person) so a suite can hold hundreds; each gets the same twelve
 * months back and twelve forward of fiscal periods that creating one does.
 */

/** An organisation document with the table's defaults, and its fiscal periods. */
export async function seedOrg(name: string, options: { slug?: string; periods?: boolean } = {}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await fs().collection('organizations').doc(id).set(orgDoc(id, name, options.slug ?? `itest-${id.slice(0, 18)}`, now));
  if (options.periods !== false) {
    const { from, to } = periodWindow();
    await ensurePeriods(fs(), id, from, to);
  }
  return id;
}

export function orgDoc(id: string, name: string, slug: string, now = nowIso()): Record<string, unknown> {
  return {
    id, slug, name, legal_name: null, country_code: 'GB', base_currency: 'GBP', fiscal_year_start_month: 1,
    industry: null, kind: 'customer', status: 'active', plan: 'trial', features: {}, settings: {},
    timezone: 'Europe/London', deletion_requested_at: null, created_by: null, deleted_at: null,
    created_at: now, updated_at: now,
  };
}

export async function addMember(org: string, user: string, role: string): Promise<void> {
  const now = nowIso();
  await orgRow(fs(), org, 'organization_memberships', user).set({
    id: newId(), organization_id: org, user_id: user, role, status: 'active', invited_by: null,
    joined_at: now, created_at: now, updated_at: now, departments: null, departments_set_by_owner: false,
  });
}

/** An active, in-window assignment; the document id is the employee (FIRESTORE_DATA_MODEL.md §3). */
export function assignmentDoc(org: string, employee: string): Record<string, unknown> {
  const now = nowIso();
  return {
    id: newId(), organization_id: org, employee_user_id: employee, assigned_by: null, grantor_organization_id: null,
    status: 'active', starts_at: null, ends_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    revoked_by: null, revoked_reason: null, created_at: now, updated_at: now,
  };
}

export async function assign(org: string, employee: string): Promise<void> {
  await orgRow(fs(), org, 'organization_assignments', employee).set(assignmentDoc(org, employee));
}

export async function setAssignmentStatus(org: string, employee: string, status: string): Promise<void> {
  await orgRow(fs(), org, 'organization_assignments', employee).update({ status, updated_at: nowIso() });
}

export async function platformUser(user: string, role: 'super_admin' | 'employee', status = 'active'): Promise<void> {
  const now = nowIso();
  await globalRow(fs(), 'platform_users', user).set({
    user_id: user, platform_role: role, status, granted_by: null, notes: null, created_at: now, updated_at: now,
  });
}

export const periodOf = (org: string, start: string): string => periodId(org, start);

/** Every fiscal period start of `org`, oldest first. */
export async function periodStarts(org: string): Promise<string[]> {
  const snap = await orgCollection(fs(), org, 'fiscal_periods').get();
  return snap.docs.map((d) => String(d.get('period_start'))).sort();
}

export async function seedRun(org: string, period: string): Promise<string> {
  const id = newId();
  const now = nowIso();
  await orgRow(fs(), org, 'calculation_runs', id).set({
    id, organization_id: org, trigger: 'recalc_manual', engine_version: '1.0.0', period_from: period,
    period_to: period, as_of: '2026-09-15', status: 'succeeded', started_at: now, finished_at: now,
    created_at: now, updated_at: now,
  });
  return id;
}

export function healthScoreDoc(
  org: string, period: string, run: string, score: number | null, breakdown: unknown[] = [],
): Record<string, unknown> {
  return {
    id: newId(), organization_id: org, period_id: period, calculation_run_id: run, score,
    dimensions_used: 5, dimensions_total: 6, breakdown, config_version: 'health.config.v1', created_at: nowIso(),
  };
}

/** A health score for one month, made current, with the month marked complete. */
export async function seedScore(org: string, period: string, run: string, score: number | null): Promise<string> {
  const doc = healthScoreDoc(org, period, run, score);
  const id = String(doc.id);
  await orgRow(fs(), org, 'health_scores', id).set(doc);
  await orgRow(fs(), org, 'fiscal_periods', period).update({ is_complete: true });
  await orgRow(fs(), org, 'health_current', period).set({
    organization_id: org, period_id: period, health_score_id: id, calculation_run_id: run,
    previous_health_score_id: null, updated_at: nowIso(),
  });
  return id;
}

export function alertDoc(
  org: string, period: string, run: string, severity: string, title: string,
  options: { status?: string; firstSeenAt?: string; dedupe?: string } = {},
): Record<string, unknown> {
  const now = nowIso();
  const seen = options.firstSeenAt ?? now;
  return {
    id: newId(), organization_id: org, rule_key: 'cash.decline', rule_version: '1', severity, metric_key: null,
    period_id: period, subject_type: 'none', subject_id: null, title, explanation: 'seeded', threshold_summary: {},
    recommended_next_step: null, current_revision_id: null, status: options.status ?? 'open', status_changed_by: null,
    status_changed_at: null, status_reason_code: 'user', status_reason: null, action_id: null,
    dedupe_key: options.dedupe ?? newId(), key_kind: 'state', calculation_run_id: run, first_seen_at: seen,
    reopened_at: null, dismissed_at: null, last_evaluated_at: seen, created_at: seen, updated_at: seen,
  };
}

export function actionDoc(
  org: string, title: string, priority: string, due: string | null,
  options: { status?: string; owner?: string | null; createdAt?: string } = {},
): Record<string, unknown> {
  const now = nowIso();
  const created = options.createdAt ?? now;
  const status = options.status ?? 'open';
  return {
    id: newId(), organization_id: org, title, issue: null, recommendation: null, priority,
    owner_user_id: options.owner ?? null, due_date: due, status, source_type: 'user', source_id: null,
    evidence_bundle_id: null, outcome_notes: null, outcome_value: null, outcome_currency: null,
    completed_at: status === 'completed' ? now : null, dismissed_reason: null, created_by: null,
    created_at: created, updated_at: status === 'completed' ? now : created,
  };
}

/** Writes many documents of one org table at once. */
export async function writeAll(org: string, table: 'alerts' | 'actions' | 'health_scores' | 'health_current', docs: Record<string, unknown>[], idOf: (d: Record<string, unknown>) => string = (d) => String(d.id)): Promise<void> {
  const writer = fs().bulkWriter();
  for (const d of docs) void writer.set(orgRow(fs(), org, table, idOf(d)), d);
  await writer.close();
}

/** Removes what a suite created: its organisations, its people's profiles, platform rows and logins. */
export async function cleanup(orgIds: readonly string[], users: readonly string[]): Promise<void> {
  for (const org of orgIds) await deleteOrg(org);
  for (const u of users) {
    await fs().collection('profiles').doc(u).delete();
    await fs().collection('platform_users').doc(u).delete();
  }
  if (users.length > 0) await auth().deleteUsers([...users]);
}
