import Link from 'next/link';
import { getPortfolioContext, loadPortfolio } from '@/modules/portfolio';
import { PageHeader, Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { Disclaimer } from '@/components/dashboard';
import { AttentionQueue, ClientTable, CountsStrip, RecentChanges } from '@/components/portfolio';

export const dynamic = 'force-dynamic';

/**
 * The Command Centre's first screen answers "what needs my attention?" before anything else
 * (SOW §18; brief §15): the queue, then the counts, then every client, then what changed.
 */
export default async function PortfolioPage() {
  const ctx = await getPortfolioContext();
  const view = await loadPortfolio(ctx);
  const now = ctx.now();

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
        <AttentionQueue rows={view.attention} today={view.today} now={now} />
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
