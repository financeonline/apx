import { getPortfolioContext, loadPortfolio, loadPortfolioAlerts } from '@/modules/portfolio';
import { PageHeader } from '@/components/ui/surfaces';
import { AlertsTable } from '@/components/portfolio';

export const dynamic = 'force-dynamic';

/**
 * Every alert still standing across the caller's clients — the alert engine's own rows. The counts
 * are the full population (ADR-114); the list is the worst first and says when it is capped.
 */
export default async function PortfolioAlertsPage() {
  const ctx = await getPortfolioContext();
  const view = await loadPortfolio(ctx);
  const list = await loadPortfolioAlerts(ctx, view);
  const { alertsStanding, criticalAlerts, highAlerts } = view.counts;
  return (
    <>
      <PageHeader
        eyebrow="Command Centre"
        title={`${alertsStanding.toLocaleString('en-GB')} ${alertsStanding === 1 ? 'alert' : 'alerts'} standing`}
        description={`${criticalAlerts.toLocaleString('en-GB')} critical, ${highAlerts.toLocaleString('en-GB')} high. Open an alert to act on it inside the organisation; acknowledging or resolving happens there, so there is one record of what was decided.`}
      />
      <AlertsTable list={list} organisations={view.organisations} now={ctx.now()} />
    </>
  );
}
