import Link from 'next/link';
import { getAccessContext } from '@/modules/tenancy';
import { PageHeader, Card, CardHeader, CardBody, EmptyState, Badge } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDate } from '@/components/labels';
import { loadBanking, loadPeriodScope, type BankingFilter } from '@/modules/dashboard';
import { PeriodHeading } from '../_components/period-heading';
import { FigureTable } from '../_components/figures';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Bank activity for one month (ROUTE_ARCHITECTURE.md §4).
 *
 * The table renders `descriptionNormalized` and nothing else. `description_raw` is not selectable
 * by ANY role — the privilege is revoked from `authenticated` outright (ADR-044.2, R2-A-04) — so
 * there is no version of this page that could leak it, by accident or by a widened query.
 *
 * `?filter=uncategorised` is the destination of the Data quality card's "uncategorised
 * transactions" line (§4 level 4): the link exists so that "improve your data" is a specific job on
 * a specific screen rather than an exhortation.
 */
export default async function BankingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ period?: string; filter?: string }>;
}) {
  const { orgSlug } = await params;
  const { period, filter } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'banking.view');

  const wanted: BankingFilter = filter === 'uncategorised' ? 'uncategorised' : 'all';
  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);

  if (!scope) {
    return (
      <>
        <PageHeader eyebrow="Money" title="Bank activity" />
        <EmptyState
          title="No bank activity yet"
          actionHref={`/app/${orgSlug}/data/imports/new`}
          actionLabel="Add data"
        >
          Upload a bank statement as a CSV or a PDF and every transaction in it will appear here,
          grouped into the month it belongs to.
        </EmptyState>
      </>
    );
  }

  const view = await loadBanking(ctx.db, ctx.orgId!, orgSlug, scope, wanted, ctx.requestId);
  const base = `/app/${orgSlug}/money/banking?period=${scope.period.id}`;

  return (
    <>
      <PeriodHeading
        eyebrow="Money"
        title="Bank activity"
        description="Your accounts and every transaction we hold for this month."
        scope={scope}
        hrefFor={(id) => `/app/${orgSlug}/money/banking?period=${id}`}
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="This month" />
          <CardBody className="px-0 py-0">
            <FigureTable
              rows={view.figures}
              caption={`Money in and out for ${scope.period.label}`}
              comparisonLabel={scope.previous?.label ?? 'the previous month'}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Accounts" />
          <CardBody>
            {view.accounts.length === 0 ? (
              <p className="text-sm text-ink-muted">No bank accounts yet.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {view.accounts.map((account) => (
                  <li key={account.id} className="flex flex-wrap items-baseline gap-x-3">
                    <span>{account.name}</span>
                    <span className="text-ink-muted">{account.reference}</span>
                    <span className="text-ink-muted">
                      balance at the start{' '}
                      <span
                        className="tabular"
                        title={
                          account.needsOpeningBalance
                            ? 'We need an opening balance for this account first.'
                            : undefined
                        }
                      >
                        {account.openingBalance}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Transactions"
            description={
              view.truncated
                ? 'The first 200 transactions of the month are shown.'
                : undefined
            }
            action={
              <nav aria-label="Filter transactions" className="flex gap-3 text-sm">
                <Link
                  href={base}
                  aria-current={view.filter === 'all' ? 'page' : undefined}
                  className={view.filter === 'all' ? 'text-ink' : 'text-ink-muted hover:text-ink'}
                >
                  All
                </Link>
                <Link
                  href={`${base}&filter=uncategorised`}
                  aria-current={view.filter === 'uncategorised' ? 'page' : undefined}
                  className={
                    view.filter === 'uncategorised' ? 'text-ink' : 'text-ink-muted hover:text-ink'
                  }
                >
                  Not yet categorised ({view.uncategorisedCount})
                </Link>
              </nav>
            }
          />
          <CardBody className="px-0 py-0">
            {view.transactions.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-muted">
                {view.filter === 'uncategorised'
                  ? 'Every transaction this month has a category. Nothing to do here.'
                  : 'No transactions in this month.'}
              </p>
            ) : (
              <TableWrap>
                <caption className="sr-only">
                  Bank transactions for {scope.period.label}
                </caption>
                <THead columns={['Date', 'Description', 'Account', 'Category', 'Amount']} />
                <TBody>
                  {view.transactions.map((transaction) => (
                    <TR key={transaction.id}>
                      <TD className="whitespace-nowrap tabular">{formatDate(transaction.date)}</TD>
                      <TD>
                        {transaction.description}
                        {transaction.transferKind ? (
                          <span className="ml-2 text-xs text-ink-muted">
                            {transaction.transferKind}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="text-ink-muted">{transaction.accountName}</TD>
                      <TD>
                        {transaction.uncategorised ? (
                          <Badge tone="warn">{transaction.categoryLabel}</Badge>
                        ) : (
                          transaction.categoryLabel
                        )}
                      </TD>
                      <TD className="whitespace-nowrap text-right tabular">{transaction.amount}</TD>
                    </TR>
                  ))}
                </TBody>
              </TableWrap>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
