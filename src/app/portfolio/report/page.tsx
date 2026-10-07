import Link from 'next/link';
import {
  Building2, CircleCheck, CircleDashed, ClipboardCheck, Download, Lightbulb, Siren, TriangleAlert,
} from 'lucide-react';
import { getPortfolioContext, hrefs, loadPortfolioReport } from '@/modules/portfolio';
import { Badge, Card, CardBody, EmptyState, IconBadge, PageHeader, StatTile } from '@/components/ui/surfaces';
import { Disclaimer } from '@/components/dashboard';

export const dynamic = 'force-dynamic';

/**
 * The Portfolio Report (SOW §20 "Client reports"; ADR-149): every client the caller advises on one
 * page, as the overview shows them, with the advisory opportunities. Composed now from the current
 * figures and not stored; the PDF is the same content.
 */
export default async function PortfolioReportPage() {
  const ctx = await getPortfolioContext();
  if (ctx.organisations.length === 0) {
    return (
      <>
        <PageHeader eyebrow="Command Centre" title="Portfolio Report" />
        <EmptyState title="There are no clients to report on yet.">Clients you are assigned to appear here.</EmptyState>
      </>
    );
  }
  const report = await loadPortfolioReport(ctx);
  const c = report.counts;
  const orgById = new Map(ctx.organisations.map((o) => [o.id, o]));

  return (
    <>
      <PageHeader
        eyebrow="Command Centre"
        title="Portfolio Report"
        description={`${report.today} · ${c.clients} ${c.clients === 1 ? 'client' : 'clients'} · from the figures current now.`}
        action={<a href="/portfolio/report/pdf" className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft"><Download aria-hidden="true" className="size-4" />Download the PDF</a>}
      />

      <div className="mb-8 grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-3">
        <StatTile label="Needing attention" value={c.needingAttention} icon={<TriangleAlert />} tint="violet" />
        <StatTile label="Stable or Strong" value={c.healthy} icon={<CircleCheck />} tint="pink" />
        <StatTile label="Not yet scored" value={c.unscored} icon={<CircleDashed />} tint="violet" />
        <StatTile label="With opportunities" value={report.clientsWithOpportunities} icon={<Lightbulb />} tint="pink" />
        <StatTile label="Critical / high alerts" value={<>{c.criticalAlerts} / {c.highAlerts}</>} icon={<Siren />} tint="violet" />
        <StatTile label="Open actions (overdue)" value={<>{c.openActions} ({c.overdueActions})</>} icon={<ClipboardCheck />} tint="pink" />
      </div>

      <ol className="flex flex-col gap-4">
        {report.clients.map((client) => {
          const org = orgById.get(client.organizationId);
          return (
            <li key={client.organizationId}>
              <Card><CardBody>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <IconBadge tint="violet" size="sm"><Building2 /></IconBadge>
                    <h2 className="min-w-0 font-serif text-lg text-ink [overflow-wrap:anywhere]">
                      {org === undefined ? client.name : <Link href={hrefs(org).client} className="underline-offset-2 hover:underline">{client.name}</Link>}
                      {client.suspended ? <span className="ml-2 text-sm text-ink-muted">(suspended)</span> : null}
                    </h2>
                  </div>
                  <span className="text-sm text-ink">
                    {client.health === null ? 'Not yet scored'
                      : client.health.score === null ? `Not enough data · ${client.health.periodLabel}`
                        : `${client.health.score} · ${client.health.band} · ${client.health.periodLabel}`}
                  </span>
                </div>
                {client.health?.trend ? <p className="mt-1 text-sm text-ink-muted">{client.health.trend}</p> : null}
                <p className="mt-2 text-sm text-ink-muted">
                  {client.counts.alertsStanding} alerts standing ({client.counts.criticalAlerts} critical, {client.counts.highAlerts} high) ·{' '}
                  {client.counts.openActions} open actions ({client.counts.overdueActions} overdue)
                </p>
                {client.attention.length === 0 ? null : (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {client.attention.map((label) => <li key={label}><Badge tone="warn">{label}</Badge></li>)}
                  </ul>
                )}
                {client.opportunities.length === 0 ? null : (
                  <ul className="mt-3 flex flex-col gap-2 text-sm">
                    {client.opportunities.map((o) => (
                      <li key={o.title}>
                        <span className="font-medium text-ink">Opportunity: {o.title}.</span>{' '}
                        <span className="text-ink">{o.suggestion}</span>{' '}
                        <span className="text-ink-muted">Because: {o.because}.</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody></Card>
            </li>
          );
        })}
      </ol>
      <p className="mt-6 text-xs text-ink-faint">{report.disclaimer}</p>
      <Disclaimer />
    </>
  );
}
