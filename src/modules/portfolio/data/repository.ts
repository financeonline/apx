import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type { ActionPriority, ActionStatus } from '@/modules/actions';
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
 * Transport (ADR-117, audit F-5). Every read is an RPC — a POST — and none carries the portfolio's
 * ids in a URL, where 201 organisations overflowed the gateway (414). `orgIds === null` means "every
 * organisation the caller advises": the database derives that scope itself (`app.portfolio_scope`,
 * from `app.adviser_org_ids()`), so the overview sends no list at all. A list narrows the scope and
 * is intersected with it; it can never widen it. Like every `api.*` function the reads are
 * definers, and they read only rows of that scope — derived from `app.accessible_org_roles()`, the
 * resolver every RLS policy reads. None loops per organisation.
 *
 * PostgREST's `max_rows` (1,000 locally) is never relied on: every detail read is capped at or
 * below it in the statement, and the aggregate — one row per organisation — is read in pages of
 * 1,000 in organisation order until a short page, so a portfolio of any size is read whole.
 */

export const ALERT_DETAIL_CAP = 500;
export const ACTION_DETAIL_CAP = 500;
export const RECENT_CAP = 50;
/** PostgREST's row cap; a paged read asks for exactly this many rows at a time. */
export const PAGE_ROWS = 1_000;

/** `null`: the whole adviser scope, derived in the database. A list narrows it (one client's page). */
export type Scope = readonly string[] | null;
const scopeArg = (orgIds: Scope) => (orgIds === null ? null : [...orgIds]);

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
  db: SupabaseClient, orgIds: Scope, today: string, dueSoonUntil: string, requestId?: string,
): Promise<Map<string, OrganisationSummary>> {
  if (orgIds !== null && orgIds.length === 0) return new Map();
  const rows: SummaryRow[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await db.schema('api').rpc('portfolio_summary', {
      p_orgs: scopeArg(orgIds), p_today: today, p_due_soon_until: dueSoonUntil,
    }).order('organization_id').range(from, from + PAGE_ROWS - 1);
    const page = unwrap(data as SummaryRow[] | null, error, requestId);
    rows.push(...page);
    if (page.length < PAGE_ROWS) break;
  }
  return summaries(rows);
}

function summaries(rows: readonly SummaryRow[]): Map<string, OrganisationSummary> {
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
  last_evaluated_at: string; action_id: string | null; evidence_bundle_id: string | null;
}

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
    evidenceBundleId: row.evidence_bundle_id,
    actionId: row.action_id,
  };
}

/** Standing alerts to SHOW: severity (the enum orders critical first), then oldest, then id. */
export async function loadStandingAlerts(
  db: SupabaseClient, orgIds: Scope, limit = ALERT_DETAIL_CAP, requestId?: string,
): Promise<PortfolioAlert[]> {
  if (orgIds !== null && orgIds.length === 0) return [];
  const { data, error } = await db.schema('api').rpc('portfolio_standing_alerts', { p_orgs: scopeArg(orgIds), p_limit: limit });
  return unwrap(data as AlertRow[] | null, error, requestId).map(toAlert);
}

/** Alerts first seen since `sinceIso`, newest first — the "recent changes" feed only. */
export async function loadRecentAlerts(
  db: SupabaseClient, orgIds: Scope, sinceIso: string, requestId?: string,
): Promise<PortfolioAlert[]> {
  if (orgIds !== null && orgIds.length === 0) return [];
  const { data, error } = await db.schema('api').rpc('portfolio_recent_alerts', { p_orgs: scopeArg(orgIds), p_since: sinceIso, p_limit: RECENT_CAP });
  return unwrap(data as AlertRow[] | null, error, requestId).map(toAlert);
}

// ---------------------------------------------------------------------------------------------
// Action detail: filtered IN THE STATEMENT by lens, ordered as `byUrgency` orders
// ---------------------------------------------------------------------------------------------

interface ActionRow {
  id: string; organization_id: string; title: string; priority: ActionPriority; status: ActionStatus;
  owner_user_id: string | null; due_date: string | null; source_type: string;
  evidence_bundle_id: string | null; created_at: string; completed_at: string | null; updated_at: string;
}

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

/**
 * Open actions in one lens. The lens is a predicate in the statement (`api.portfolio_open_actions`)
 * — the same predicates `api.portfolio_summary` counts with; `mine` is the caller, `app.uid()`.
 * Order is `byUrgency`: priority (the enum orders critical first), due date with undated last, oldest.
 */
export async function loadOpenActions(
  db: SupabaseClient,
  orgIds: Scope,
  lens: OpenLens,
  context: { today: string; dueSoonUntil: string },
  limit = ACTION_DETAIL_CAP,
  requestId?: string,
): Promise<PortfolioAction[]> {
  if (orgIds !== null && orgIds.length === 0) return [];
  const { data, error } = await db.schema('api').rpc('portfolio_open_actions', {
    p_orgs: scopeArg(orgIds), p_lens: lens, p_today: context.today, p_due_soon_until: context.dueSoonUntil, p_limit: limit,
  });
  return unwrap(data as ActionRow[] | null, error, requestId).map(toAction);
}

/** Work finished since `sinceIso`, newest first, for "recent changes". */
export async function loadRecentlyFinishedActions(
  db: SupabaseClient, orgIds: Scope, sinceIso: string, requestId?: string,
): Promise<PortfolioAction[]> {
  if (orgIds !== null && orgIds.length === 0) return [];
  const { data, error } = await db.schema('api').rpc('portfolio_finished_actions', { p_orgs: scopeArg(orgIds), p_since: sinceIso, p_limit: RECENT_CAP });
  return unwrap(data as ActionRow[] | null, error, requestId).map(toAction);
}
