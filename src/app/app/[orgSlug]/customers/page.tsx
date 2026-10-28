import Link from 'next/link';
import { ChartColumn, ChevronRight, Megaphone, Package, Target, Users, UsersRound } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { PageHeader, Card, CardHeader, CardBody, Badge } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { ABOVE_CARD_LINK, CLICKABLE_CARD, CardLink, TOUCH_TARGET } from '@/components/ui/clickable-card';
import { CustomersNoneEmpty, MetricCard, StatusBadgeView } from '@/components/dashboard';
import { loadCommercialOverview, loadCustomers, loadPeriodScope } from '@/modules/dashboard';
import { PeriodHeading } from '../money/_components/period-heading';
import { FigureTable, WhyLink } from '../money/_components/figures';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * An outlined pill for a card's "see all" link, as the Departments cards' "Open" (ADR-155). It is the
 * card's one link, stretched over the whole card (owner, 2026-10-14; `ui/clickable-card`): the names
 * listed in the card sit above it and open their own pages.
 */
const PILL = `inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft group-hover:border-accent group-hover:bg-accent-soft ${TOUCH_TARGET}`;
const CHEVRON = <ChevronRight aria-hidden="true" className="size-4" />;

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
  // A count of rows, not a sum of money: the synthetic "not attributed" row is not a customer.
  const namedCustomers = view.customers.filter((c) => c.counterpartyId !== null).length;

  return (
    <>
      <PeriodHeading
        eyebrow="Commercial"
        title="Where the money comes from"
        description="Who buys from you, what they buy, which campaigns brought them in, and the deals still open — all worked out from your own invoices and records, never guessed."
        scope={scope}
        hrefFor={(id) => `${base}?period=${id}`}
      />

      <div className="flex flex-col gap-6">
        {commercial.revenue ? <section data-testid="commercial-revenue"><MetricCard card={commercial.revenue} /></section> : null}

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 [&>*]:min-w-0">
          <Card className={CLICKABLE_CARD}>
            <CardHeader title="Top customers" description="Revenue this month, biggest first." icon={<Users />} action={<CardLink href={`${base}#customers`} className={PILL}>All customers {CHEVRON}</CardLink>} />
            <CardBody>
              {commercial.topCustomers.length === 0 ? <p className="text-sm text-ink-muted">No customer revenue for {scope.period.label}.</p> : (
                <ul className="flex flex-col gap-2 text-sm" data-testid="commercial-top-customers">
                  {commercial.topCustomers.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link href={c.href} className={`${ABOVE_CARD_LINK} text-ink underline underline-offset-2`}>{c.name}</Link>
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

          <Card className={CLICKABLE_CARD}>
            <CardHeader title="Top products and services" description="This month’s sales by what was sold, from invoices split into lines." icon={<Package />} tint="pink" action={<CardLink href={`${base}/products`} className={PILL}>All products {CHEVRON}</CardLink>} />
            <CardBody>
              {commercial.topProducts.length === 0 ? (
                <p className="text-sm text-ink-muted">No products or services recorded yet. Add them under Products, then split invoices into lines to see what each contributes.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm" data-testid="commercial-top-products">
                  {commercial.topProducts.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link href={p.href} className={`${ABOVE_CARD_LINK} text-ink underline underline-offset-2`}>{p.name}</Link>
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

          <Card className={CLICKABLE_CARD}>
            <CardHeader title="Marketing" description="What each campaign cost, and the sales from the customers it won, over the last twelve months." icon={<Megaphone />} tint="pink" action={<CardLink href={`${base}/marketing`} className={PILL}>All campaigns {CHEVRON}</CardLink>} />
            <CardBody>
              {commercial.topCampaigns.length === 0 ? <p className="text-sm text-ink-muted">No campaigns recorded yet.</p> : (
                <ul className="flex flex-col gap-2 text-sm" data-testid="commercial-marketing">
                  {commercial.topCampaigns.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link href={c.href} className={`${ABOVE_CARD_LINK} text-ink underline underline-offset-2`}>{c.name}</Link>
                      <span className="tabular">{c.spend} spend · {c.attributionStatus === 'no_won_opportunities' ? <span className="text-ink-muted">no revenue attributed</span> : <>{c.attributedRevenue} attributed</>}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card className={CLICKABLE_CARD}>
            <CardHeader title="Pipeline" description="Deals you are still working on, and how often they are won." icon={<Target />} action={<CardLink href={`${base}/sales`} className={PILL}>Sales {CHEVRON}</CardLink>} />
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
            <CardHeader title="How much you rely on your top customers" description="The measurement, for you to weigh — a high share is not a verdict." icon={<UsersRound />} />
            <CardBody className="px-0 py-0">
              <FigureTable rows={view.concentration} caption={`Customer concentration for ${scope.period.label}`} comparisonLabel={scope.previous?.label ?? 'the previous month'} />
              {/*
                The three figures' names are the shared vocabulary's; what each one MEANS is said here once,
                in words, because "top five share" and a concentration index are not everyday terms.
              */}
              <div className="px-5 pt-3 text-xs text-ink-muted" data-testid="concentration-explained">
                <p>Your biggest customer: the share of this month’s sales that came from your largest customer. Your five biggest customers: the share from those five together. How spread out your sales are: one measure from near 0% (sales spread across many customers) to 100% (all from a single customer).</p>
                {namedCustomers > 0 && namedCustomers <= 5 ? (
                  <p className="mt-1">You had {namedCustomers} customer{namedCustomers === 1 ? '' : 's'} this month, so your top five are all of your customers and their share is always 100%.</p>
                ) : null}
              </div>
              {commercial.concentrationTrend.some((p) => p.top5Text !== null) ? (
                <p className="px-5 py-3 text-xs text-ink-muted">
                  Top 5 share over the last months: {commercial.concentrationTrend.filter((p) => p.top5Text !== null).map((p) => `${p.label} ${p.top5Text}`).join(' · ')}
                </p>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Revenue by customer" icon={<ChartColumn />} tint="pink" />
          <CardBody className="px-0 py-0">
            <div id="customers" />
            {view.customers.length === 0 ? <p className="px-5 py-4 text-sm text-ink-muted">No customer revenue for {scope.period.label}.</p> : (
              <TableWrap stack>
                <caption className="sr-only">Revenue by customer for {scope.period.label}</caption>
                <THead columns={['Customer', 'Revenue', 'Share of revenue', '']} />
                <TBody>
                  {view.customers.map((customer) => (
                    <TR key={customer.counterpartyId ?? 'unattributed'}>
                      <TD className="max-sm:font-medium">
                        {customer.href ? <Link href={customer.href} className="underline underline-offset-2">{customer.name}</Link>
                          : <span title="We cannot tell which customer this relates to yet.">{customer.name}</span>}
                      </TD>
                      <TD className="whitespace-nowrap text-right tabular" label="Revenue">{customer.revenue.value}</TD>
                      <TD className="whitespace-nowrap text-right tabular" label="Share of revenue">{customer.share}</TD>
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
