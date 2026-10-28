import Link from 'next/link';
import { ChartColumn, Funnel, Handshake, Plus, Target } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody, DetailList } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDate } from '@/components/labels';
import { loadPeriodScope, loadSales, SALES_LIST_LIMIT } from '@/modules/dashboard';
import { PeriodHeading } from '../../money/_components/period-heading';
import { NewOpportunityForm, MoveStageForm } from './opportunity-forms';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Sales (brief §4, §7): the pipeline by stage, conversion with its cohort named, won value against
 * the revenue the engine later recorded, and the opportunities themselves. Not a CRM — one list,
 * five stages, a customer attached when a deal is won.
 */
export default async function SalesPage({ params, searchParams }: { params: Promise<{ orgSlug: string }>; searchParams: Promise<{ period?: string }> }) {
  const { orgSlug } = await params;
  const { period } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'customers.view');
  const mayEdit = can(ctx, 'customers.edit');
  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);
  const view = scope ? await loadSales(ctx.db, ctx.orgId!, orgSlug, scope, ctx.requestId) : null;
  const base = `/app/${orgSlug}/customers/sales`;

  return (
    <>
      {scope ? <PeriodHeading eyebrow="Commercial" title="Sales" description="Where every deal stands, and how often a lead becomes a customer." scope={scope} hrefFor={(id) => `${base}?period=${id}`} />
        : <PageHeader eyebrow="Commercial" title="Sales" description="Record opportunities as they arrive; win rates appear once there is a history." />}
      <div className="flex flex-col gap-6">
        {view ? (
          <>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 [&>*]:min-w-0">
              <Card>
                <CardHeader title="Pipeline by stage" description="Estimated values are what you entered — not forecasts." icon={<Target />} />
                <CardBody className="px-0 py-0">
                  <TableWrap className="min-w-0">
                    <caption className="sr-only">Opportunities by stage</caption>
                    <THead columns={['Stage', 'Count', 'Estimated value']} />
                    <TBody>{view.stages.map((s) => <TR key={s.stage}><TD>{s.label}</TD><TD className="text-right tabular">{s.count}</TD><TD className="text-right tabular">{s.valueText}</TD></TR>)}</TBody>
                  </TableWrap>
                  <p className="px-5 py-3 text-sm" data-testid="sales-open"><span className="font-mono tabular-nums text-ink">{view.openValue}</span> <span className="text-ink-muted">open across {view.openCount} opportunit{view.openCount === 1 ? 'y' : 'ies'}</span></p>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Conversion" description={`Of the opportunities added between ${view.conversionWindow.from.label} and ${view.conversionWindow.to.label}: how many moved past the lead stage, and how many were won.`} icon={<Funnel />} tint="pink" />
                <CardBody>
                  <DetailList items={[
                    { label: 'Added', value: view.conversion.leadsCreated },
                    { label: 'Moved past the lead stage', value: view.conversion.progressed },
                    { label: 'Won', value: view.conversion.wonFromCohort },
                    { label: 'Lead → opportunity', value: <span data-testid="sales-lead-to-opp">{view.conversionRates.leadToOpportunity ?? '—'}</span> },
                    { label: 'Opportunity → customer', value: <span data-testid="sales-opp-to-customer">{view.conversionRates.opportunityToCustomer ?? '—'}</span> },
                  ]} />
                  {view.conversionNotes.length > 0 ? <p className="mt-2 text-xs text-ink-muted">{view.conversionNotes.join(' ')}</p> : null}
                </CardBody>
              </Card>
            </div>

            <Card>
              <CardHeader title="Won against revenue" description="Deals marked won each month, next to the sales in your accounts for that month. They are different things: a win is a promise, a sale is an invoice." icon={<ChartColumn />} />
              <CardBody className="px-0 py-0">
                <TableWrap stack>
                  <caption className="sr-only">Won opportunities and revenue by month</caption>
                  <THead columns={['Month', 'Won', 'Won value', 'Lost', 'Sales invoiced']} />
                  <TBody>{view.byPeriod.map((p) => <TR key={p.periodId}><TD className="max-sm:font-medium">{p.label}</TD><TD className="text-right tabular" label="Won">{p.won}</TD><TD className="text-right tabular" label="Won value">{p.wonValueText}</TD><TD className="text-right tabular" label="Lost">{p.lost}</TD><TD className="text-right tabular" label="Sales invoiced">{p.revenue ?? <span className="text-ink-faint">—</span>}</TD></TR>)}</TBody>
                </TableWrap>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Opportunities" description={view.total > SALES_LIST_LIMIT ? `Showing the latest ${SALES_LIST_LIMIT} of ${view.total}.` : undefined} icon={<Handshake />} tint="pink" />
              <CardBody className="px-0 py-0">
                {view.opportunities.length === 0 ? <p className="px-5 py-4 text-sm text-ink-muted">Nothing recorded yet{mayEdit ? ' — add the first below' : ''}.</p> : (
                  <TableWrap stack>
                    <caption className="sr-only">Opportunities</caption>
                    <THead columns={['Opportunity', 'Customer', 'Campaign', 'Estimated value', 'Created', 'Stage']} />
                    <TBody>
                      {view.opportunities.map((o) => (
                        <TR key={o.id}>
                          <TD className="max-sm:font-medium">{o.name}</TD>
                          <TD label="Customer">{o.customerId ? <Link href={`/app/${orgSlug}/customers/${o.customerId}`} className="underline underline-offset-2">{o.customer}</Link> : <span className="text-ink-faint">—</span>}</TD>
                          <TD label="Campaign">{o.campaign ?? <span className="text-ink-faint">—</span>}</TD>
                          <TD className="text-right tabular" label="Estimated value">{o.value ?? '—'}</TD>
                          <TD className="whitespace-nowrap tabular" label="Created">{formatDate(o.createdOn)}</TD>
                          <TD>{mayEdit ? <MoveStageForm orgSlug={orgSlug} opportunityId={o.id} stage={o.stage} customerId={o.customerId} customers={view.customers} /> : <span data-testid={`stage-${o.id}`}>{o.stageLabel}{o.wonOn ? <span className="ml-1 text-xs text-ink-muted">{formatDate(o.wonOn)}</span> : null}</span>}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </TableWrap>
                )}
              </CardBody>
            </Card>
          </>
        ) : null}

        {mayEdit && view ? (
          <Card>
            <CardHeader title="Add an opportunity" description="A lead, an enquiry, a quote — whatever stage it is at now." icon={<Plus />} />
            <CardBody><NewOpportunityForm orgSlug={orgSlug} customers={view.customers} campaigns={view.campaigns} currency={view.currency} /></CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
