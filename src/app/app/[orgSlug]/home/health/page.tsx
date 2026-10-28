import Link from 'next/link';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardBody } from '@/components/ui/surfaces';
import { loadHealthTrend, loadHome } from '@/modules/dashboard';
import { HealthExplainPanel, HealthHistoryChart, NO_SCORE_FOR_PARTIAL_MONTH } from '@/components/dashboard';
import { requirePermission } from '@/app/_lib/authz';

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
  requirePermission(ctx, 'dashboard.view');

  const state = await loadHome(ctx.db, ctx.orgId!, orgSlug, ctx.requestId, {
    suspended: ctx.organizationStatus === 'suspended',
  });

  if (state.kind !== 'ready' && state.kind !== 'bank_only') {
    return (
      <>
        <Header orgSlug={orgSlug} />
        <Card>
          <CardBody>
            <p className="text-sm text-ink-muted">
              {can(ctx, 'imports.create')
                ? 'There is nothing to explain yet — no month has been scored. Add your first month of data and the score, and this breakdown, will appear.'
                : 'There is nothing to explain yet — no month has been scored. The score, and this breakdown, will appear once the company has added a month of data.'}
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
          <HowToRead withLinks={can(ctx, 'financials.view')} />
          {/*
            The panel links each dimension's figures to their evidence, which is detail
            (`financials.view`). Without it (a 3rd party, ADR-172) the arithmetic is shown in full and
            the links are left out — never a link into a refusal. Such a reader is also handed the
            REDACTED breakdown (`health_score_breakdowns`, ADR-172 hardening: no subject, record or
            snapshot ids); every field the panel prints — rules, results, points, weights, caps,
            exclusions and the factor sentences — survives the redaction, so it renders the same
            arithmetic. Checked as a client with `financials.view` switched off (2026-10-14).
          */}
          <HealthExplainPanel
            view={view.health}
            periodLabel={view.period.label}
            orgSlug={can(ctx, 'financials.view') ? orgSlug : undefined}
          />

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
        description="Why your score is what it is: each area of the business we looked at, the checks inside it, and how many points each check gave or took away."
      />
    </>
  );
}

/**
 * The reading instructions, once, above the arithmetic.
 *
 * The panel below prints every rule so the score can be checked with a calculator; an owner meeting
 * it cold needs to be told how the rows add up first (the baseline of 50, points up or down, areas
 * weighted), or the tables read as a wall of thresholds. Words only — no figure here is computed.
 */
function HowToRead({ withLinks }: { withLinks: boolean }) {
  return (
    <Card>
      <CardBody>
        <h2 className="text-base text-ink">How to read this page</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-muted">
          <li>Every area starts at 50 points.</li>
          <li>Each check then adds points when that part of your figures looks good, or takes points away when it needs a look.</li>
          <li>Your overall score blends the areas. The share shown under each area&apos;s score is how much it counts towards the total.</li>
          <li>
            Under each area, &ldquo;What needs a look&rdquo; is the place to start.
            {withLinks ? <> The links under &ldquo;The figures this used&rdquo; open the numbers behind it.</> : null}
          </li>
        </ul>
      </CardBody>
    </Card>
  );
}
