import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { addDays, todayInTimeZone, fixedClock } from '@/core/periods';
import { loadHealthTrend, loadLastDataDate, loadPeriods, loadPeriodsWithData } from '@/modules/dashboard';
import { HEALTH_DISCLAIMER, bandFor, loadHealthCard } from '@/modules/health';
import { attentionReasons } from '@/modules/portfolio';
import { BRIEF_LIST_CAP, ORG_PLACEHOLDER, type BriefActionLine, type Capped } from '../domain/brief';
import {
  ADVISER_CONTENT_VERSION, COMPLETED_WINDOW_DAYS, type AdviserCompletedAction, type AdviserContent,
} from '../domain/adviser';

export { ADVISER_CONTENT_VERSION, type AdviserContent };
import * as sources from '../data/brief-sources';
import { latestMonth } from './brief';

/**
 * The Accountant/CFO Report (Phase 17; Agreement §22 "adviser-ready client intelligence";
 * REQ-RP-04).
 *
 * One client, one document an adviser can take into a meeting: the latest complete month as Home
 * shows it, the health score with every dimension's standing, a year of scores, what stands open,
 * what was done, and how far the data can be trusted. The "needs attention" reasons are the Command
 * Centre's own (`portfolio/domain/attention.ts`) — the same facts in the same order, so the report
 * and the portfolio screen cannot disagree about a client.
 *
 * Composed by the `report.compose` job and stored like the briefs. Nothing in it is computed here:
 * every figure is a stored snapshot, score, alert or action.
 */

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

function cap<T>(items: readonly T[], order: (a: T, b: T) => number): Capped<T> {
  return { items: [...items].sort(order).slice(0, BRIEF_LIST_CAP), total: items.length };
}

async function completedSince(
  db: SupabaseClient, orgId: string, sinceIso: string,
): Promise<AdviserCompletedAction[]> {
  const { data, error } = await db.from('actions')
    .select('id, title, priority, status, due_date, owner_user_id, completed_at, outcome_value, outcome_currency')
    .eq('organization_id', orgId).eq('status', 'completed').gte('completed_at', sinceIso)
    .order('completed_at', { ascending: false }).limit(200);
  if (error) throw toMotionError(error);
  return ((data ?? []) as Array<{
    id: string; title: string; priority: BriefActionLine['priority']; status: BriefActionLine['status'];
    due_date: string | null; owner_user_id: string | null; completed_at: string | null;
    outcome_value: string | number | null; outcome_currency: string | null;
  }>).map((row) => ({
    id: row.id,
    title: row.title,
    priority: row.priority,
    status: row.status,
    dueDate: row.due_date,
    assigned: row.owner_user_id !== null,
    at: row.completed_at,
    href: `/app/${ORG_PLACEHOLDER}/actions/${row.id}`,
    outcomeValue: row.outcome_value === null ? null : String(row.outcome_value),
    outcomeCurrency: row.outcome_currency,
  }));
}

