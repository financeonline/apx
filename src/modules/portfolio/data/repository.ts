import { callApi } from '@/core/db/api-rpc';
import type { Db } from '@/db/types';
import type { ActionPriority, ActionStatus } from '@/modules/actions';
import type { AlertSeverity } from '@/modules/alerts';
import { bandFor } from '@/modules/health';
import type { ClientCounts, PortfolioAction, PortfolioAlert, PortfolioHealth } from '../domain/types';
import type { ClientBreakdown } from '../domain/opportunities';

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
 * Transport (ADR-117, audit F-5). Every read is an `api.*` function (`callApi`, in process — no
 * portfolio ids ever travel in a URL, where 201 organisations once overflowed the gateway). `orgIds
 * === null` means "every organisation the caller advises": the function derives that scope itself
 * (`adviserOrgIds`, the port of `app.portfolio_scope`), so the overview sends no list at all. A list
 * narrows the scope and is intersected with it; it can never widen it. The functions read only rows
 * of that scope — derived from `accessibleOrgRoles`, the resolver every read policy uses.
 *
 * No row cap is relied on: every detail read is capped in the function, and the aggregate — one
 * row per organisation — comes back whole, so a portfolio of any size is read whole
 * (`src/db/api/portfolio.ts`).
 */

export const ALERT_DETAIL_CAP = 500;
export const ACTION_DETAIL_CAP = 500;
export const RECENT_CAP = 50;

/** `null`: the whole adviser scope, derived in the database. A list narrows it (one client's page). */
export type Scope = readonly string[] | null;
const scopeArg = (orgIds: Scope) => (orgIds === null ? null : [...orgIds]);

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
  db: Db, orgIds: Scope, today: string, dueSoonUntil: string, requestId?: string,
): Promise<Map<string, OrganisationSummary>> {
  if (orgIds !== null && orgIds.length === 0) return new Map();
  const rows = await callApi<SummaryRow[]>(db, 'portfolio_summary', {
    p_orgs: scopeArg(orgIds), p_today: today, p_due_soon_until: dueSoonUntil,
  }, requestId);
  return summaries(rows ?? []);
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
  db: Db, orgIds: Scope, limit = ALERT_DETAIL_CAP, requestId?: string,
): Promise<PortfolioAlert[]> {
  if (orgIds !== null && orgIds.length === 0) return [];
  const rows = await callApi<AlertRow[]>(db, 'portfolio_standing_alerts', { p_orgs: scopeArg(orgIds), p_limit: limit }, requestId);
  return (rows ?? []).map(toAlert);
}

/** Alerts first seen since `sinceIso`, newest first — the "recent changes" feed only. */
export async function loadRecentAlerts(
  db: Db, orgIds: Scope, sinceIso: string, requestId?: string,
): Promise<PortfolioAlert[]> {
  if (orgIds !== null && orgIds.length === 0) return [];
  const rows = await callApi<AlertRow[]>(db, 'portfolio_recent_alerts', { p_orgs: scopeArg(orgIds), p_since: sinceIso, p_limit: RECENT_CAP }, requestId);
  return (rows ?? []).map(toAlert);
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
  db: Db,
  orgIds: Scope,
  lens: OpenLens,
  context: { today: string; dueSoonUntil: string },
  limit = ACTION_DETAIL_CAP,
  requestId?: string,
): Promise<PortfolioAction[]> {
  if (orgIds !== null && orgIds.length === 0) return [];
  const rows = await callApi<ActionRow[]>(db, 'portfolio_open_actions', {
    p_orgs: scopeArg(orgIds), p_lens: lens, p_today: context.today, p_due_soon_until: context.dueSoonUntil, p_limit: limit,
  }, requestId);
  return (rows ?? []).map(toAction);
}

/** Work finished since `sinceIso`, newest first, for "recent changes". */
export async function loadRecentlyFinishedActions(
  db: Db, orgIds: Scope, sinceIso: string, requestId?: string,
): Promise<PortfolioAction[]> {
  if (orgIds !== null && orgIds.length === 0) return [];
  const rows = await callApi<ActionRow[]>(db, 'portfolio_finished_actions', { p_orgs: scopeArg(orgIds), p_since: sinceIso, p_limit: RECENT_CAP }, requestId);
  return (rows ?? []).map(toAction);
}

// ---------------------------------------------------------------------------------------------
// Advisory opportunities (ADR-148): the latest complete month's breakdown, per client
// ---------------------------------------------------------------------------------------------

interface BreakdownRow {
  organization_id: string; health_score_id: string; period_label: string; config_version: string;
  evidence_bundle_id: string | null;
  dimensions: Array<{ key: string; included: boolean; score: number | null; rules: Array<{
    rule: string; points: number | null; result: string | null; value: string | null; skipped: string | null;
  }> }>;
}

export async function loadHealthBreakdowns(
  db: Db, orgIds: Scope, requestId?: string,
): Promise<ClientBreakdown[]> {
  if (orgIds !== null && orgIds.length === 0) return [];
  const rows = await callApi<BreakdownRow[]>(db, 'portfolio_health_breakdowns', { p_orgs: scopeArg(orgIds) }, requestId);
  return (rows ?? []).map((r) => ({
    organizationId: r.organization_id, healthScoreId: r.health_score_id, periodLabel: r.period_label,
    configVersion: r.config_version, evidenceBundleId: r.evidence_bundle_id,
    dimensions: (r.dimensions ?? []).map((d) => ({
      key: d.key, included: d.included === true, score: typeof d.score === 'number' ? d.score : null,
      rules: (d.rules ?? []).map((x) => ({
        rule: x.rule, points: typeof x.points === 'number' ? x.points : null, result: x.result ?? null,
        value: x.value ?? null, skipped: x.skipped ?? null,
      })),
    })),
  }));
}
