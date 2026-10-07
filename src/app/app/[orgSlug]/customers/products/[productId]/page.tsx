import Link from 'next/link';
import { ChartColumn, FileText, Users, Wallet } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getAccessContext } from '@/modules/tenancy';
import { Card, CardHeader, CardBody, Badge, DetailList } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDate } from '@/components/labels';
import { loadPeriodScope, loadProductDetail } from '@/modules/dashboard';
import { PeriodHeading } from '../../../money/_components/period-heading';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/** One product or service (brief §22): revenue, cost where recorded, contribution, trend, customer mix, the invoices behind it. */
export default async function ProductPage({ params, searchParams }: { params: Promise<{ orgSlug: string; productId: string }>; searchParams: Promise<{ period?: string }> }) {
  const { orgSlug, productId } = await params;
  const { period } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(productId)) notFound();
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'customers.view');
  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);
  if (!scope) notFound();
  const view = await loadProductDetail(ctx.db, ctx.orgId!, orgSlug, scope, productId, ctx.requestId);
  if (!view) notFound();
  const m = view.thisMonth;

  return (
    <>
      <PeriodHeading eyebrow={view.product.kind === 'product' ? 'Product' : 'Service'} title={view.product.name} description={view.product.code ? `Code ${view.product.code}` : undefined} scope={scope} hrefFor={(id) => `/app/${orgSlug}/customers/products/${productId}?period=${id}`} />
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title={`This month — ${scope.period.label}`} icon={<Wallet />} />
          <CardBody>
            <DetailList items={[
              { label: 'Revenue', value: <span className="tabular">{m.revenue}</span> },
              { label: 'Cost', value: m.cost ? <span className="tabular">{m.cost}</span> : <span className="text-ink-muted">No purchase line names this yet</span> },
              { label: 'Contribution', value: m.contribution ? <span className="tabular">{m.contribution}{m.margin ? <span className="ml-2 text-ink-muted">({m.margin} margin)</span> : null}</span> : <Badge tone="neutral">{m.note ?? 'Unavailable'}</Badge> },
            ]} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Over time" description="Revenue attributed by lines each month; contribution only where cost lines exist." icon={<ChartColumn />} tint="pink" />
          <CardBody className="px-0 py-0">
            <TableWrap>
              <caption className="sr-only">Monthly revenue for {view.product.name}</caption>
              <THead columns={['Month', 'Revenue', 'Contribution']} />
              <TBody>{view.trend.map((t) => <TR key={t.periodId}><TD>{t.label}</TD><TD className="text-right tabular">{t.revenue}</TD><TD className="text-right tabular">{t.contribution ?? <span className="text-ink-faint">—</span>}</TD></TR>)}</TBody>
            </TableWrap>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Who buys it" description="Share of this product’s attributed revenue over the last twelve months." icon={<Users />} />
          <CardBody>
            {view.customers.length === 0 ? <p className="text-sm text-ink-muted">No sales lines yet.</p> : (
              <ul className="flex flex-col gap-2 text-sm">
                {view.customers.map((c) => (
                  <li key={c.counterpartyId ?? 'none'} className="flex flex-wrap justify-between gap-2">
                    {c.href ? <Link href={c.href} className="underline underline-offset-2">{c.name}</Link> : <span>{c.name}</span>}
                    <span className="tabular">{c.revenue}{c.share ? <span className="ml-2 text-ink-muted">{c.share}</span> : null}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="The invoices behind these figures" description="Each line links to the invoice’s own record and, for those allowed, its source document." icon={<FileText />} tint="pink" />
          <CardBody className="px-0 py-0">
            {view.lines.length === 0 ? <p className="px-5 py-4 text-sm text-ink-muted">No lines yet.</p> : (
              <TableWrap>
                <caption className="sr-only">Invoice lines for {view.product.name}</caption>
                <THead columns={['Invoice', 'Date', 'Customer or supplier', 'Kind', 'Amount', '']} />
                <TBody>
                  {view.lines.map((l) => (
                    <TR key={`${l.invoiceId}:${l.amount}:${l.kind}`}>
                      <TD className="tabular">{l.number}</TD>
                      <TD className="whitespace-nowrap tabular">{formatDate(l.date)}</TD>
                      <TD>{l.customer}</TD>
                      <TD>{l.kind === 'sale' ? 'Sale' : 'Cost'}{!l.counted ? <Badge tone="warn">not counted</Badge> : null}</TD>
                      <TD className="text-right tabular">{l.amount}</TD>
                      <TD className="text-right text-sm"><Link href={l.recordHref} className="text-ink-muted underline hover:text-ink">Where this came from</Link></TD>
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
