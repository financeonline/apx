import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { Card, CardHeader, CardBody, Badge } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDate } from '@/components/labels';
import { loadCustomerCommercial, loadCustomerDetail, loadPeriodScope } from '@/modules/dashboard';
import { PeriodHeading } from '../../money/_components/period-heading';
import { FigureTable } from '../../money/_components/figures';
import { InvoiceLinesForm } from './lines-form';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/** Every entity id is a UUID and is validated before any query (ROUTE_ARCHITECTURE.md §10). */
const CounterpartyId = z.string().uuid();

/**
 * One customer (ROUTE_ARCHITECTURE.md §4; Phase 14 additions per ADR-102).
 *
 * Their revenue this month, how it has moved over the last year, and the invoices behind it — plus,
 * from Commercial: their contribution (with the shared-overhead caveat stated), which products they
 * buy, how they were won, their open opportunities, and the line split of each invoice. A
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
  requirePermission(ctx, 'customers.view');
  const mayEdit = can(ctx, 'customers.edit');

  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);
  if (!scope) notFound();

  const view = await loadCustomerDetail(
    ctx.db, ctx.orgId!, orgSlug, scope, parsed.data,
    ctx.now().toISOString().slice(0, 10),
    ctx.requestId,
  );
  if (!view) notFound();
  const commercial = await loadCustomerCommercial(
    ctx.db, ctx.orgId!, orgSlug, scope, view.counterparty, view.invoices.map((i) => i.id), ctx.requestId,
  );

  const figures = [view.revenue, view.share, commercial.contribution].filter((f) => f !== null);

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
              <>
                <FigureTable
                  rows={figures}
                  caption={`Revenue from ${view.counterparty.name} in ${scope.period.label}`}
                  comparisonLabel={scope.previous?.label ?? 'the previous month'}
                />
                <p className="px-5 py-3 text-xs text-ink-muted" data-testid="customer-contribution-note">{commercial.contributionNote}</p>
              </>
            )}
          </CardBody>
        </Card>

        <div className="grid gap-6 md:grid-cols-2 [&>*]:min-w-0">
          <Card>
            <CardHeader title="What they buy" description="Share of this customer’s attributed revenue over the last twelve months." />
            <CardBody>
              {commercial.products.length === 0 ? (
                <p className="text-sm text-ink-muted">No invoice has been split into products yet{mayEdit ? ' — use “Split into lines” under an invoice below' : ''}.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm" data-testid="customer-products">
                  {commercial.products.map((p) => (
                    <li key={p.productId} className="flex flex-wrap justify-between gap-2">
                      <Link href={p.href} className="underline underline-offset-2">{p.name}</Link>
                      <span className="tabular">{p.revenue}{p.share ? <span className="ml-2 text-ink-muted">{p.share}</span> : null}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="How they were won" />
            <CardBody>
              {commercial.wonThrough.length === 0 ? (
                <p className="text-sm text-ink-muted">No won opportunity names this customer, so no campaign is credited with them.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm" data-testid="customer-won-through">
                  {commercial.wonThrough.map((w) => (
                    <li key={`${w.campaignId}-${w.wonOn}`} className="flex flex-wrap justify-between gap-2">
                      <Link href={w.href} className="underline underline-offset-2">{w.name}</Link>
                      <span className="text-ink-muted">won {formatDate(w.wonOn)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {commercial.opportunities.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-sm">
                  {commercial.opportunities.map((o) => (
                    <li key={o.id} className="flex flex-wrap justify-between gap-2">
                      <span>{o.name} <Badge tone="neutral">{o.stageLabel}</Badge></span>
                      <span className="tabular text-ink-muted">{o.value ?? ''}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardBody>
          </Card>
        </div>

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
          <CardHeader title="Their invoices" description={mayEdit ? 'Split an invoice into products or services to see what each one contributes.' : undefined} />
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
                <THead columns={['Invoice', 'Issued', 'Due', 'Aging', 'Outstanding', 'Lines']} />
                <TBody>
                  {view.invoices.map((invoice) => {
                    const lines = commercial.invoiceLines.get(invoice.id) ?? [];
                    const net = commercial.invoiceNets.get(invoice.id) ?? null;
                    return (
                      <TR key={invoice.id}>
                        <TD className="tabular">{invoice.number}</TD>
                        <TD className="whitespace-nowrap tabular">{formatDate(invoice.issueDate)}</TD>
                        <TD className="whitespace-nowrap tabular">
                          {invoice.dueDate ? formatDate(invoice.dueDate) : '—'}
                        </TD>
                        <TD className="whitespace-nowrap">{invoice.bucketLabel}</TD>
                        <TD className="whitespace-nowrap text-right tabular">{invoice.balanceDue}</TD>
                        <TD>
                          {lines.length === 0 ? <span className="text-xs text-ink-muted">Not yet attributed</span> : (
                            <ul className="text-xs" data-testid={`lines-${invoice.number}`}>
                              {lines.map((l) => <li key={l.id}>{l.productName ?? 'No product'} · <span className="tabular">{l.amount}</span>{l.description ? <span className="text-ink-muted"> — {l.description}</span> : null}</li>)}
                            </ul>
                          )}
                          {mayEdit && net !== null ? (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-xs text-ink-muted underline">Split into lines</summary>
                              <div className="mt-2">
                                <InvoiceLinesForm orgSlug={orgSlug} counterpartyId={parsed.data} invoiceId={invoice.id} net={net} existing={lines} products={commercial.productOptions} />
                              </div>
                            </details>
                          ) : null}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </TableWrap>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
