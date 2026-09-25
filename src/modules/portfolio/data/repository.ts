import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { OPEN_STATUSES, type ActionPriority, type ActionStatus } from '@/modules/actions';
import type { AlertSeverity } from '@/modules/alerts';
import { bandFor } from '@/modules/health';
import type { ClientCounts, PortfolioAction, PortfolioAlert, PortfolioHealth } from '../domain/types';

/**
 * The Command Centre's reads (ADR-112 §3, ADR-114).
 *
 * Two kinds, kept apart on purpose:
 *
 *  - AGGREGATES — `api.portfolio_summary`: every count the portfolio states, and each client's health
 *    for its latest two complete scored months, computed in ONE statement over the full population.
 *    Nothing in it is capped, and nothing a page counts comes from anywhere else. Its scope is
 *    `orgs ∩ app.adviser_org_ids()`, so a forged id returns no row.
 *  - DETAIL LISTS — alerts and actions to show, each explicitly ordered and capped. A cap limits what
 *    is SHOWN; the list travels with the authoritative total so the page can say so.
 *
 * Every statement carries the authorised ids and runs under the caller's RLS; none loops per
 * organisation. PostgREST's `max_rows` (1,000 locally) is never relied on: every detail read sets a
 * limit at or below it, and the aggregate returns one row per organisation.
 */

export const ALERT_DETAIL_CAP = 500;
export const ACTION_DETAIL_CAP = 500;
export const RECENT_CAP = 50;

function unwrap<T>(data: T[] | null, error: unknown, requestId?: string): T[] {
  if (error) throw toMotionError(error, requestId);
  return data ?? [];
}

// ---------------------------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------------------------

interface SummaryRow {
  organization_id: string;
  alerts_standing: number; alerts_critical: number; alerts_high: number;
  actions_open: number; actions_overdue: number; actions_due_soon: number;
  actions_urgent: number; actions_urgent_on_time: number; actions_mine: number;
  health_score_id: string | null; health_period_id: string | null; health_period_start: string | null;
  health_period_label: string | null; health_score: number | null;
  health_dimensions_used: number | null; health_dimensions_total: number | null;
  previous_period_start: string | null; previous_period_label: string | null; previous_score: number | null;
}

export interface OrganisationSummary {
  readonly organizationId: string;
  readonly counts: ClientCounts;
  readonly health: PortfolioHealth | null;
}

export async function loadPortfolioSummary(
  db: SupabaseClient, orgIds: readonly string[], today: string, dueSoonUntil: string, requestId?: string,
): Promise<Map<string, OrganisationSummary>> {
  if (orgIds.length === 0) return new Map();
  const { data, error } = await db.schema('api').rpc('portfolio_summary', {
    p_orgs: [...orgIds], p_today: today, p_due_soon_until: dueSoonUntil,
  });
  const rows = unwrap(data as SummaryRow[] | null, error, requestId);
  return new Map(rows.map((row) => [row.organization_id, {
    organizationId: row.organization_id,
    counts: {
      alertsStanding: row.alerts_standing,
      alertsCritical: row.alerts_critical,
      alertsHigh: row.alerts_high,
      actionsOpen: row.actions_open,
      actionsOverdue: row.actions_overdue,
      actionsDueSoon: row.actions_due_soon,
      actionsUrgent: row.actions_urgent,
      actionsUrgentOnTime: row.actions_urgent_on_time,
      actionsMine: row.actions_mine,
    },
    health: row.health_score_id === null ? null : {
      organizationId: row.organization_id,
      scoreId: row.health_score_id,
      periodId: row.health_period_id!,
      periodStart: row.health_period_start!,
      periodLabel: row.health_period_label!,
      score: row.health_score,
      band: bandFor(row.health_score),
      dimensionsUsed: row.health_dimensions_used ?? 0,
      dimensionsTotal: row.health_dimensions_total ?? 0,
      previous: row.previous_period_start === null ? null : {
        periodStart: row.previous_period_start,
        periodLabel: row.previous_period_label!,
        score: row.previous_score,
        band: bandFor(row.previous_score),
      },
    },
  }]));
}

