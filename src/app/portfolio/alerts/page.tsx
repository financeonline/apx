import { getPortfolioContext, loadPortfolio } from '@/modules/portfolio';
import { PageHeader } from '@/components/ui/surfaces';
import { AlertsTable } from '@/components/portfolio';

export const dynamic = 'force-dynamic';

/** Every alert still standing across the caller's clients, worst first — the alert engine's own rows. */
export default async function PortfolioAlertsPage() {
  const ctx = await getPortfolioContext();
  const view = await loadPortfolio(ctx);
  return (
    <>
      <PageHeader
        eyebrow="Command Centre"
        title={`${view.alerts.length} ${view.alerts.length === 1 ? 'alert' : 'alerts'} standing`}
        description={`${view.counts.criticalAlerts} critical, ${view.counts.highAlerts} high. Open an alert to act on it inside the organisation; acknowledging or resolving happens there, so there is one record of what was decided.`}
      />
      <AlertsTable alerts={view.alerts} organisations={view.organisations} now={ctx.now()} />
    </>
  );
}
