import Link from 'next/link';
import {
  Activity, Building2, CircleCheck, CircleDashed, ClipboardCheck, ClockAlert, History, Lightbulb, ShieldAlert, Siren,
  Sparkles, TriangleAlert, UsersRound,
} from 'lucide-react';
import { ATTENTION_CAP, OPPORTUNITY_CAP, getPortfolioContext, loadOpportunities, loadPortfolio } from '@/modules/portfolio';
import { PageHeader, Card, CardBody, CardHeader, EmptyState, IconBadge, StatTile } from '@/components/ui/surfaces';
import { Disclaimer } from '@/components/dashboard';
import { AttentionQueue, ClientTable, RecentChanges } from '@/components/portfolio';
import { OpportunityList } from './_components/opportunities';

export const dynamic = 'force-dynamic';

/**
 * The Command Centre's first screen answers "what needs my attention?" before anything else
 * (SOW §18; brief §15): the queue, then the counts, then every client, then what changed.
 */
export default async function PortfolioPage() {
  const ctx = await getPortfolioContext();
  // ADR-114 §6: an employee before their first assignment has an empty Command Centre, not a 404.
  if (ctx.organisations.length === 0) {
    return (
      <>
        <PageHeader eyebrow="Command Centre" title="Your client organisations" />
        <EmptyState title="You haven't been assigned to any organisations yet.">
          An APX administrator assigns organisations to you. When that happens they&apos;ll appear here, with their health, alerts and actions.
        </EmptyState>
      </>
    );
  }

  const view = await loadPortfolio(ctx);
  const opportunities = await loadOpportunities(ctx, view);
  const now = ctx.now();
  const shown = view.attention.slice(0, ATTENTION_CAP);

  return (
    <>
      <PageHeader
        eyebrow="Command Centre"
        title={view.counts.needingAttention === 0
          ? `All ${view.counts.clients} ${view.counts.clients === 1 ? 'client is' : 'clients are'} clear`
          : `${view.counts.needingAttention} of ${view.counts.clients} ${view.counts.clients === 1 ? 'client needs' : 'clients need'} attention`}
        description="Health, alerts and actions across the organisations you advise, from APX's own figures. Nothing here is worked out on the way to the screen."
        action={<Link href="/portfolio/analyst" className="inline-flex items-center gap-1.5 rounded-xl border border-accent/45 bg-surface px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft"><Sparkles aria-hidden="true" className="size-4" />Ask the adviser analyst</Link>}
      />

      <section aria-labelledby="attention" className="mb-10">
        <div className="mb-3 flex min-w-0 items-center gap-3">
          <IconBadge tint="pink" size="sm"><ShieldAlert /></IconBadge>
          <h2 id="attention" className="min-w-0 font-serif text-lg">Clients needing attention</h2>
        </div>
        <AttentionQueue rows={shown} today={view.today} now={now} />
        {shown.length < view.attention.length ? (
          <p className="mt-3 text-sm text-ink-muted" role="status">
            Showing the {shown.length} most pressing of {view.attention.length}. Every client is in the list below.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="opportunities" className="mb-10">
        <div className="mb-1 flex min-w-0 items-center gap-3">
          <IconBadge tint="violet" size="sm"><Lightbulb /></IconBadge>
          <h2 id="opportunities" className="min-w-0 font-serif text-lg">Advisory opportunities</h2>
        </div>
        <p className="mb-3 text-sm text-ink-muted">Where a client&apos;s latest figures suggest a conversation worth having — from fixed rules, with the facts behind each.</p>
        <OpportunityList entries={opportunities.slice(0, OPPORTUNITY_CAP)} organisations={view.organisations} withActions={false} />
        {opportunities.length > OPPORTUNITY_CAP ? (
          <p className="mt-3 text-sm text-ink-muted" role="status">
            Showing {OPPORTUNITY_CAP} of {opportunities.length} clients with opportunities. Each client&apos;s page lists its own.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="overview" className="mb-10">
        <div className="mb-3 flex min-w-0 items-center gap-3">
          <IconBadge tint="pink" size="sm"><Activity /></IconBadge>
          <h2 id="overview" className="min-w-0 font-serif text-lg">Portfolio overview</h2>
        </div>
        <ul className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-4">
          <li className="min-w-0">
            <StatTile label="Clients" value={view.counts.clients.toLocaleString('en-GB')} icon={<UsersRound />} tint="violet" />
          </li>
          <li className="min-w-0">
            <StatTile
              label="Need attention"
              value={view.counts.needingAttention.toLocaleString('en-GB')}
              icon={<TriangleAlert />}
              tint="pink"
              valueClassName={view.counts.needingAttention > 0 ? 'text-warn' : 'text-ink'}
            />
          </li>
          <li className="min-w-0">
            <StatTile label="Healthy" value={view.counts.healthy.toLocaleString('en-GB')} icon={<CircleCheck />} tint="violet" />
          </li>
          <li className="min-w-0">
            <StatTile label="Not yet scored" value={view.counts.unscored.toLocaleString('en-GB')} icon={<CircleDashed />} tint="pink" />
          </li>
          <li className="min-w-0">
            <Link href="/portfolio/alerts" className="block rounded-card transition-shadow hover:ring-2 hover:ring-accent/30">
              <StatTile
                label="Critical alerts"
                value={view.counts.criticalAlerts.toLocaleString('en-GB')}
                icon={<Siren />}
                tint="violet"
                valueClassName={view.counts.criticalAlerts > 0 ? 'text-danger' : 'text-ink'}
              />
            </Link>
          </li>
          <li className="min-w-0">
            <Link href="/portfolio/alerts" className="block rounded-card transition-shadow hover:ring-2 hover:ring-accent/30">
              <StatTile
                label="High alerts"
                value={view.counts.highAlerts.toLocaleString('en-GB')}
                icon={<ShieldAlert />}
                tint="pink"
                valueClassName={view.counts.highAlerts > 0 ? 'text-warn' : 'text-ink'}
              />
            </Link>
          </li>
          <li className="min-w-0">
            <Link href="/portfolio/actions" className="block rounded-card transition-shadow hover:ring-2 hover:ring-accent/30">
              <StatTile label="Open actions" value={view.counts.openActions.toLocaleString('en-GB')} icon={<ClipboardCheck />} tint="violet" />
            </Link>
          </li>
          <li className="min-w-0">
            <Link href="/portfolio/actions?view=overdue" className="block rounded-card transition-shadow hover:ring-2 hover:ring-accent/30">
              <StatTile
                label="Overdue actions"
                value={view.counts.overdueActions.toLocaleString('en-GB')}
                icon={<ClockAlert />}
                tint="pink"
                valueClassName={view.counts.overdueActions > 0 ? 'text-danger' : 'text-ink'}
              />
            </Link>
          </li>
        </ul>
      </section>

      <section aria-labelledby="clients" className="mb-10">
        <div className="mb-3 flex min-w-0 items-center gap-3">
          <IconBadge tint="violet" size="sm"><Building2 /></IconBadge>
          <h2 id="clients" className="min-w-0 font-serif text-lg">Every client</h2>
        </div>
        <ClientTable rows={view.clients} />
      </section>

      <section aria-labelledby="recent" className="mb-10">
        <Card>
          <CardHeader icon={<History />} tint="pink" title="Recent changes" description="Alerts raised and actions finished in the last seven days." />
          <CardBody>
            <RecentChanges changes={view.recent} organisations={view.organisations} now={now} />
          </CardBody>
        </Card>
      </section>

      <Disclaimer />
    </>
  );
}
