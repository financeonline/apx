import { ChartColumn, Receipt, TrendingUp } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { PageHeader, Card, CardHeader, CardBody, EmptyState } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody } from '@/components/ui/table';
import { loadPeriodScope, loadProfitAndLoss } from '@/modules/dashboard';
import { PeriodHeading } from '../_components/period-heading';
import { FigureRow, FigureTable } from '../_components/figures';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Profit and loss for one month (ROUTE_ARCHITECTURE.md §4, UX_ARCHITECTURE.md §8.1).
 *
 * This is a Money sub-page, so the accountant's terms are allowed — "Revenue", "Gross margin" — and
 * pence are shown (§8.1, §8.2). Every line is a snapshot from `metric_current`; the spending
 * breakdown is the dimensioned `expense_by_category` snapshots, not a sum taken here.
 */
export default async function ProfitAndLossPage({
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
        <PageHeader eyebrow="Money" title="Profit & loss" />
        <EmptyState
          title="There is no profit and loss to show yet"
          actionHref={`/app/${orgSlug}/data/imports/new`}
          actionLabel="Add data"
        >
          A profit and loss comes from a ledger export, a trial balance or a profit-and-loss report.
          Bank statements on their own show cash, not profit.
        </EmptyState>
      </>
    );
  }

  const view = await loadProfitAndLoss(ctx.db, ctx.orgId!, orgSlug, scope, ctx.requestId);
  const comparison = scope.previous?.label ?? 'the previous month';

  return (
    <>
      <PeriodHeading
        eyebrow="Money"
        title="Profit & loss"
        description={`Compared with ${comparison}. Figures are shown to the penny.`}
        scope={scope}
        hrefFor={(id) => `/app/${orgSlug}/money/profit-and-loss?period=${id}`}
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="Trading" description="What was earned, and what it cost to earn it." icon={<ChartColumn />} />
          <CardBody className="px-0 py-0">
            <FigureTable
              rows={view.above}
              caption={`Revenue, cost of sales and gross profit for ${scope.period.label}`}
              comparisonLabel={comparison}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Spending by category"
            description="Each category as the engine recorded it for this month, biggest first."
            icon={<Receipt />}
            tint="pink"
          />
          <CardBody className="px-0 py-0">
            {view.spending.length === 0 && !view.spendingKnown ? (
              <p className="px-5 py-4 text-sm text-ink-muted">
                This month&apos;s spending isn&apos;t known: no source you have added covers it. If you
                import invoice lists, a full purchase list must cover the month — and, for the current
                month, reach the same day as your sales list.
              </p>
            ) : view.spending.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-muted">
                Nothing was recorded against a spending category this month.
              </p>
            ) : (
              <TableWrap stack>
                <caption className="sr-only">
                  Spending by category for {scope.period.label}
                </caption>
                <THead columns={['Category', 'Amount', `Change vs ${comparison}`, '']} />
                <TBody>
                  {view.spending.map((row) => (
                    <FigureRow key={row.key} row={row.figure} label={row.label} changeLabel={`Change vs ${comparison}`} />
                  ))}
                </TBody>
              </TableWrap>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Profit"
            description="Running costs, then interest and tax, then what is left."
            icon={<TrendingUp />}
          />
          <CardBody className="px-0 py-0">
            <FigureTable
              rows={view.below}
              caption={`Operating profit, interest, tax and net profit for ${scope.period.label}`}
              comparisonLabel={comparison}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
