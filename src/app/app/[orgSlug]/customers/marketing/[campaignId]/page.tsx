import Link from 'next/link';
import { CalendarDays, Funnel, Handshake, PencilLine, Users, Wallet } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { Card, CardHeader, CardBody, Badge, DetailList } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDate } from '@/components/labels';
import { loadCampaignDetail, loadPeriodScope } from '@/modules/dashboard';
import { PeriodHeading } from '../../../money/_components/period-heading';
import { SpendForm } from '../marketing-forms';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/** One campaign (brief §5–§7): spend by month, who was won through it, the credited revenue, CAC with its denominator, the cohort's conversion. */
export default async function CampaignPage({ params, searchParams }: { params: Promise<{ orgSlug: string; campaignId: string }>; searchParams: Promise<{ period?: string }> }) {
  const { orgSlug, campaignId } = await params;
  const { period } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) notFound();
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'customers.view');
  const mayEdit = can(ctx, 'customers.edit');
  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);
  if (!scope) notFound();
  const view = await loadCampaignDetail(ctx.db, ctx.orgId!, orgSlug, scope, campaignId, ctx.requestId);
  if (!view) notFound();
  const r = view.row;
  const conv = view.conversion;

  return (
    <>
      <PeriodHeading eyebrow={view.channelName ? `Campaign · ${view.channelName}` : 'Campaign'} title={view.campaign.name} description={`Figures cover the ${view.window.months} months to ${view.window.to.label}.`} scope={scope} hrefFor={(id) => `/app/${orgSlug}/customers/marketing/${campaignId}?period=${id}`} />
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="What it cost and what it brought in" icon={<Wallet />} />
          <CardBody>
            <DetailList items={[
              { label: 'Spend', value: <span className="tabular">{r.spend}</span> },
              { label: 'Customers won', value: <span className="tabular" data-testid="campaign-customers-won">{r.customersWon}</span> },
              { label: 'Revenue credited', value: r.attributionStatus === 'attributed_via_won_opportunities' ? <span className="tabular" data-testid="campaign-attributed">{r.attributedRevenue}</span> : <Badge tone="neutral">{r.attributionText}</Badge> },
              { label: 'Cost per customer won', value: r.cac ? <span className="tabular" data-testid="campaign-cac">{r.cac}<span className="ml-2 text-xs text-ink-muted">{r.cacNote}</span></span> : <span className="text-sm text-ink-muted">{r.cacNote ?? 'Not computable'}</span> },
              { label: 'Credited revenue less spend', value: r.contribution ? <span className="tabular">{r.contribution}</span> : <span className="text-sm text-ink-muted">Needs credited revenue</span> },
            ]} />
            <p className="mt-3 text-xs text-ink-faint">{r.attributionText}. Only revenue invoiced from the month an opportunity was won is credited, and only to the first campaign that won the customer.</p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Month by month" icon={<CalendarDays />} tint="pink" />
          <CardBody className="px-0 py-0">
            <TableWrap>
              <caption className="sr-only">Spend and credited revenue by month</caption>
              <THead columns={['Month', 'Spend', 'Revenue credited']} />
              <TBody>{view.spendByPeriod.map((p) => <TR key={p.periodId}><TD>{p.label}</TD><TD className="text-right tabular">{p.amount}</TD><TD className="text-right tabular">{p.attributed}</TD></TR>)}</TBody>
            </TableWrap>
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 [&>*]:min-w-0">
          <Card>
            <CardHeader title="Customers won through it" icon={<Users />} />
            <CardBody>
              {view.customers.length === 0 ? <p className="text-sm text-ink-muted">None yet. Mark an opportunity as won and name this campaign to credit revenue here.</p> : (
                <ul className="flex flex-col gap-2 text-sm">
                  {view.customers.map((c) => <li key={c.counterpartyId} className="flex justify-between gap-2"><Link href={c.href} className="underline underline-offset-2">{c.name}</Link><span className="text-ink-muted">won {formatDate(c.wonOn)}</span></li>)}
                </ul>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="How its opportunities converted" description={`Opportunities created between ${view.window.from.label} and ${view.window.to.label}.`} icon={<Funnel />} tint="pink" />
            <CardBody>
              <DetailList items={[
                { label: 'Created', value: conv.leadsCreated },
                { label: 'Reached opportunity', value: conv.progressed },
                { label: 'Won', value: conv.wonFromCohort },
                { label: 'Lead → opportunity', value: view.conversionRates.leadToOpportunity ?? '—' },
                { label: 'Opportunity → customer', value: view.conversionRates.opportunityToCustomer ?? '—' },
              ]} />
              {view.conversionNotes.length > 0 ? <p className="mt-2 text-xs text-ink-muted">{view.conversionNotes.join(' ')}</p> : null}
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader title="Opportunities naming this campaign" icon={<Handshake />} />
          <CardBody className="px-0 py-0">
            {view.opportunities.length === 0 ? <p className="px-5 py-4 text-sm text-ink-muted">None.</p> : (
              <TableWrap>
                <caption className="sr-only">Opportunities for {view.campaign.name}</caption>
                <THead columns={['Opportunity', 'Customer', 'Stage', 'Estimated value', 'Created']} />
                <TBody>{view.opportunities.map((o) => <TR key={o.id}><TD>{o.name}</TD><TD>{o.customer ?? <span className="text-ink-faint">—</span>}</TD><TD>{o.stageLabel}</TD><TD className="text-right tabular">{o.value ?? '—'}</TD><TD className="whitespace-nowrap tabular">{formatDate(o.createdOn)}</TD></TR>)}</TBody>
              </TableWrap>
            )}
          </CardBody>
        </Card>

        {mayEdit ? (
          <Card>
            <CardHeader title="Record spend" description="One figure per month. Recording a month again replaces the earlier figure." icon={<PencilLine />} tint="pink" />
            <CardBody><SpendForm orgSlug={orgSlug} campaignId={campaignId} periods={view.periods.map((p) => ({ id: p.id, label: p.label }))} currency={view.currency} /></CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
