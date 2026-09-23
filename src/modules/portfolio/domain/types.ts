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

export interface ClientRow {
  readonly organisation: PortfolioOrganisation;
  readonly health: PortfolioHealth | null;
  readonly trend: 'up' | 'down' | 'flat' | null;
  readonly openAlerts: number;
  readonly criticalOrHighAlerts: number;
  readonly openActions: number;
  readonly overdueActions: number;
  readonly attention: AttentionEntry | null;
  /** The most recent of: an alert first seen, an action finished, a month scored. */
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
  readonly criticalAlerts: number;
  readonly highAlerts: number;
  readonly openActions: number;
  readonly overdueActions: number;
}

export interface PortfolioView {
  readonly today: string;
  readonly organisations: readonly PortfolioOrganisation[];
  readonly clients: readonly ClientRow[];
  readonly attention: readonly ClientRow[];
  readonly counts: PortfolioCounts;
  readonly alerts: readonly PortfolioAlert[];
  readonly actions: readonly PortfolioAction[];
  readonly recent: readonly RecentChange[];
}
