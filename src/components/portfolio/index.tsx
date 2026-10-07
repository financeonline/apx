import Link from 'next/link';
import { Building2, ChevronRight } from 'lucide-react';
import { Badge, Card, CardBody, EmptyState, IconBadge } from '@/components/ui/surfaces';
import { THead, TBody, TR, TD } from '@/components/ui/table';
import { Table } from '@/components/ui/shadcn';
import { HealthScoreInline } from '@/components/dashboard';
import { ORG_STATUS_LABELS } from '@/components/labels';
import { HEALTH_DIMENSION_KEYS, bandLabel } from '@/modules/health';
import {
  PRIORITY_LABELS, SEVERITY_LABELS, TREND_LABELS, ageLabel, dueLabel, hrefs, priorityTone, reasonTone,
  seriousAlerts, severityTone, truncationNote, type CappedList, type ClientRow, type PortfolioAction,
  type PortfolioAlert, type PortfolioCounts, type PortfolioOrganisation, type RecentChange,
} from '@/modules/portfolio';

/**
 * The Command Centre's pieces (SOW §18; UX §9.4). Every number here is a count of rows or a score
 * another module wrote; nothing is worked out on the way to the screen.
 */

const byId = (organisations: readonly PortfolioOrganisation[]) => new Map(organisations.map((o) => [o.id, o]));

