import Link from 'next/link';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { CustomersNoneEmpty, StatusBadgeView } from '@/components/dashboard';
import { loadCustomers, loadPeriodScope } from '@/modules/dashboard';
import { PeriodHeading } from '../money/_components/period-heading';
import { FigureTable, WhyLink } from '../money/_components/figures';

export const dynamic = 'force-dynamic';

/**
 * Who the business depends on (UX_ARCHITECTURE.md §3.1, ROUTE_ARCHITECTURE.md §4).
 *
 * Ranked by revenue for the month, with the concentration figures above: the question this page
 * answers is not "who bought things" but "how much of this business rests on one customer" (§8.1,
 * "How much you rely on your top customers").
 *
 * Both the ranking and the concentration are snapshots. The order of the rows is a comparison of
 * stored values, never a sum taken here.
 */
export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { orgSlug } = await params;
  const { period } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  assertCan(ctx, 'customers.view');

  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);
  if (!scope) return <CustomersEmpty orgSlug={orgSlug} />;

  const view = await loadCustomers(ctx.db, ctx.orgId!, orgSlug, scope, ctx.requestId);
  if (view.customers.length === 0) return <CustomersEmpty orgSlug={orgSlug} />;

  return (
    <>
      <PeriodHeading
        eyebrow="Customers"
        title="Who the business depends on"
        description="Revenue by customer for the month, biggest first."
        scope={scope}
        hrefFor={(id) => `/app/${orgSlug}/customers?period=${id}`}
      />

      <div className="flex flex-col gap-6">
        {view.concentration.length > 0 ? (
          <Card>
            <CardHeader
              title="How much you rely on your top customers"
              description="A high share is not a problem in itself — it is a risk worth knowing about."
            />
            <CardBody className="px-0 py-0">
              <FigureTable
                rows={view.concentration}
                caption={`Customer concentration for ${scope.period.label}`}
                comparisonLabel={scope.previous?.label ?? 'the previous month'}
              />
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Revenue by customer" />
          <CardBody className="px-0 py-0">
            <TableWrap>
              <caption className="sr-only">Revenue by customer for {scope.period.label}</caption>
              <THead columns={['Customer', 'Revenue', 'Share of revenue', '']} />
              <TBody>
                {view.customers.map((customer) => (
                  <TR key={customer.counterpartyId ?? 'unattributed'}>
                    <TD>
                      {customer.href ? (
                        <Link href={customer.href} className="underline underline-offset-2">
                          {customer.name}
                        </Link>
                      ) : (
                        <span title="We cannot tell which customer this relates to yet.">
                          {customer.name}
                        </span>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-right tabular">
                      {customer.revenue.value}
                    </TD>
                    <TD className="whitespace-nowrap text-right tabular">{customer.share}</TD>
                    <TD className="whitespace-nowrap text-right text-sm">
                      {customer.revenue.status.kind === 'not_available' ? null : (
                        <StatusBadgeView status={customer.revenue.status} size="sm" />
                      )}{' '}
                      <WhyLink row={customer.revenue} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </TableWrap>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

/** §6 "Customers, no invoices or customer-tagged entries", from the shared exact copy. */
function CustomersEmpty({ orgSlug }: { orgSlug: string }) {
  return (
    <>
      <PageHeader title="Who the business depends on" />
      <CustomersNoneEmpty addDataHref={`/app/${orgSlug}/data/imports/new`} />
    </>
  );
}
