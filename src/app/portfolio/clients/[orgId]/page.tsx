import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPortfolioContext, hrefs, loadPortfolio } from '@/modules/portfolio';
import { bandLabel } from '@/modules/health';
import { PageHeader, Card, CardBody, CardHeader, Badge } from '@/components/ui/surfaces';
import { ButtonLink } from '@/components/ui/button';
import { HealthScoreInline, Disclaimer } from '@/components/dashboard';
import { ORG_STATUS_LABELS } from '@/components/labels';
import { ActionsTable, AlertsTable } from '@/components/portfolio';
import { TREND_LABELS, reasonTone } from '@/modules/portfolio';

export const dynamic = 'force-dynamic';

/**
 * One client, briefly: why it is flagged, its health, its alerts and its actions, each a link into
 * the organisation's own pages where the evidence chain continues (ADR-112 §6). An id outside the
 * caller's portfolio is the uniform 404, whether or not the organisation exists.
 */
export default async function PortfolioClientPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const ctx = await getPortfolioContext();
  const organisation = ctx.organisations.find((o) => o.id === orgId);
  if (organisation === undefined) notFound();

  const view = await loadPortfolio(ctx);
  const row = view.clients.find((c) => c.organisation.id === orgId);
  if (row === undefined) notFound();
  const links = hrefs(organisation);
  const alerts = view.alerts.filter((a) => a.organizationId === orgId);
  const actions = view.actions.filter((a) => a.organizationId === orgId);

  return (
    <>
      <PageHeader
        eyebrow="Client"
        title={organisation.name}
        description={organisation.status === 'active' ? undefined : ORG_STATUS_LABELS[organisation.status]}
        action={<ButtonLink href={links.home} tone="secondary">Open {organisation.name}</ButtonLink>}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Why this client is here" />
          <CardBody>
            {row.attention === null ? (
              <p className="text-sm text-ink-muted">Nothing needs attention: no serious alert, no overdue or urgent action, and health has not fallen.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {row.attention.reasons.map((reason) => (
                  <li key={reason.kind} className="flex items-center gap-2 text-sm">
                    <Badge tone={reasonTone(reason.kind)}>{reason.label}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Health"
            action={<Link href={links.home} className="text-sm text-accent underline underline-offset-2">See how it was scored</Link>}
          />
          <CardBody>
            {row.health === null ? (
              <p className="text-sm text-ink-muted">No complete month has been scored yet. That is an absence, not a score of zero.</p>
            ) : (
              <>
                <HealthScoreInline
                  score={row.health.score}
                  band={row.health.band}
                  dimensionsUsed={row.health.dimensionsUsed}
                  dimensionsTotal={row.health.dimensionsTotal}
                />
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <dt className="text-ink-muted">Month</dt><dd>{row.health.periodLabel}</dd>
                  <dt className="text-ink-muted">Trend</dt>
                  <dd>{row.trend === null ? '—' : `${TREND_LABELS[row.trend]}${row.health.previous ? ` from ${row.health.previous.score ?? '—'} (${bandLabel(row.health.previous.band) ?? 'not enough data'}) in ${row.health.previous.periodLabel}` : ''}`}</dd>
                  <dt className="text-ink-muted">Dimensions scored</dt><dd className="tabular-nums">{row.health.dimensionsUsed} of {row.health.dimensionsTotal}</dd>
                </dl>
              </>
            )}
          </CardBody>
        </Card>
      </div>

      <section aria-labelledby="client-alerts" className="mt-8">
        <h2 id="client-alerts" className="mb-3 font-serif text-lg">Alerts standing ({alerts.length})</h2>
        <AlertsTable alerts={alerts} organisations={[organisation]} now={ctx.now()} />
      </section>

      <section aria-labelledby="client-actions" className="mt-8">
        <h2 id="client-actions" className="mb-3 font-serif text-lg">Open actions ({actions.length})</h2>
        <ActionsTable actions={actions} organisations={[organisation]} today={view.today} viewerUserId={ctx.userId} />
      </section>

      <p className="mt-8 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href={`/app/${organisation.slug}/insights`} className="text-accent underline underline-offset-2">Insights</Link>
        <Link href={`/app/${organisation.slug}/actions`} className="text-accent underline underline-offset-2">Action Centre</Link>
        <Link href={`/app/${organisation.slug}/reports`} className="text-accent underline underline-offset-2">Reports</Link>
        <Link href={`/app/${organisation.slug}/analyst`} className="text-accent underline underline-offset-2">Analyst</Link>
      </p>
      <Disclaimer />
    </>
  );
}