// ---------------------------------------------------------------------------------------------
// Alert detail: worst first, then longest standing (the alert engine's own order, §8.3)
// ---------------------------------------------------------------------------------------------

interface AlertRow {
  id: string; organization_id: string; rule_key: string; severity: AlertSeverity;
  status: 'open' | 'acknowledged'; title: string; period_id: string; first_seen_at: string;
  last_evaluated_at: string; action_id: string | null;
  alert_revisions: { evidence_bundle_id: string | null } | null;
}

const ALERT_SELECT = 'id, organization_id, rule_key, severity, status, title, period_id, first_seen_at, last_evaluated_at, action_id, alert_revisions!alerts_current_revision_fk (evidence_bundle_id)';

function toAlert(row: AlertRow): PortfolioAlert {
  return {
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
  };
}

/** Standing alerts to SHOW: severity (the enum orders critical first), then oldest, then id. */
export async function loadStandingAlerts(
  db: SupabaseClient, orgIds: readonly string[], limit = ALERT_DETAIL_CAP, requestId?: string,
): Promise<PortfolioAlert[]> {
  if (orgIds.length === 0) return [];
  const { data, error } = await db.from('alerts')
    .select(ALERT_SELECT)
    .in('organization_id', [...orgIds])
    .in('status', ['open', 'acknowledged'])
    .order('severity', { ascending: true })
    .order('first_seen_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);
  return unwrap(data as unknown as AlertRow[] | null, error, requestId).map(toAlert);
}

/** Alerts first seen since `sinceIso`, newest first — the "recent changes" feed only. */
export async function loadRecentAlerts(
  db: SupabaseClient, orgIds: readonly string[], sinceIso: string, requestId?: string,
): Promise<PortfolioAlert[]> {
  if (orgIds.length === 0) return [];
  const { data, error } = await db.from('alerts')
    .select(ALERT_SELECT)
    .in('organization_id', [...orgIds])
    .in('status', ['open', 'acknowledged'])
    .gte('first_seen_at', sinceIso)
    .order('first_seen_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(RECENT_CAP);
  return unwrap(data as unknown as AlertRow[] | null, error, requestId).map(toAlert);
}

// ---------------------------------------------------------------------------------------------
// Action detail: filtered IN THE STATEMENT by lens, ordered as `byUrgency` orders
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

/** The Action Centre's open-work lenses, as statement predicates (ADR-098; `domain/views.ts`). */
export type OpenLens = 'attention' | 'overdue' | 'due_soon' | 'high' | 'mine';

export async function loadOpenActions(
  db: SupabaseClient,
  orgIds: readonly string[],
  lens: OpenLens,
  context: { today: string; dueSoonUntil: string; userId: string },
  limit = ACTION_DETAIL_CAP,
  requestId?: string,
): Promise<PortfolioAction[]> {
  if (orgIds.length === 0) return [];
  let query = db.from('actions')
    .select(ACTION_SELECT)
    .in('organization_id', [...orgIds])
    .in('status', [...OPEN_STATUSES]);
  if (lens === 'overdue') query = query.lt('due_date', context.today);
  if (lens === 'due_soon') query = query.gte('due_date', context.today).lte('due_date', context.dueSoonUntil);
  if (lens === 'high') query = query.in('priority', ['critical', 'high']);
  if (lens === 'mine') query = query.eq('owner_user_id', context.userId);
  // `byUrgency`: priority (the enum orders critical first), then due date with undated last, then oldest.
  const { data, error } = await query
    .order('priority', { ascending: true })
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);
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
    .order('id', { ascending: true })
    .limit(RECENT_CAP);
  return unwrap(data as unknown as ActionRow[] | null, error, requestId).map(toAction);
}
