import Link from 'next/link';
import { getAccessContext } from '@/modules/tenancy';
import { PageHeader, Card, CardHeader, CardBody, Badge } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { CustomersNoneEmpty, MetricCard, StatusBadgeView } from '@/components/dashboard';
import { loadCommercialOverview, loadCustomers, loadPeriodScope } from '@/modules/dashboard';
import { PeriodHeading } from '../money/_components/period-heading';
import { FigureTable, WhyLink } from '../money/_components/figures';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Commercial (Phase 14, ADR-102; UX brief §20) on top of "Who the business depends on".
 *
 * The reader's questions, in order: where revenue comes from, which customers matter, what products
 * contribute, which channels produce results, where the pipeline stands. Every money figure is the
 * engine's (`metric_current`) or an aggregation of rows a person recorded; where a rule cannot
 * answer, the page prints why. The customer table and concentration figures below are unchanged.
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
  requirePermission(ctx, 'customers.view');

  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);
  if (!scope) return <CustomersEmpty orgSlug={orgSlug} />;

  const [view, commercial] = await Promise.all([
    loadCustomers(ctx.db, ctx.orgId!, orgSlug, scope, ctx.requestId),
    loadCommercialOverview(ctx.db, ctx.orgId!, orgSlug, scope, ctx.requestId),
  ]);
  if (view.customers.length === 0 && commercial.counts.products === 0 && commercial.counts.opportunities === 0) {
    return <CustomersEmpty orgSlug={orgSlug} />;
  }
  const base = `/app/${orgSlug}/customers`;

  return (
    <>
      <PeriodHeading
        eyebrow="Commercial"
        title="Where the money comes from"
        description="Customers, products, campaigns and the pipeline — each tied to the revenue it produced, never guessed."
        scope={scope}
        hrefFor={(id) => `${base}?period=${id}`}
      />

      <div className="flex flex-col gap-6">
        {commercial.revenue ? <section data-testid="commercial-revenue"><MetricCard card={commercial.revenue} /></section> : null}

        <div className="grid gap-6 md:grid-cols-2 [&>*]:min-w-0">
          <Card>
            <CardHeader title="Top customers" description="Revenue this month, biggest first." action={<Link href={`${base}#customers`} className="text-sm text-ink-muted hover:text-ink">All customers</Link>} />
            <CardBody>
              {commercial.topCustomers.length === 0 ? <p className="text-sm text-ink-muted">No customer revenue for {scope.period.label}.</p> : (
                <ul className="flex flex-col gap-2 text-sm" data-testid="commercial-top-customers">
                  {commercial.topCustomers.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link href={c.href} className="text-ink underline underline-offset-2">{c.name}</Link>
                      <span className="tabular">{c.revenue}{c.share ? <span className="ml-2 text-ink-muted">{c.share}</span> : null}</span>
                    </li>
                  ))}
                </ul>
              )}
              {commercial.unattributedRevenue ? (
                <p className="mt-3 text-xs text-ink-muted" data-testid="commercial-unattributed-revenue">
                  {commercial.unattributedRevenue.amount} of this month’s revenue is not attributed to any customer
                  {commercial.unattributedRevenue.share ? ` (${commercial.unattributedRevenue.share})` : ''}. It is revenue, not a customer, so it is left out of the list above.
                </p>
              ) : null}
              <p className="mt-3 text-xs text-ink-faint">{commercial.customerContributionNote}</p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Top products and services" description="Revenue attributed by invoice lines this month." action={<Link href={`${base}/products`} className="text-sm text-ink-muted hover:text-ink">All products</Link>} />
            <CardBody>
              {commercial.topProducts.length === 0 ? (
                <p className="text-sm text-ink-muted">No products or services recorded yet. Add them under Products, then split invoices into lines to see what each contributes.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm" data-testid="commercial-top-products">
                  {commercial.topProducts.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link href={p.href} className="text-ink underline underline-offset-2">{p.name}</Link>
                      <span className="tabular">{p.revenue}{p.contribution ? <span className="ml-2 text-ink-muted">{p.contribution} contribution</span> : <span className="ml-2 text-xs text-ink-faint">contribution unavailable</span>}</span>
                    </li>
                  ))}
                </ul>
              )}
              {commercial.unattributedProducts && commercial.unattributedProducts.amountRaw !== '0.00' ? (
                <p className="mt-3 text-xs text-ink-muted">{commercial.unattributedProducts.amount} of this month’s sales is not yet attributed to a product ({commercial.unattributedProducts.invoicesWithoutLines} invoice{commercial.unattributedProducts.invoicesWithoutLines === 1 ? '' : 's'} without lines).</p>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Marketing" description="Spend and revenue credited through won opportunities, last twelve months." action={<Link href={`${base}/marketing`} className="text-sm text-ink-muted hover:text-ink">All campaigns</Link>} />
            <CardBody>
              {commercial.topCampaigns.length === 0 ? <p className="text-sm text-ink-muted">No campaigns recorded yet.</p> : (
                <ul className="flex flex-col gap-2 text-sm" data-testid="commercial-marketing">
                  {commercial.topCampaigns.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link href={c.href} className="text-ink underline underline-offset-2">{c.name}</Link>
                      <span className="tabular">{c.spend} spend · {c.attributionStatus === 'no_won_opportunities' ? <span className="text-ink-muted">no revenue attributed</span> : <>{c.attributedRevenue} attributed</>}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Pipeline" action={<Link href={`${base}/sales`} className="text-sm text-ink-muted hover:text-ink">Sales</Link>} />
            <CardBody>
              <p className="text-sm" data-testid="commercial-pipeline">
                <span className="font-mono text-xl tabular-nums text-ink">{commercial.pipeline.openValue}</span>
                <span className="text-ink-muted"> open across {commercial.pipeline.openCount} opportunit{commercial.pipeline.openCount === 1 ? 'y' : 'ies'} · {commercial.pipeline.wonThisMonth} won in {scope.period.label}</span>
              </p>
              <p className="mt-2 text-xs text-ink-muted">
                {commercial.pipeline.conversionNote ?? `Last three months: ${commercial.pipeline.leadToOpportunity ?? '—'} of leads became opportunities, ${commercial.pipeline.opportunityToCustomer ?? '—'} of those were won.`}
              </p>
            </CardBody>
          </Card>
        </div>

        {view.concentration.length > 0 ? (
          <Card>
            <CardHeader title="How much you rely on your top customers" description="The measurement, for you to weigh — a high share is not a verdict." />
            <CardBody className="px-0 py-0">
              <FigureTable rows={view.concentration} caption={`Customer concentration for ${scope.period.label}`} comparisonLabel={scope.previous?.label ?? 'the previous month'} />
              {commercial.concentrationTrend.some((p) => p.top5Text !== null) ? (
                <p className="px-5 py-3 text-xs text-ink-muted">
                  Top 5 share over the last months: {commercial.concentrationTrend.filter((p) => p.top5Text !== null).map((p) => `${p.label} ${p.top5Text}`).join(' · ')}
                </p>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Revenue by customer" />
          <CardBody className="px-0 py-0">
            <div id="customers" />
            {view.customers.length === 0 ? <p className="px-5 py-4 text-sm text-ink-muted">No customer revenue for {scope.period.label}.</p> : (
              <TableWrap>
                <caption className="sr-only">Revenue by customer for {scope.period.label}</caption>
                <THead columns={['Customer', 'Revenue', 'Share of revenue', '']} />
                <TBody>
                  {view.customers.map((customer) => (
                    <TR key={customer.counterpartyId ?? 'unattributed'}>
                      <TD>
                        {customer.href ? <Link href={customer.href} className="underline underline-offset-2">{customer.name}</Link>
                          : <span title="We cannot tell which customer this relates to yet.">{customer.name}</span>}
                      </TD>
                      <TD className="whitespace-nowrap text-right tabular">{customer.revenue.value}</TD>
                      <TD className="whitespace-nowrap text-right tabular">{customer.share}</TD>
                      <TD className="whitespace-nowrap text-right text-sm">
                        {customer.revenue.status.kind === 'not_available' ? null : <StatusBadgeView status={customer.revenue.status} size="sm" />}{' '}
                        <WhyLink row={customer.revenue} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </TableWrap>
            )}
          </CardBody>
        </Card>
        {commercial.concentration.length === 0 && view.customers.length > 0 ? <Badge tone="neutral">Concentration needs a full month of revenue</Badge> : null}
      </div>
    </>
  );
}

function CustomersEmpty({ orgSlug }: { orgSlug: string }) {
  return (
    <>
      <PageHeader eyebrow="Commercial" title="Where the money comes from" />
      <CustomersNoneEmpty addDataHref={`/app/${orgSlug}/data/imports/new`} />
    </>
  );
}
