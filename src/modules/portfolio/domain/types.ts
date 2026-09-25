/**
 * The Command Centre's view model (SOW §18; PHASE_15_IMPLEMENTATION.md; ADR-112).
 *
 * Every figure here is a PROJECTION of a row another module already wrote — a health score the
 * engine scored, an alert the alert job raised, an action somebody opened. Nothing is computed from
 * financial records: the portfolio counts, sorts and labels; it never sums money.
 */

import type { ActionPriority, ActionStatus } from '@/modules/actions';
import type { AlertSeverity } from '@/modules/alerts';
import type { HealthBand } from '@/modules/health';

/** The roles whose holders may open the Command Centre (ADR-112). A client is not one of them. */
export const ADVISER_ROLES = ['super_admin', 'employee', 'owner', 'admin'] as const;
export type AdviserRole = (typeof ADVISER_ROLES)[number];

export type OrganisationStatus = 'active' | 'suspended' | 'pending_deletion';

/** One organisation the caller may advise, as the access resolver returns it. */
export interface PortfolioOrganisation {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: OrganisationStatus;
  readonly role: AdviserRole;
}

/** The health score of the latest complete month, and the one before it, for the trend. */
export interface PortfolioHealth {
  readonly organizationId: string;
  readonly scoreId: string;
  readonly periodId: string;
  readonly periodStart: string;
  readonly periodLabel: string;
  readonly score: number | null;
  readonly band: HealthBand | null;
  readonly dimensionsUsed: number;
  readonly dimensionsTotal: number;
  readonly previous: {
    readonly periodStart: string;
    readonly periodLabel: string;
    readonly score: number | null;
    readonly band: HealthBand | null;
  } | null;
}

export type AlertStanding = 'open' | 'acknowledged';

export interface PortfolioAlert {
  readonly id: string;
  readonly organizationId: string;
  readonly ruleKey: string;
  readonly severity: AlertSeverity;
  readonly status: AlertStanding;
  readonly title: string;
  readonly periodId: string;
  readonly firstSeenAt: string;
  readonly lastEvaluatedAt: string;
  readonly evidenceBundleId: string | null;
  readonly actionId: string | null;
}

export interface PortfolioAction {
  readonly id: string;
  readonly organizationId: string;
  readonly title: string;
  readonly priority: ActionPriority;
  readonly status: ActionStatus;
  readonly ownerUserId: string | null;
  readonly dueDate: string | null;
  readonly sourceType: string;
  readonly evidenceBundleId: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

/**
 * Why an organisation is in the attention queue. Each reason is a fact another module established;
 * the weight is the fixed order the queue sorts by (`attention.ts`), never a score of its own.
 */
export type AttentionReasonKind =
  | 'critical_alert'
  | 'health_band_fell'
  | 'health_at_risk'
  | 'overdue_action'
  | 'high_alert'
  | 'health_score_fell'
  | 'urgent_action'
  | 'health_needs_attention'
  | 'organisation_suspended';

export interface AttentionReason {
  readonly kind: AttentionReasonKind;
  readonly weight: number;
  /** Plain-language, already resolved: "2 critical alerts", "Health fell from Stable to At risk". */
  readonly label: string;
  /** How many facts stand behind the reason (alerts, actions); 1 for a state. */
  readonly count: number;
}

export interface AttentionEntry {
  readonly organizationId: string;
  readonly reasons: readonly AttentionReason[];
  /** The heaviest reason's weight, then the sum: the deterministic sort key. */
  readonly rank: readonly [number, number];
}

/**
 * One client's authoritative counts, from `api.portfolio_summary` over the FULL population
 * (ADR-114). Never derived from a capped detail list.
 */
export interface ClientCounts {
  readonly alertsStanding: number;
  readonly alertsCritical: number;
  readonly alertsHigh: number;
  readonly actionsOpen: number;
  readonly actionsOverdue: number;
  readonly actionsDueSoon: number;
  /** Critical/high priority, open — the Action Centre's `high` lens. */
  readonly actionsUrgent: number;
  /** The same, not overdue — the attention queue's `urgent_action` reason. */
  readonly actionsUrgentOnTime: number;
  readonly actionsMine: number;
}

export interface ClientRow {
  readonly organisation: PortfolioOrganisation;
  readonly health: PortfolioHealth | null;
  readonly trend: 'up' | 'down' | 'flat' | null;
  readonly counts: ClientCounts;
  readonly attention: AttentionEntry | null;
  /** The most recent change inside the recent window, when one is in the recent list. */
  readonly latestChange: RecentChange | null;
}

export type RecentChangeKind = 'alert_raised' | 'action_completed' | 'action_dismissed' | 'month_scored';

export interface RecentChange {
  readonly kind: RecentChangeKind;
  readonly organizationId: string;
  readonly at: string;
  readonly label: string;
  readonly href: string;
}

export interface PortfolioCounts {
  readonly clients: number;
  readonly needingAttention: number;
  /** Latest complete month scored Stable or Strong. */
  readonly healthy: number;
  /** No complete month has been scored yet. Not zero health: no health. */
  readonly unscored: number;
  readonly alertsStanding: number;
  readonly criticalAlerts: number;
  readonly highAlerts: number;
  readonly openActions: number;
  readonly overdueActions: number;
  readonly dueSoonActions: number;
  readonly urgentActions: number;
  readonly myActions: number;
}

/** A capped detail list, with the size of the population it was taken from. */
export interface CappedList<T> {
  readonly rows: readonly T[];
  /** The authoritative count of the whole population the rows were drawn from. */
  readonly total: number;
  readonly truncated: boolean;
}

export interface PortfolioView {
  readonly today: string;
  readonly organisations: readonly PortfolioOrganisation[];
  readonly clients: readonly ClientRow[];
  /** Every client that needs attention, ordered; the page shows the first `ATTENTION_CAP`. */
  readonly attention: readonly ClientRow[];
  readonly counts: PortfolioCounts;
  readonly recent: readonly RecentChange[];
}