export async function composeAdviserReport(input: {
  readonly db: SupabaseClient;
  readonly orgId: string;
  readonly now: Date;
  readonly requestId?: string;
}): Promise<{ content: AdviserContent; periodId: string; window: { start: string; end: string } } | null> {
  const { db, orgId, requestId } = input;
  const month = await latestMonth(db, orgId, requestId);
  if (month === null) return null;

  const org = await sources.loadOrganisationBasics(db, orgId);
  const today = todayInTimeZone(fixedClock(input.now), org.timezone);
  const sinceIso = sources.windowInstants(addDays(today, -COMPLETED_WINDOW_DAYS), today, org.timezone).from;

  const [periods, withData, health, actions, accounts, dataRefreshedAt, completed] = await Promise.all([
    loadPeriods(db, orgId, requestId),
    loadPeriodsWithData(db, orgId, requestId),
    loadHealthCard(db, orgId, month.periodId, null, requestId),
    // The instant bounds are irrelevant to the open list, which is what is used here.
    sources.loadActionEvents(db, orgId, sinceIso, input.now.toISOString()),
    sources.loadAccountCoverage(db, orgId),
    loadLastDataDate(db, orgId, requestId),
    completedSince(db, orgId, sinceIso),
  ]);
  const period = periods.find((p) => p.id === month.periodId)!;
  const labels = new Map(periods.map((p) => [p.id, p.label]));
  const alerts = await sources.loadAlertEvents(db, orgId, sinceIso, input.now.toISOString(), labels);
  const trend = await loadHealthTrend(db, orgId, periods, requestId, period.periodStart);

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const alert of alerts.standing) bySeverity[alert.severity] += 1;

  // The Action Centre's rules, as the Command Centre applies them (ADR-112): overdue = open with a
  // due date before today; urgent = open, critical or high, not overdue.
  const open = actions.open;
  const overdue = open.filter((a) => a.dueDate !== null && a.dueDate < today);
  const urgent = open.filter((a) => (a.priority === 'critical' || a.priority === 'high')
    && !(a.dueDate !== null && a.dueDate < today));

  const previousScore = month.health === null || month.health.changeVsPrevious === null
    ? null : month.health.score - month.health.changeVsPrevious;
  const previousPeriod = periods.find((p) => p.periodStart < period.periodStart && withData.has(p.id)) ?? null;
  const reasons = attentionReasons({
    organisation: { id: orgId, slug: '', name: org.name, status: 'active', role: 'owner' },
    health: month.health === null ? null : {
      organizationId: orgId,
      scoreId: '',
      periodId: period.id,
      periodStart: period.periodStart,
      periodLabel: period.label,
      score: month.health.score,
      band: (health?.band ?? null),
      dimensionsUsed: month.health.dimensionsUsed,
      dimensionsTotal: month.health.dimensionsTotal,
      previous: previousPeriod === null ? null : {
        periodStart: previousPeriod.periodStart,
        periodLabel: previousPeriod.label,
        score: previousScore,
        // The same banding the score itself was given (health/domain/config.ts).
        band: previousScore === null ? null : bandFor(previousScore),
      },
    },
    counts: {
      alertsCritical: bySeverity.critical,
      alertsHigh: bySeverity.high,
      actionsOverdue: overdue.length,
      actionsUrgentOnTime: urgent.length,
    },
  });

  // The twelve months up to the reported one, oldest first, that hold no figures.
  const trailing = periods.filter((p) => p.periodStart <= period.periodStart).slice(0, 12);
  const monthsWithoutData = trailing.filter((p) => !withData.has(p.id)).map((p) => p.label).reverse();

  const content: AdviserContent = {
    version: ADVISER_CONTENT_VERSION,
    organisationName: org.name,
    timezone: org.timezone,
    currency: org.baseCurrency,
    composedAt: input.now.toISOString(),
    asOfDate: today,
    month,
    dimensions: (health?.breakdown ?? []).map((dimension) => ({
      key: dimension.key,
      score: dimension.score,
      included: dimension.included,
      exclusionReason: dimension.exclusion_reason,
      capped: dimension.capped,
      positives: dimension.positives,
      negatives: dimension.negatives,
    })),
    trend: trend.points.map((point) => ({
      periodLabel: trend.labels.get(point.periodId) ?? '',
      score: point.score,
      band: point.band,
    })),
    attention: reasons.map((reason) => reason.label),
    alerts: {
      bySeverity,
      standing: cap(alerts.standing.filter((a) => a.severity !== 'low' && a.severity !== 'info'),
        (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.at.localeCompare(a.at) || a.id.localeCompare(b.id)),
    },
    actions: {
      open: open.length,
      overdue: cap(overdue, (a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.id.localeCompare(b.id)),
      urgent: cap(urgent, (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.id.localeCompare(b.id)),
      completedRecently: cap(completed, (a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.id.localeCompare(b.id)),
    },
    dataQuality: {
      dataRefreshedAt,
      bankAccounts: accounts.map((account) => ({ name: account.name, latestDate: account.latestDate })),
      monthsWithoutData,
    },
    disclaimer: HEALTH_DISCLAIMER,
  };

  return { content, periodId: period.id, window: { start: period.periodStart, end: period.periodEnd } };
}
