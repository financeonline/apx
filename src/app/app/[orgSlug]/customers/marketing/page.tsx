import Link from 'next/link';
import { ChevronRight, Megaphone, Plus, Share2 } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody, Badge } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { loadMarketing, loadPeriodScope } from '@/modules/dashboard';
import { PeriodHeading } from '../../money/_components/period-heading';
import { ChannelForm, CampaignForm } from './marketing-forms';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Marketing (brief §5–§6): spend a person recorded against revenue credited only through won
 * opportunities. A campaign with no won opportunity says so — nothing is spread across it.
 */
export default async function MarketingPage({ params, searchParams }: { params: Promise<{ orgSlug: string }>; searchParams: Promise<{ period?: string }> }) {
  const { orgSlug } = await params;
  const { period } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'customers.view');
  const mayEdit = can(ctx, 'customers.edit');
  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);
  const view = scope ? await loadMarketing(ctx.db, ctx.orgId!, orgSlug, scope, ctx.requestId) : null;
  const base = `/app/${orgSlug}/customers/marketing`;

  return (
    <>
      {scope ? (
        <PeriodHeading eyebrow="Commercial" title="Marketing" description={`Spend against the revenue it can be credited with, over the ${view!.window.months} months to ${view!.window.to.label}.`} scope={scope} hrefFor={(id) => `${base}?period=${id}`} />
      ) : <PageHeader eyebrow="Commercial" title="Marketing" description="Record channels and campaigns; once invoices are imported and opportunities won, revenue is credited here." />}
      <div className="flex flex-col gap-6">
        {view ? (
          <Card>
            <CardHeader title="Campaigns" description={view.note} icon={<Megaphone />} />
            <CardBody className="px-0 py-0">
              {view.campaigns.length === 0 ? (
                <p className="px-5 py-4 text-sm text-ink-muted">No campaigns yet{mayEdit ? ' — add one below' : ''}. A campaign earns revenue here only when an opportunity marked as won names it.</p>
              ) : (
                <TableWrap stack>
                  <caption className="sr-only">Campaign spend and attributed revenue</caption>
                  <THead columns={['Campaign', 'Channel', 'Spend', 'Customers won', 'Revenue credited', 'Cost per customer', '']} />
                  <TBody>
                    {view.campaigns.map((c) => (
                      <TR key={c.id}>
                        <TD className="max-sm:font-medium"><Link href={c.href} className="text-ink underline underline-offset-2">{c.name}</Link>{c.status !== 'active' ? <Badge tone="neutral">{c.status}</Badge> : null}</TD>
                        <TD label="Channel">{c.channelName ?? <span className="text-ink-faint">—</span>}</TD>
                        <TD className="whitespace-nowrap text-right tabular" label="Spend">{c.spend}</TD>
                        <TD className="whitespace-nowrap text-right tabular" label="Customers won">{c.customersWon}</TD>
                        <TD className="whitespace-nowrap text-right tabular max-sm:whitespace-normal" label="Revenue credited">{c.attributionStatus === 'attributed_via_won_opportunities' ? c.attributedRevenue : <span className="text-xs text-ink-muted">{c.attributionText}</span>}</TD>
                        <TD className="whitespace-nowrap text-right tabular" label="Cost per customer">{c.cac ?? <span className="text-xs text-ink-muted" title={c.cacNote ?? undefined}>—</span>}</TD>
                        <TD className="text-right text-sm"><Link href={c.href} className="inline-flex items-center gap-0.5 rounded-xl border border-accent/45 bg-surface px-2.5 py-0.5 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft pointer-coarse:min-h-10">Detail <ChevronRight aria-hidden="true" className="size-4" /></Link></TD>
                      </TR>
                    ))}
                  </TBody>
                </TableWrap>
              )}
              {view.campaigns.length > 0 ? (
                <p className="px-5 py-3 text-xs text-ink-muted" data-testid="marketing-totals">
                  Across every campaign: {view.totals.spend} spent, {view.totals.customersWon} customer{view.totals.customersWon === 1 ? '' : 's'} won, {view.totals.attributedRevenue} credited. Revenue from customers not won through a campaign is not shown here.
                </p>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Channels" description="Where customers come from, in your words." icon={<Share2 />} tint="pink" />
          <CardBody>
            {view && view.channels.length > 0 ? (
              <ul className="flex flex-wrap gap-2 text-sm" data-testid="marketing-channels">
                {view.channels.map((ch) => <li key={ch.id}><Badge tone="neutral">{ch.name}</Badge></li>)}
              </ul>
            ) : <p className="text-sm text-ink-muted">No channels yet.</p>}
          </CardBody>
        </Card>

        {mayEdit ? (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 [&>*]:min-w-0">
            <Card><CardHeader title="Add a channel" icon={<Plus />} /><CardBody><ChannelForm orgSlug={orgSlug} /></CardBody></Card>
            <Card><CardHeader title="Add a campaign" description="Spend is recorded month by month on the campaign’s own page." icon={<Plus />} tint="pink" /><CardBody><CampaignForm orgSlug={orgSlug} channels={view?.channels ?? []} /></CardBody></Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
