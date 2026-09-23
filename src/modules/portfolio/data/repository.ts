import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { OPEN_STATUSES, type ActionPriority, type ActionStatus } from '@/modules/actions';
import type { AlertSeverity } from '@/modules/alerts';
import { bandFor } from '@/modules/health';
import type { PortfolioAction, PortfolioAlert, PortfolioHealth } from '../domain/types';

/**
 * The Command Centre's reads (ADR-112 §4).
 *
 * Every function takes the AUTHORISED organisation ids and puts them in the statement, and every
 * statement also runs under the caller's RLS. The list is the resolver's (`services/access.ts`);
 * RLS is the database's own boundary; a row must pass both. Nothing here selects across
 * organisations and filters afterwards, and nothing here loops per organisation: forty clients are
 * the same five statements as four (UX §9.4).
 *
 * The caps are the portfolio's, not the organisation's: an adviser's queue is bounded by what a
 * person can act on, and a portfolio that raised more than a thousand open alerts is a fact the
 * counts state rather than a list anybody would read.
 */

export const ALERT_CAP = 1000;
export const ACTION_CAP = 1000;
export const RECENT_CAP = 50;

function unwrap<T>(data: T[] | null, error: unknown, requestId?: string): T[] {
  if (error) throw toMotionError(error, requestId);
  return data ?? [];
}

// ---------------------------------------------------------------------------------------------
// Health: the latest two complete months per organisation
// ---------------------------------------------------------------------------------------------

interface HealthRow {
  organization_id: string;
  period_id: string;
  health_scores: { id: string; score: number | null; dimensions_used: number; dimensions_total: number } | null;
}
interface PeriodRow { id: string; organization_id: string; period_start: string; label: string; is_complete: boolean }

export async function loadPortfolioHealth(
  db: SupabaseClient, orgIds: readonly string[], requestId?: string,
): Promise<Map<string, PortfolioHealth>> {
  if (orgIds.length === 0) return new Map();
  const [scores, periods] = await Promise.all([
    db.from('health_current')
      .select('organization_id, period_id, health_scores!health_current_score_fk!inner (id, score, dimensions_used, dimensions_total)')
      .in('organization_id', [...orgIds]),
    db.from('fiscal_periods')
      .select('id, organization_id, period_start, label, is_complete')
      .in('organization_id', [...orgIds])
      .eq('is_complete', true),
  ]);
  const periodById = new Map(
    unwrap(periods.data as unknown as PeriodRow[] | null, periods.error, requestId).map((p) => [p.id, p]),
  );

  // Complete, scored months per organisation, newest first.
  const byOrg = new Map<string, Array<{ period: PeriodRow; row: HealthRow }>>();
  for (const row of unwrap(scores.data as unknown as HealthRow[] | null, scores.error, requestId)) {
    const period = periodById.get(row.period_id);
    if (period === undefined || row.health_scores === null) continue;
    const list = byOrg.get(row.organization_id) ?? [];
    list.push({ period, row });
    byOrg.set(row.organization_id, list);
  }

  const out = new Map<string, PortfolioHealth>();
  for (const [organizationId, list] of byOrg) {
    list.sort((a, b) => b.period.period_start.localeCompare(a.period.period_start));
    const [latest, previous] = list;
    if (latest === undefined) continue;
    out.set(organizationId, {
      organizationId,
      scoreId: latest.row.health_scores!.id,
      periodId: latest.period.id,
      periodStart: latest.period.period_start,
      periodLabel: latest.period.label,
      score: latest.row.health_scores!.score,
      band: bandFor(latest.row.health_scores!.score),
      dimensionsUsed: latest.row.health_scores!.dimensions_used,
      dimensionsTotal: latest.row.health_scores!.dimensions_total,
      previous: previous === undefined ? null : {
        periodStart: previous.period.period_start,
        periodLabel: previous.period.label,
        score: previous.row.health_scores!.score,
        band: bandFor(previous.row.health_scores!.score),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Alerts still standing
// ---------------------------------------------------------------------------------------------

interface AlertRow {
  id: string; organization_id: string; rule_key: string; severity: AlertSeverity;
  status: 'open' | 'acknowledged'; title: string; period_id: string; first_seen_at: string;
  last_evaluated_at: string; action_id: string | null;
  alert_revisions: { evidence_bundle_id: string | null } | null;
}

export async function loadStandingAlerts(
  db: SupabaseClient, orgIds: readonly string[], requestId?: string,
): Promise<PortfolioAlert[]> {
  if (orgIds.length === 0) return [];
  const { data, error } = await db.from('alerts')
    .select('id, organization_id, rule_key, severity, status, title, period_id, first_seen_at, last_evaluated_at, action_id, alert_revisions!alerts_current_revision_fk (evidence_bundle_id)')
    .in('organization_id', [...orgIds])
    .in('status', ['open', 'acknowledged'])
    .order('first_seen_at', { ascending: false })
    .limit(ALERT_CAP);
  return unwrap(data as unknown as AlertRow[] | null, error, requestId).map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    ruleKey: row.rule_key,
    severity: row.severity,
    status: row.status,
    title: row.title,
    periodId: row.period_id,
    firstSeenAt: row.first_seen_at,
    lastEvaluatedAt: row.last_evaluated_at,
    evidenceBundleId: row.alert_revisions?.evidence_bundle_id ?? null,
    actionId: row.action_id,
  }));
}

// ---------------------------------------------------------------------------------------------
// Actions: open work, and work recently finished
// ---------------------------------------------------------------------------------------------

interface ActionRow {
  id: string; organization_id: string; title: string; priority: ActionPriority; status: ActionStatus;
  owner_user_id: string | null; due_date: string | null; source_type: string;
  evidence_bundle_id: string | null; created_at: string; completed_at: string | null; updated_at: string;
}

const ACTION_SELECT = 'id, organization_id, title, priority, status, owner_user_id, due_date, source_type, evidence_bundle_id, created_at, completed_at, updated_at';

function toAction(row: ActionRow): PortfolioAction {
  return {
    id: row.id,
    organizationId: row.organization_id,
    title: row.title,
    priority: row.priority,
    status: row.status,
    ownerUserId: row.owner_user_id,
    dueDate: row.due_date,
    sourceType: row.source_type,
    evidenceBundleId: row.evidence_bundle_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

export async function loadOpenActions(
  db: SupabaseClient, orgIds: readonly string[], requestId?: string,
): Promise<PortfolioAction[]> {
  if (orgIds.length === 0) return [];
  const { data, error } = await db.from('actions')
    .select(ACTION_SELECT)
    .in('organization_id', [...orgIds])
    .in('status', [...OPEN_STATUSES])
    .order('created_at', { ascending: false })
    .limit(ACTION_CAP);
  return unwrap(data as unknown as ActionRow[] | null, error, requestId).map(toAction);
}

/** Work finished since `sinceIso`, newest first, for "recent changes". */
export async function loadRecentlyFinishedActions(
  db: SupabaseClient, orgIds: readonly string[], sinceIso: string, requestId?: string,
): Promise<PortfolioAction[]> {
  if (orgIds.length === 0) return [];
  const { data, error } = await db.from('actions')
    .select(ACTION_SELECT)
    .in('organization_id', [...orgIds])
    .in('status', ['completed', 'dismissed'])
    .gte('updated_at', sinceIso)
    .order('updated_at', { ascending: false })
    .limit(RECENT_CAP);
  return unwrap(data as unknown as ActionRow[] | null, error, requestId).map(toAction);
}
