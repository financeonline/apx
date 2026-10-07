import Link from 'next/link';
import {
  BarChart3, ChevronRight, ClipboardCheck, FileText, HeartPulse, Landmark, Lightbulb, ShieldAlert, Siren, Sparkles,
} from 'lucide-react';
import { notFound } from 'next/navigation';
import { getPortfolioContext, hrefs, loadOpportunities, loadPortfolio, loadPortfolioActions, loadPortfolioAlerts } from '@/modules/portfolio';
import { OpportunityList } from '../../_components/opportunities';
import { bandLabel } from '@/modules/health';
import { PageHeader, Card, CardBody, CardHeader, Badge, IconBadge } from '@/components/ui/surfaces';
import { ButtonLink } from '@/components/ui/button';
import { HealthScoreInline, Disclaimer } from '@/components/dashboard';
import { ORG_STATUS_LABELS } from '@/components/labels';
import { ActionsTable, AlertsTable } from '@/components/portfolio';
import { ShortcutLink } from '@/components/dashboard/department-card';
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
  // Phase 16 (§11): one link to the client's Funding Readiness page, only while it is switched on.
  const { data: features } = await ctx.db.from('organizations').select('features').eq('id', orgId).maybeSingle();
  const fundingOn = (features as { features?: Record<string, unknown> } | null)?.features?.funding_readiness === true;
  // This client's own detail, read for this client alone; the counts are the aggregate's (ADR-114).
  const [alerts, actions, opportunities] = await Promise.all([
    loadPortfolioAlerts(ctx, view, [orgId]),
    loadPortfolioActions(ctx, view, 'attention', [orgId]),
    loadOpportunities(ctx, view, [orgId]),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Client"
        title={organisation.name}
        description={organisation.status === 'active' ? undefined : ORG_STATUS_LABELS[organisation.status]}
        action={<ButtonLink href={links.home} tone="secondary">Open {organisation.name}</ButtonLink>}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader icon={<ShieldAlert />} tint="pink" title="Why this client is here" />
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
            icon={<HeartPulse />}
            tint="violet"
            title="Health"
            action={<Link href={links.home} className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft">See how it was scored <ChevronRight aria-hidden="true" className="size-4" /></Link>}
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

      <section aria-labelledby="client-opportunities" className="mt-8">
        <div className="mb-3 flex min-w-0 items-center gap-3">
          <IconBadge tint="pink" size="sm"><Lightbulb /></IconBadge>
          <h2 id="client-opportunities" className="min-w-0 font-serif text-lg">Advisory opportunities</h2>
        </div>
        <OpportunityList entries={opportunities} organisations={[organisation]} withActions />
      </section>

      <section aria-labelledby="client-alerts" className="mt-8">
        <div className="mb-3 flex min-w-0 items-center gap-3">
          <IconBadge tint="violet" size="sm"><Siren /></IconBadge>
          <h2 id="client-alerts" className="min-w-0 font-serif text-lg">Alerts standing ({alerts.total.toLocaleString('en-GB')})</h2>
        </div>
        <AlertsTable list={alerts} organisations={[organisation]} now={ctx.now()} />
      </section>

      <section aria-labelledby="client-actions" className="mt-8">
        <div className="mb-3 flex min-w-0 items-center gap-3">
          <IconBadge tint="pink" size="sm"><ClipboardCheck /></IconBadge>
          <h2 id="client-actions" className="min-w-0 font-serif text-lg">Open actions ({actions.total.toLocaleString('en-GB')})</h2>
        </div>
        <ActionsTable list={actions} organisations={[organisation]} today={view.today} viewerUserId={ctx.userId} />
      </section>

      <p className="mt-8 flex flex-wrap gap-3 text-sm">
        <ShortcutLink href={`/app/${organisation.slug}/insights`} label="Insights" icon={<BarChart3 aria-hidden="true" />} />
        <ShortcutLink href={`/app/${organisation.slug}/actions`} label="Action Centre" icon={<ClipboardCheck aria-hidden="true" />} />
        <ShortcutLink href={`/app/${organisation.slug}/reports`} label="Reports" icon={<FileText aria-hidden="true" />} />
        <ShortcutLink href={`/app/${organisation.slug}/analyst`} label="Analyst" icon={<Sparkles aria-hidden="true" />} />
        {fundingOn ? <ShortcutLink href={`/app/${organisation.slug}/funding`} label="Funding Readiness" icon={<Landmark aria-hidden="true" />} /> : null}
      </p>
      <Disclaimer />
    </>
  );
}
