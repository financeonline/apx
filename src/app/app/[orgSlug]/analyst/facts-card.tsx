import { MetricCard } from '@/components/dashboard/metric-card';
import { Card, CardBody } from '@/components/ui/surfaces';
import type { HomeView } from '@/modules/dashboard';

/**
 * "Facts we can show you" (UX_ARCHITECTURE.md §7.2): when the analyst is unavailable, the current
 * snapshots for the latest complete month, exactly as Home renders them — deterministic, model-free.
 *
 * A server component, rendered once by the page and handed to the chat shell as a node: `MetricCard`
 * reaches the data layer through the status rules, so it cannot live in the browser bundle, and the
 * figures it shows were formatted on the server anyway. The client shows the node; it computes nothing.
 */
export const FACTS_TITLE = 'Facts we can show you';

export function FactsCard({ view }: { view: HomeView }) {
  if (view.cards.length === 0) return null;
  return (
    <Card>
      <CardBody className="p-4">
        <h3 className="text-sm font-medium text-ink">{FACTS_TITLE}</h3>
        <p className="mt-1 text-xs text-ink-muted">From your current figures for {view.period.label}, without the analyst.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {view.cards.map((card) => <MetricCard key={card.metricKey} card={card} variant="compact" />)}
        </div>
      </CardBody>
    </Card>
  );
}
