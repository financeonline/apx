import { notFound } from 'next/navigation';
import { z } from 'zod';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { Card, CardHeader, CardBody } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDate } from '@/components/labels';
import { loadCustomerDetail, loadPeriodScope } from '@/modules/dashboard';
import { PeriodHeading } from '../../money/_components/period-heading';
import { FigureTable } from '../../money/_components/figures';

export const dynamic = 'force-dynamic';

/** Every entity id is a UUID and is validated before any query (ROUTE_ARCHITECTURE.md §10). */
const CounterpartyId = z.string().uuid();

/**
 * One customer (ROUTE_ARCHITECTURE.md §4).
 *
 * Their revenue this month, how it has moved over the last year, and the invoices behind it. A
 * counterparty id belonging to another organisation never resolves — RLS does not return it — and
 * the page answers with the uniform 404 rather than confirming it exists (§10).
 */
export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; counterpartyId: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { orgSlug, counterpartyId } = await params;
  const { period } = await searchParams;
  const parsed = CounterpartyId.safeParse(counterpartyId);
  if (!parsed.success) notFound();

  const ctx = await getAccessContext(orgSlug);
  assertCan(ctx, 'customers.view');

  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);
  if (!scope) notFound();

  const view = await loadCustomerDetail(
    ctx.db, ctx.orgId!, orgSlug, scope, parsed.data,
    ctx.now().toISOString().slice(0, 10),
    ctx.requestId,
  );
  if (!view) notFound();

  const figures = [view.revenue, view.share].filter((f) => f !== null);

  return (
    <>
      <PeriodHeading
        eyebrow="Customers"
        title={view.counterparty.name}
        description="What this customer is worth to the business, and what they still owe."
        scope={scope}
        hrefFor={(id) => `/app/${orgSlug}/customers/${parsed.data}?period=${id}`}
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="This month" />
          <CardBody className={figures.length === 0 ? '' : 'px-0 py-0'}>
            {figures.length === 0 ? (
              <p className="text-sm text-ink-muted">
                We have no revenue figure for this customer in {scope.period.label}.
              </p>
            ) : (
              <FigureTable
                rows={figures}
                caption={`Revenue from ${view.counterparty.name} in ${scope.period.label}`}
                comparisonLabel={scope.previous?.label ?? 'the previous month'}
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Revenue over time"
            description="A month with no figure is a gap, not a zero."
          />
          <CardBody className="px-0 py-0">
            <TableWrap>
              <caption className="sr-only">
                Monthly revenue from {view.counterparty.name}
              </caption>
              <THead columns={['Month', 'Revenue']} />
              <TBody>
                {view.trend.map((point) => (
                  <TR key={point.periodId}>
                    <TD>{point.label}</TD>
                    <TD
                      className={`text-right tabular ${
                        point.rawValue === null ? 'text-ink-faint' : ''
                      }`.trim()}
                    >
                      {point.value}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </TableWrap>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Their invoices" />
          <CardBody className={view.invoices.length === 0 ? '' : 'px-0 py-0'}>
            {view.invoices.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No sales invoices for this customer yet.
              </p>
            ) : (
              <TableWrap>
                <caption className="sr-only">
                  Sales invoices for {view.counterparty.name}
                </caption>
                <THead columns={['Invoice', 'Issued', 'Due', 'Aging', 'Outstanding']} />
                <TBody>
                  {view.invoices.map((invoice) => (
                    <TR key={invoice.id}>
                      <TD className="tabular">{invoice.number}</TD>
                      <TD className="whitespace-nowrap tabular">{formatDate(invoice.issueDate)}</TD>
                      <TD className="whitespace-nowrap tabular">
                        {invoice.dueDate ? formatDate(invoice.dueDate) : '—'}
                      </TD>
                      <TD className="whitespace-nowrap">{invoice.bucketLabel}</TD>
                      <TD className="whitespace-nowrap text-right tabular">{invoice.balanceDue}</TD>
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
