import Link from 'next/link';
import { Package, Plus } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody, Badge } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { loadPeriodScope, loadProducts } from '@/modules/dashboard';
import { PeriodHeading } from '../../money/_components/period-heading';
import { ProductForm } from './product-form';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/** Products and services: revenue by lines, contribution only where a cost line exists (brief §3, §22). */
export default async function ProductsPage({ params, searchParams }: { params: Promise<{ orgSlug: string }>; searchParams: Promise<{ period?: string }> }) {
  const { orgSlug } = await params;
  const { period } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'customers.view');
  const mayEdit = can(ctx, 'customers.edit');
  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);
  const view = scope ? await loadProducts(ctx.db, ctx.orgId!, orgSlug, scope, ctx.requestId) : null;

  return (
    <>
      {scope ? (
        <PeriodHeading eyebrow="Commercial" title="Products and services" description="What each one brought in, from the invoice lines you have attributed. Cost and contribution appear only where a purchase line names the product." scope={scope} hrefFor={(id) => `/app/${orgSlug}/customers/products?period=${id}`} />
      ) : <PageHeader eyebrow="Commercial" title="Products and services" description="Add the things you sell; once invoices are imported you can split them into lines." />}
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title={scope ? `Revenue by product — ${scope.period.label}` : 'Products and services'} icon={<Package />} />
          <CardBody className="px-0 py-0">
            {!view || view.products.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-muted">Nothing recorded yet. Add a product or service below{mayEdit ? '' : ' — an owner or admin can'}, then split an invoice into lines on a customer’s page.</p>
            ) : (
              <TableWrap stack>
                <caption className="sr-only">Revenue by product</caption>
                <THead columns={['Product or service', 'Revenue', 'Cost', 'Contribution', 'Margin']} />
                <TBody>
                  {view.products.map((p) => (
                    <TR key={p.id}>
                      <TD><Link href={p.href} className="text-ink underline underline-offset-2">{p.name}</Link>{!p.isActive ? <Badge tone="neutral">inactive</Badge> : null}<span className="ml-2 text-xs text-ink-muted">{p.kind}</span></TD>
                      <TD className="whitespace-nowrap text-right tabular" label="Revenue">{p.revenue}</TD>
                      <TD className="whitespace-nowrap text-right tabular" label="Cost">{p.cost ?? <span className="text-ink-faint">—</span>}</TD>
                      <TD className="whitespace-nowrap text-right tabular max-sm:whitespace-normal" label="Contribution">{p.contribution ?? <span className="text-xs text-ink-muted">{p.note}</span>}</TD>
                      <TD className="whitespace-nowrap text-right tabular" label="Margin">{p.margin ?? '—'}</TD>
                    </TR>
                  ))}
                </TBody>
              </TableWrap>
            )}
            {view?.unattributed ? (
              <p className="px-5 py-3 text-xs text-ink-muted" data-testid="products-unattributed">
                {view.unattributed.amount} of {scope!.period.label}’s sales is not attributed to any product — {view.unattributed.invoicesWithoutLines} of {view.unattributed.invoices} invoice{view.unattributed.invoices === 1 ? '' : 's'} carry no lines.
              </p>
            ) : null}
          </CardBody>
        </Card>
        {mayEdit ? (
          <Card>
            <CardHeader title="Add a product or service" icon={<Plus />} tint="pink" />
            <CardBody><ProductForm orgSlug={orgSlug} /></CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
