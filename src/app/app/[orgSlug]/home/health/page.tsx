import Link from 'next/link';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { PageHeader, Card, CardBody } from '@/components/ui/surfaces';
import { loadHealthTrend, loadHome } from '@/modules/dashboard';
import { HealthExplainPanel, HealthHistoryChart, NO_SCORE_FOR_PARTIAL_MONTH } from '@/components/dashboard';

export const dynamic = 'force-dynamic';

/**
 * What makes up the health score (UX_ARCHITECTURE.md §Level 1, FINANCIAL_ENGINE.md §7.4).
 *
 * A deep-linkable page rather than an in-place drawer, following the convention
 * `ROUTE_ARCHITECTURE.md` already sets for the evidence drawer ("drawer as page, deep-linkable"):
 * the explanation of a number is a thing people send to their accountant, and a modal cannot be
 * sent. `/home/health` is not in the §4 route table; recorded as a deviation in ADR-054.
 *
 * Everything on it is read from the stored breakdown. Nothing is recomputed, so the panel cannot
 * disagree with the card that sent the reader here.
 */
export default async function HealthPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  assertCan(ctx, 'dashboard.view');

  const state = await loadHome(ctx.db, ctx.orgId!, orgSlug, ctx.requestId);

  if (state.kind !== 'ready' && state.kind !== 'bank_only') {
    return (
      <>
        <Header orgSlug={orgSlug} />
        <Card>
          <CardBody>
            <p className="text-sm text-ink-muted">
              There is nothing to explain yet — no month has been scored. Add your first month of
              data and the score, and this breakdown, will appear.
            </p>
          </CardBody>
        </Card>
      </>
    );
  }

  const { view } = state;
  const trend = await loadHealthTrend(ctx.db, ctx.orgId!, view.periods, ctx.requestId, view.period.id);

  return (
    <>
      <Header orgSlug={orgSlug} />

      {view.health === null ? (
        <Card>
          <CardBody>
            <p className="text-sm text-ink-muted">{NO_SCORE_FOR_PARTIAL_MONTH}</p>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-6">
          <HealthExplainPanel view={view.health} periodLabel={view.period.label} orgSlug={orgSlug} />

          <Card>
            <CardBody>
              <HealthHistoryChart
                points={trend.points}
                labels={trend.labels}
                tableFallbackId="health-history-table"
              />
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}

function Header({ orgSlug }: { orgSlug: string }) {
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/app/${orgSlug}/home`} className="text-accent underline underline-offset-2">
          Back to Home
        </Link>
      </p>
      <PageHeader
        eyebrow="Home"
        title="Your health score, explained"
        description="Every area we scored, every check inside it, and the points each one contributed."
      />
    </>
  );
}
