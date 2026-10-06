import Link from 'next/link';
import { can } from '@/core/permissions';
import { ENGAGEMENT_STATUS_LABELS, listEngagementItems, type EngagementItemView } from '@/modules/engagement';
import { getAccessContext } from '@/modules/tenancy';
import { Badge, Card, CardBody, PageHeader } from '@/components/ui/surfaces';
import { NewItemForm } from '@/components/engagement/forms';
import { requirePermission } from '@/app/_lib/authz';
import { createEngagementItemAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Requests and deliverables (Agreement §4 Team/Client Management; ADR-144): what the client has
 * asked of the team, and what the team owes the client, each with its status and history. A client
 * raises requests; the team adds deliverables and moves both along. Everyone involved is notified
 * in the product.
 */

function List({ orgSlug, items, empty }: { orgSlug: string; items: readonly EngagementItemView[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line">
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <Link href={`/app/${orgSlug}/engagement/${item.id}`} className="text-ink underline-offset-2 hover:underline">{item.title}</Link>
          <span className="flex items-center gap-2 text-ink-muted">
            {item.dueDate === null ? null : <span>by {item.dueDate}</span>}
            <Badge tone={item.status === 'delivered' ? 'accent' : item.status === 'closed' ? 'neutral' : 'warn'}>
              {ENGAGEMENT_STATUS_LABELS[item.status]}
            </Badge>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function EngagementPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'actions.view');
  const items = await listEngagementItems(ctx);
  const team = can(ctx, 'actions.assign');
  const open = (i: EngagementItemView) => i.status === 'open' || i.status === 'in_progress';

  return (
    <>
      <PageHeader eyebrow="Team and client" title="Requests and deliverables"
        description="What has been asked of the team, and what the team is delivering — with every change recorded and everyone involved told." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card><CardBody>
          <h2 className="font-serif text-lg text-ink">Requests</h2>
          <div className="mt-3"><List orgSlug={orgSlug} items={items.filter((i) => i.kind === 'request' && open(i))} empty="No open requests." /></div>
        </CardBody></Card>
        <Card><CardBody>
          <h2 className="font-serif text-lg text-ink">Deliverables</h2>
          <div className="mt-3"><List orgSlug={orgSlug} items={items.filter((i) => i.kind === 'deliverable' && open(i))} empty="No deliverables in progress." /></div>
        </CardBody></Card>
      </div>
      <Card className="mt-6"><CardBody>
        <h2 className="font-serif text-lg text-ink">{team ? 'Add a request or deliverable' : 'Ask the team for something'}</h2>
        <div className="mt-3">
          <NewItemForm action={createEngagementItemAction} orgSlug={orgSlug} kinds={team ? ['request', 'deliverable'] : ['request']} />
        </div>
      </CardBody></Card>
      <Card className="mt-6"><CardBody>
        <h2 className="font-serif text-lg text-ink">Done and closed</h2>
        <div className="mt-3"><List orgSlug={orgSlug} items={items.filter((i) => !open(i))} empty="Nothing finished yet." /></div>
      </CardBody></Card>
    </>
  );
}
