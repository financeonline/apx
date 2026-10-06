import Link from 'next/link';
import { ATTENTION_CAP, OPPORTUNITY_CAP, getPortfolioContext, loadOpportunities, loadPortfolio } from '@/modules/portfolio';
import { PageHeader, Card, CardBody, CardHeader, EmptyState } from '@/components/ui/surfaces';
import { Disclaimer } from '@/components/dashboard';
import { AttentionQueue, ClientTable, CountsStrip, RecentChanges } from '@/components/portfolio';
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
          A MOTION administrator assigns organisations to you. When that happens they&apos;ll appear here, with their health, alerts and actions.
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
        description="Health, alerts and actions across the organisations you advise, from MOTION's own figures. Nothing here is worked out on the way to the screen."
        action={<Link href="/portfolio/analyst" className="text-sm text-accent underline underline-offset-2">Ask the adviser analyst</Link>}
      />

      <section aria-labelledby="attention" className="mb-10">
        <h2 id="attention" className="mb-3 font-serif text-lg">Clients needing attention</h2>
        <AttentionQueue rows={shown} today={view.today} now={now} />
        {shown.length < view.attention.length ? (
          <p className="mt-3 text-sm text-ink-muted" role="status">
            Showing the {shown.length} most pressing of {view.attention.length}. Every client is in the list below.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="opportunities" className="mb-10">
        <h2 id="opportunities" className="mb-1 font-serif text-lg">Advisory opportunities</h2>
        <p className="mb-3 text-sm text-ink-muted">Where a client&apos;s latest figures suggest a conversation worth having — from fixed rules, with the facts behind each.</p>
        <OpportunityList entries={opportunities.slice(0, OPPORTUNITY_CAP)} organisations={view.organisations} withActions={false} />
        {opportunities.length > OPPORTUNITY_CAP ? (
          <p className="mt-3 text-sm text-ink-muted" role="status">
            Showing {OPPORTUNITY_CAP} of {opportunities.length} clients with opportunities. Each client&apos;s page lists its own.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="overview" className="mb-10">
        <h2 id="overview" className="mb-3 font-serif text-lg">Portfolio overview</h2>
        <CountsStrip counts={view.counts} />
      </section>

      <section aria-labelledby="clients" className="mb-10">
        <h2 id="clients" className="mb-3 font-serif text-lg">Every client</h2>
        <ClientTable rows={view.clients} />
      </section>

      <section aria-labelledby="recent" className="mb-10">
        <Card>
          <CardHeader title="Recent changes" description="Alerts raised and actions finished in the last seven days." />
          <CardBody>
            <RecentChanges changes={view.recent} organisations={view.organisations} now={now} />
          </CardBody>
        </Card>
      </section>

      <Disclaimer />
    </>
  );
}