export function CountsStrip({ counts }: { counts: PortfolioCounts }) {
  const items: Array<{ label: string; value: number; tone?: 'danger' | 'warn'; href?: string }> = [
    { label: 'Clients', value: counts.clients },
    { label: 'Need attention', value: counts.needingAttention, tone: counts.needingAttention > 0 ? 'warn' : undefined },
    { label: 'Healthy', value: counts.healthy },
    { label: 'Not yet scored', value: counts.unscored },
    { label: 'Critical alerts', value: counts.criticalAlerts, tone: counts.criticalAlerts > 0 ? 'danger' : undefined, href: '/portfolio/alerts' },
    { label: 'High alerts', value: counts.highAlerts, tone: counts.highAlerts > 0 ? 'warn' : undefined, href: '/portfolio/alerts' },
    { label: 'Open actions', value: counts.openActions, href: '/portfolio/actions' },
    { label: 'Overdue actions', value: counts.overdueActions, tone: counts.overdueActions > 0 ? 'danger' : undefined, href: '/portfolio/actions?view=overdue' },
  ];
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => {
        const body = (
          <>
            <span className="block text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">{item.label}</span>
            <span className={`mt-1 block text-2xl tabular-nums ${item.tone === 'danger' ? 'text-danger' : item.tone === 'warn' ? 'text-warn' : 'text-ink'}`}>
              {item.value.toLocaleString('en-GB')}
            </span>
          </>
        );
        return (
          <li key={item.label} className="rounded-lg border border-line bg-surface px-4 py-3">
            {item.href ? <Link href={item.href} className="block">{body}</Link> : body}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The attention queue (ADR-112), as the reference's cards (ADR-155): an icon tile, the client's
 * name and health, its reasons, and an outlined "Why, and what next" in the footer.
 */
export function AttentionQueue({ rows, today, now }: { rows: readonly ClientRow[]; today: string; now: Date }) {
  void today; void now;
  if (rows.length === 0) {
    return (
      <EmptyState title="Nothing needs your attention right now">
        No client has a critical or high alert, an overdue or urgent action, or health that fell or is at risk.
      </EmptyState>
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {rows.map((row) => {
        const links = hrefs(row.organisation);
        return (
          <li key={row.organisation.id} className="min-w-0">
            <div className="panel flex h-full flex-col rounded-card p-4">
              <div className="flex gap-3.5">
                <IconBadge tint="violet"><Building2 /></IconBadge>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <Link href={links.client} className="min-w-0 font-semibold text-ink underline-offset-2 [overflow-wrap:anywhere] hover:underline">
                      {row.organisation.name}
                    </Link>
                    <HealthScoreInline
                      score={row.health?.score ?? null}
                      band={row.health?.band ?? null}
                      dimensionsUsed={row.health?.dimensionsUsed ?? 0}
                      dimensionsTotal={row.health?.dimensionsTotal ?? HEALTH_DIMENSION_KEYS.length}
                    />
                  </div>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {row.attention!.reasons.map((reason) => (
                      <li key={reason.kind}>
                        <Badge tone={reasonTone(reason.kind)}>{reason.label}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <p className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-3 text-sm">
                <Link
                  href={links.client}
                  className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft"
                >
                  Why, and what next <ChevronRight aria-hidden="true" className="size-4" />
                </Link>
                <Link href={links.home} className="text-ink-muted [overflow-wrap:anywhere] hover:text-ink">Open {row.organisation.name}</Link>
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ClientTable({ rows }: { rows: readonly ClientRow[] }) {
  return (
    <>
      {/* Small screens: one card per client, so nothing scrolls sideways (brief §15). */}
      <ul className="grid gap-3 md:hidden">
        {rows.map((row) => {
          const links = hrefs(row.organisation);
          return (
            <li key={row.organisation.id}>
              <Card>
                <CardBody>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <Link href={links.client} className="font-medium text-ink underline-offset-2 hover:underline">{row.organisation.name}</Link>
                    <Link href={links.home} className="text-sm text-accent underline underline-offset-2">Open</Link>
                  </div>
                  {row.organisation.status !== 'active' ? (
                    <p className="mt-1"><Badge tone="warn">{ORG_STATUS_LABELS[row.organisation.status]}</Badge></p>
                  ) : null}
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <dt className="text-ink-muted">Health</dt>
                    <dd>
                      {row.health === null ? <span className="text-ink-faint">Not yet scored</span> : (
                        <span><span className="tabular-nums">{row.health.score ?? '—'}</span> <span className="text-ink-muted">{bandLabel(row.health.band) ?? 'Not enough data'}</span> <span className="block text-xs text-ink-faint">{row.health.periodLabel}</span></span>
                      )}
                    </dd>
                    <dt className="text-ink-muted">Trend</dt>
                    <dd>{row.trend === null ? <span className="text-ink-faint">—</span> : TREND_LABELS[row.trend]}</dd>
                    <dt className="text-ink-muted">Alerts</dt>
                    <dd className="tabular-nums">{row.counts.alertsStanding}{seriousAlerts(row.counts) > 0 ? <span className="ml-2"><Badge tone="danger">{seriousAlerts(row.counts)} serious</Badge></span> : null}</dd>
                    <dt className="text-ink-muted">Open actions</dt>
                    <dd className="tabular-nums">{row.counts.actionsOpen}{row.counts.actionsOverdue > 0 ? <span className="ml-2"><Badge tone="warn">{row.counts.actionsOverdue} overdue</Badge></span> : null}</dd>
                    {row.latestChange !== null ? (
                      <>
                        <dt className="text-ink-muted">Latest change</dt>
                        <dd><Link href={row.latestChange.href} className="text-ink-muted hover:text-ink">{row.latestChange.label}</Link></dd>
                      </>
                    ) : null}
                  </dl>
                </CardBody>
              </Card>
            </li>
          );
        })}
      </ul>
      <div className="hidden md:block">
    <Table>
      <THead columns={['Client', 'Health', 'Trend', 'Alerts', 'Open actions', 'Latest change', '']} />
      <TBody>
        {rows.map((row) => {
          const links = hrefs(row.organisation);
          return (
            <TR key={row.organisation.id}>
              <TD>
                <Link href={links.client} className="font-medium text-ink underline-offset-2 hover:underline">{row.organisation.name}</Link>
                {row.organisation.status !== 'active' ? (
                  <span className="ml-2"><Badge tone="warn">{ORG_STATUS_LABELS[row.organisation.status]}</Badge></span>
                ) : null}
              </TD>
              <TD>
                {row.health === null ? (
                  <span className="text-ink-faint">Not yet scored</span>
                ) : (
                  <span>
                    <span className="tabular-nums">{row.health.score ?? '—'}</span>
                    <span className="ml-2 text-ink-muted">{bandLabel(row.health.band) ?? 'Not enough data'}</span>
                    <span className="block text-xs text-ink-faint">{row.health.periodLabel}</span>
                  </span>
                )}
              </TD>
              <TD>{row.trend === null ? <span className="text-ink-faint">—</span> : TREND_LABELS[row.trend]}</TD>
              <TD className="tabular-nums">
                {row.counts.alertsStanding}
                {seriousAlerts(row.counts) > 0 ? <span className="ml-2"><Badge tone="danger">{seriousAlerts(row.counts)} serious</Badge></span> : null}
              </TD>
              <TD className="tabular-nums">
                {row.counts.actionsOpen}
                {row.counts.actionsOverdue > 0 ? <span className="ml-2"><Badge tone="warn">{row.counts.actionsOverdue} overdue</Badge></span> : null}
              </TD>
              <TD>
                {row.latestChange === null ? <span className="text-ink-faint">—</span> : (
                  <Link href={row.latestChange.href} className="text-ink-muted hover:text-ink">{row.latestChange.label}</Link>
                )}
              </TD>
              <TD><Link href={links.home} className="text-accent underline underline-offset-2">Open</Link></TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
      </div>
    </>
  );
}

export function AlertsTable({
  list, organisations, now,
}: { list: CappedList<PortfolioAlert>; organisations: readonly PortfolioOrganisation[]; now: Date }) {
  const orgs = byId(organisations);
  const alerts = list.rows;
  const note = truncationNote(list, 'worst first');
  if (alerts.length === 0) {
    return <EmptyState title="No alert is standing across your clients">Alerts that are open or acknowledged appear here, worst first.</EmptyState>;
  }
  return (
    <>
    {note ? <p className="mb-2 text-sm text-ink-muted" role="status">{note}</p> : null}
    <Table>
      <THead columns={['Severity', 'Client', 'Alert', 'Status', 'Standing since', 'Evidence']} />
      <TBody>
        {alerts.map((alert) => {
          const org = orgs.get(alert.organizationId);
          if (org === undefined) return null;
          const links = hrefs(org);
          return (
            <TR key={alert.id}>
              <TD><Badge tone={severityTone(alert.severity)}>{SEVERITY_LABELS[alert.severity]}</Badge></TD>
              <TD><Link href={links.client} className="text-ink hover:underline">{org.name}</Link></TD>
              <TD><Link href={links.alert(alert.id)} className="text-accent underline underline-offset-2">{alert.title}</Link></TD>
              <TD>{alert.status === 'acknowledged' ? 'Acknowledged' : 'Open'}{alert.actionId ? ' · has an action' : ''}</TD>
              <TD>{ageLabel(alert.firstSeenAt, now)}</TD>
              <TD>{alert.evidenceBundleId ? <Link href={links.evidence(alert.evidenceBundleId)} className="text-ink-muted hover:text-ink">Why?</Link> : <span className="text-ink-faint">—</span>}</TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
    </>
  );
}

export function ActionsTable({
  list, organisations, today, viewerUserId,
}: { list: CappedList<PortfolioAction>; organisations: readonly PortfolioOrganisation[]; today: string; viewerUserId: string }) {
  const orgs = byId(organisations);
  const actions = list.rows;
  const note = truncationNote(list, 'most urgent first');
  if (actions.length === 0) {
    return <EmptyState title="No action in this view">Open actions across your clients appear here.</EmptyState>;
  }
  return (
    <>
    {note ? <p className="mb-2 text-sm text-ink-muted" role="status">{note}</p> : null}
    <Table>
      <THead columns={['Priority', 'Client', 'Action', 'Owner', 'Due', 'Evidence']} />
      <TBody>
        {actions.map((action) => {
          const org = orgs.get(action.organizationId);
          if (org === undefined) return null;
          const links = hrefs(org);
          const due = dueLabel(action.dueDate, today);
          return (
            <TR key={action.id}>
              <TD><Badge tone={priorityTone(action.priority)}>{PRIORITY_LABELS[action.priority]}</Badge></TD>
              <TD><Link href={links.client} className="text-ink hover:underline">{org.name}</Link></TD>
              <TD><Link href={links.action(action.id)} className="text-accent underline underline-offset-2">{action.title}</Link></TD>
              <TD>{action.ownerUserId === viewerUserId ? 'You' : action.ownerUserId === null ? <span className="text-ink-faint">Unassigned</span> : 'Assigned'}</TD>
              <TD>{due === null ? <span className="text-ink-faint">No date</span> : due}</TD>
              <TD>{action.evidenceBundleId ? <Link href={links.evidence(action.evidenceBundleId)} className="text-ink-muted hover:text-ink">Why?</Link> : <span className="text-ink-faint">—</span>}</TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
    </>
  );
}

export function RecentChanges({ changes, organisations, now }: { changes: readonly RecentChange[]; organisations: readonly PortfolioOrganisation[]; now: Date }) {
  const orgs = byId(organisations);
  if (changes.length === 0) return <p className="text-sm text-ink-muted">Nothing changed in the last seven days.</p>;
  const KIND: Record<RecentChange['kind'], string> = {
    alert_raised: 'Alert raised', action_completed: 'Action completed', action_dismissed: 'Action dismissed', month_scored: 'Month scored',
  };
  return (
    <ul className="divide-y divide-line">
      {changes.map((change) => (
        <li key={`${change.kind}-${change.href}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
          <span className="text-ink-faint">{ageLabel(change.at, now)}</span>
          <span className="text-ink-muted">{KIND[change.kind]}</span>
          <span className="font-medium">{orgs.get(change.organizationId)?.name ?? '—'}</span>
          <Link href={change.href} className="text-accent underline underline-offset-2">{change.label}</Link>
        </li>
      ))}
    </ul>
  );
}
