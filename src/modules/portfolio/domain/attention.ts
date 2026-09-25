/**
 * The attention queue's rules (ADR-112 §3). Pure.
 *
 * "Which clients need attention?" is answered from facts MOTION already established — alert
 * severities from the alert engine, overdue and urgent actions from the Action Centre's own rules,
 * health bands from the Health Score — combined in one fixed order. There is no score of the
 * portfolio's own and no model in the loop: the same facts always produce the same queue.
 */

import { BANDS, bandLabel, type HealthBand } from '@/modules/health';
import type { AttentionEntry, AttentionReason, ClientCounts, PortfolioHealth, PortfolioOrganisation } from './types';

/** A fall of at least this many points inside the same band is worth a look (ADR-112). */
export const SCORE_FALL_POINTS = 10;

/** Fixed, worst first. Ties inside the queue fall to the sum, then to the name. */
export const REASON_WEIGHTS = {
  critical_alert: 100,
  health_band_fell: 80,
  health_at_risk: 70,
  overdue_action: 60,
  high_alert: 50,
  organisation_suspended: 45,
  urgent_action: 40,
  health_score_fell: 30,
  health_needs_attention: 20,
} as const;

function bandRank(band: HealthBand): number {
  // BANDS is ordered best first; a lower index is a better band.
  return BANDS.findIndex((b) => b.band === band);
}

/** Whether the latest complete month's band is below the previous one's. */
export function bandFell(health: PortfolioHealth): boolean {
  if (health.band === null || health.previous?.band == null) return false;
  return bandRank(health.band) > bandRank(health.previous.band);
}

/** Whether the score fell by `SCORE_FALL_POINTS` or more without leaving its band. */
export function scoreFell(health: PortfolioHealth): boolean {
  if (health.score === null || health.previous?.score == null) return false;
  return !bandFell(health) && health.previous.score - health.score >= SCORE_FALL_POINTS;
}

export function trendOf(health: PortfolioHealth | null): 'up' | 'down' | 'flat' | null {
  if (health === null || health.score === null || health.previous?.score == null) return null;
  if (health.score > health.previous.score) return 'up';
  if (health.score < health.previous.score) return 'down';
  return 'flat';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Every reason this organisation has, or none — from its AUTHORITATIVE counts (`api.portfolio_summary`,
 * ADR-114), never from a capped list of rows. Overdue and urgent are the Action Centre's own rules,
 * evaluated in that statement: overdue = open with a due date before today; urgent = open,
 * critical/high priority, not overdue.
 */
export function attentionReasons(input: {
  readonly organisation: PortfolioOrganisation;
  readonly health: PortfolioHealth | null;
  readonly counts: Pick<ClientCounts, 'alertsCritical' | 'alertsHigh' | 'actionsOverdue' | 'actionsUrgentOnTime'>;
}): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  const add = (kind: keyof typeof REASON_WEIGHTS, label: string, count = 1) =>
    reasons.push({ kind, weight: REASON_WEIGHTS[kind], label, count });

  const { alertsCritical: critical, alertsHigh: high, actionsOverdue: overdue, actionsUrgentOnTime: urgent } = input.counts;
  if (critical > 0) add('critical_alert', plural(critical, 'critical alert', 'critical alerts'), critical);
  if (high > 0) add('high_alert', plural(high, 'high alert', 'high alerts'), high);
  if (overdue > 0) add('overdue_action', plural(overdue, 'overdue action', 'overdue actions'), overdue);
  if (urgent > 0) add('urgent_action', plural(urgent, 'urgent action', 'urgent actions'), urgent);

  const health = input.health;
  if (health !== null && health.band !== null) {
    if (bandFell(health)) {
      add('health_band_fell', `Health fell from ${bandLabel(health.previous!.band)} to ${bandLabel(health.band)}`);
    } else if (scoreFell(health)) {
      add('health_score_fell', `Health score fell ${health.previous!.score! - health.score!} points`);
    }
    if (health.band === 'at_risk') add('health_at_risk', 'Health is At risk');
    else if (health.band === 'needs_attention') add('health_needs_attention', 'Health needs attention');
  }

  if (input.organisation.status === 'suspended') add('organisation_suspended', 'Organisation suspended');

  return reasons.sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind));
}

export function attentionEntry(organizationId: string, reasons: readonly AttentionReason[]): AttentionEntry | null {
  if (reasons.length === 0) return null;
  const max = Math.max(...reasons.map((r) => r.weight));
  const sum = reasons.reduce((total, r) => total + r.weight, 0);
  return { organizationId, reasons, rank: [max, sum] };
}

/** Queue order: heaviest reason, then the sum of reasons, then the name — never the model. */
export function compareAttention(
  a: { entry: AttentionEntry; name: string },
  b: { entry: AttentionEntry; name: string },
): number {
  return b.entry.rank[0] - a.entry.rank[0]
    || b.entry.rank[1] - a.entry.rank[1]
    || a.name.localeCompare(b.name);
}
