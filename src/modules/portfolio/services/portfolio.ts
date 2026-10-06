import 'server-only';
import { DUE_SOON_DAYS, addDays } from '@/modules/actions';
import { attentionEntry, attentionReasons, compareAttention, trendOf } from '../domain/attention';
import { opportunityEntry, type OpportunityEntry } from '../domain/opportunities';
import type {
  CappedList, ClientCounts, ClientRow, PortfolioAction, PortfolioAlert, PortfolioCounts,
  PortfolioOrganisation, PortfolioView, RecentChange,
} from '../domain/types';
import * as repo from '../data/repository';
import type { OpenLens } from '../data/repository';
import type { PortfolioContext } from './access';

/** "Recent" on the Command Centre: the last seven days. */
export const RECENT_DAYS = 7;
/** The attention queue SHOWN on the overview. Every client that needs attention is still counted. */
export const ATTENTION_CAP = 25;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

const ZERO: ClientCounts = {
  alertsStanding: 0, alertsCritical: 0, alertsHigh: 0, actionsOpen: 0, actionsOverdue: 0,
  actionsDueSoon: 0, actionsUrgent: 0, actionsUrgentOnTime: 0, actionsMine: 0,
};

export function hrefs(org: PortfolioOrganisation) {
  return {
    home: `/app/${org.slug}/home`,
    alert: (alertId: string) => `/app/${org.slug}/insights/alerts/${alertId}`,
    action: (actionId: string) => `/app/${org.slug}/actions/${actionId}`,
    evidence: (bundleId: string) => `/app/${org.slug}/evidence/${bundleId}`,
    client: `/portfolio/clients/${org.id}`,
  };
}

function dates(ctx: PortfolioContext) {
  const now = ctx.now();
  const today = isoDay(now);
  return { now, today, dueSoonUntil: addDays(today, DUE_SOON_DAYS), since: new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString() };
}

/**
 * The overview (ADR-112, ADR-114): the aggregate, then two small recent feeds.
 *
 * Every count and every attention reason comes from `api.portfolio_summary` over the FULL authorised
 * population — never from a list of rows, which is how a cap once hid a client's critical alerts. The
 * only rows read here are the recent feeds, which are recent by definition and capped at 50.
 */
export async function loadPortfolio(ctx: PortfolioContext): Promise<PortfolioView> {
  const { today, dueSoonUntil, since } = dates(ctx);
  const ids = scopeFor(ctx, ctx.organisationIds);

  const [summary, recentAlerts, finished] = await Promise.all([
    repo.loadPortfolioSummary(ctx.db, ids, today, dueSoonUntil, ctx.requestId),
    repo.loadRecentAlerts(ctx.db, ids, since, ctx.requestId),
    repo.loadRecentlyFinishedActions(ctx.db, ids, since, ctx.requestId),
  ]);

  const orgById = new Map(ctx.organisations.map((o) => [o.id, o]));
  const recent = recentChanges(orgById, recentAlerts, finished).slice(0, repo.RECENT_CAP);

  const clients: ClientRow[] = ctx.organisations.map((organisation) => {
    const row = summary.get(organisation.id);
    const counts = row?.counts ?? ZERO;
    const health = row?.health ?? null;
    return {
      organisation,
      health,
      trend: trendOf(health),
      counts,
      attention: attentionEntry(organisation.id, attentionReasons({ organisation, health, counts })),
      latestChange: recent.find((change) => change.organizationId === organisation.id) ?? null,
    };
  });

  const attention = clients
    .filter((c): c is ClientRow & { attention: NonNullable<ClientRow['attention']> } => c.attention !== null)
    .sort((a, b) => compareAttention(
      { entry: a.attention, name: a.organisation.name },
      { entry: b.attention, name: b.organisation.name },
    ));

  const sum = (key: keyof ClientCounts) => clients.reduce((total, c) => total + c.counts[key], 0);
  const counts: PortfolioCounts = {
    clients: clients.length,
    needingAttention: attention.length,
    healthy: clients.filter((c) => c.health?.band === 'stable' || c.health?.band === 'strong').length,
    unscored: clients.filter((c) => c.health === null || c.health.score === null).length,
    alertsStanding: sum('alertsStanding'),
    criticalAlerts: sum('alertsCritical'),
    highAlerts: sum('alertsHigh'),
    openActions: sum('actionsOpen'),
    overdueActions: sum('actionsOverdue'),
    dueSoonActions: sum('actionsDueSoon'),
    urgentActions: sum('actionsUrgent'),
    myActions: sum('actionsMine'),
  };

  return { today, organisations: ctx.organisations, clients, attention, counts, recent };
}

