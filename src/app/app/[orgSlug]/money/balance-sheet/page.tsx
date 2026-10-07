import Link from 'next/link';
import { Building2, HandCoins, Landmark, ShieldCheck } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { loadBalanceSheet, loadPeriodScope } from '@/modules/dashboard';
import { Banner, Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/components/ui/surfaces';
import { PeriodHeading } from '../_components/period-heading';
import { FigureTable } from '../_components/figures';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Assets and borrowing at the month end (ADR-156; owner, 2026-10-07): fixed and current assets, and
 * loans split secured / unsecured. Every figure is the engine's, from the month's trial balance or
 * balance sheet; a month without one shows "—" with that reason, never £0.
 */
export default async function BalanceSheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { orgSlug } = await params;
  const { period } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'financials.view');

  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);
  if (!scope) {
    return (
      <>
        <PageHeader eyebrow="Money" title="Balance sheet" />
        <EmptyState title="There are no balance sheet figures yet" actionHref={`/app/${orgSlug}/data/imports/new`} actionLabel="Add data">
          Assets and loans come from a trial balance or a balance sheet. Upload one and this page will show
          what the business owns and what it owes.
        </EmptyState>
      </>
    );
  }

  const view = await loadBalanceSheet(ctx.db, ctx.orgId!, orgSlug, scope, ctx.requestId);
  const comparison = scope.previous?.label ?? 'the previous month';

  return (
    <>
      <PeriodHeading
        eyebrow="Money"
        title="Balance sheet"
        description="What the business owns and what it owes on borrowing at the month end, from your trial balance or balance sheet."
        scope={scope}
        hrefFor={(id) => `/app/${orgSlug}/money/balance-sheet?period=${id}`}
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="Assets" description="Fixed assets are held for the long term; current assets turn into cash within a year." icon={<Building2 />} />
          <CardBody className="px-0 py-0">
            <FigureTable rows={view.assets} caption={`Assets at the end of ${scope.period.label}`} comparisonLabel={comparison} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Borrowing" description="As your accounts are categorised: loans, and long-term liabilities." icon={<Landmark />} tint="pink" />
          <CardBody className="px-0 py-0">
            <FigureTable rows={view.borrowing} caption={`Borrowing at the end of ${scope.period.label}`} comparisonLabel={comparison} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Secured and unsecured loans" description="As you marked each loan account. MOTION never guesses it from a name." icon={<ShieldCheck />} />
          <CardBody className="px-0 py-0">
            <FigureTable rows={view.security} caption={`Loans by security at the end of ${scope.period.label}`} comparisonLabel={comparison} />
          </CardBody>
        </Card>

        {view.unmarkedLoans ? (
          <Banner tone="info" title="Some loans are not marked secured or unsecured yet">
            {can(ctx, 'financials.edit') ? (
              <>
                Mark each loan account on{' '}
                <Link href={`/app/${orgSlug}/data/accounts`} className="text-accent underline underline-offset-2">Accounts</Link>{' '}
                and the split above updates.
              </>
            ) : 'Someone who can edit the accounts can mark each loan secured or unsecured.'}
          </Banner>
        ) : null}

        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <HandCoins aria-hidden="true" className="size-4 text-accent" />
          Secured, unsecured and not yet marked add up to the borrowing owed.
        </p>
      </div>
    </>
  );
}