/**
 * What a read sends as its scope (ADR-117): nothing when it covers the whole portfolio — the
 * database derives the caller's adviser organisations itself, so no list of ids travels — else the
 * ids it narrows to (one client's page). An empty portfolio reads nothing.
 */
function scopeFor(ctx: PortfolioContext, organisationIds: readonly string[]): repo.Scope {
  if (ctx.organisationIds.length === 0 || organisationIds.length === 0) return [];
  const asked = new Set(organisationIds);
  const whole = asked.size === ctx.organisationIds.length && ctx.organisationIds.every((id) => asked.has(id));
  return whole ? null : organisationIds;
}

function capped<T>(rows: readonly T[], total: number): CappedList<T> {
  return { rows, total, truncated: rows.length < total };
}

/** Standing alerts across the portfolio (or one client), worst first, with the full count. */
export async function loadPortfolioAlerts(
  ctx: PortfolioContext, view: PortfolioView, organisationIds: readonly string[] = ctx.organisationIds,
): Promise<CappedList<PortfolioAlert>> {
  const rows = await repo.loadStandingAlerts(ctx.db, scopeFor(ctx, organisationIds), repo.ALERT_DETAIL_CAP, ctx.requestId);
  const total = view.clients
    .filter((c) => organisationIds.includes(c.organisation.id))
    .reduce((n, c) => n + c.counts.alertsStanding, 0);
  return capped(rows, total);
}

/** The opportunities shown on the overview; every client with one is still counted. */
export const OPPORTUNITY_CAP = 25;

/**
 * Advisory opportunities (SOW §20, REQ-AD-10; ADR-148): the fixed rules over each client's latest
 * complete Health breakdown, read in one scoped statement. Ordered by how many opportunities a
 * client has, then by name — never by a model.
 */
export async function loadOpportunities(
  ctx: PortfolioContext, view: PortfolioView, organisationIds: readonly string[] = ctx.organisationIds,
): Promise<OpportunityEntry[]> {
  const breakdowns = await repo.loadHealthBreakdowns(ctx.db, scopeFor(ctx, organisationIds), ctx.requestId);
  const healthOf = new Map(view.clients.map((c) => [c.organisation.id, c.health]));
  const nameOf = new Map(view.clients.map((c) => [c.organisation.id, c.organisation.name]));
  return breakdowns
    .map((b) => opportunityEntry(b, healthOf.get(b.organizationId) ?? null))
    .filter((e): e is OpportunityEntry => e !== null)
    .sort((a, b) => b.opportunities.length - a.opportunities.length
      || (nameOf.get(a.organizationId) ?? '').localeCompare(nameOf.get(b.organizationId) ?? ''));
}

/** The count behind each open-work lens, from the aggregate. */
export function lensTotal(view: PortfolioView, lens: OpenLens, organisationIds?: readonly string[]): number {
  const key: Record<OpenLens, keyof ClientCounts> = {
    attention: 'actionsOpen', overdue: 'actionsOverdue', due_soon: 'actionsDueSoon', high: 'actionsUrgent', mine: 'actionsMine',
  };
  return view.clients
    .filter((c) => organisationIds === undefined || organisationIds.includes(c.organisation.id))
    .reduce((n, c) => n + c.counts[key[lens]], 0);
}

/** Open actions in one lens across the portfolio (or one client), in `byUrgency` order, with the full count. */
export async function loadPortfolioActions(
  ctx: PortfolioContext, view: PortfolioView, lens: OpenLens, organisationIds: readonly string[] = ctx.organisationIds,
): Promise<CappedList<PortfolioAction>> {
  const { today, dueSoonUntil } = dates(ctx);
  const rows = await repo.loadOpenActions(
    ctx.db, scopeFor(ctx, organisationIds), lens, { today, dueSoonUntil }, repo.ACTION_DETAIL_CAP, ctx.requestId,
  );
  return capped(rows, lensTotal(view, lens, organisationIds));
}

function recentChanges(
  orgById: ReadonlyMap<string, PortfolioOrganisation>,
  alerts: readonly PortfolioAlert[],
  finished: readonly PortfolioAction[],
): RecentChange[] {
  const out: RecentChange[] = [];
  for (const alert of alerts) {
    const org = orgById.get(alert.organizationId);
    if (org) out.push({ kind: 'alert_raised', organizationId: org.id, at: alert.firstSeenAt, label: alert.title, href: hrefs(org).alert(alert.id) });
  }
  for (const action of finished) {
    const org = orgById.get(action.organizationId);
    if (org) {
      out.push({
        kind: action.status === 'completed' ? 'action_completed' : 'action_dismissed',
        organizationId: org.id, at: action.completedAt ?? action.updatedAt, label: action.title, href: hrefs(org).action(action.id),
      });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.href.localeCompare(b.href));
}
