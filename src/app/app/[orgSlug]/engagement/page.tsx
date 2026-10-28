import { can } from '@/core/permissions';
import { ENGAGEMENT_STATUS_LABELS, listEngagementItems, type EngagementItemView } from '@/modules/engagement';
import { getAccessContext } from '@/modules/tenancy';
import { CircleCheck, Inbox, MessageSquarePlus, PackageCheck } from 'lucide-react';
import { Badge, Card, CardBody, IconBadge, PageHeader } from '@/components/ui/surfaces';
import { CardLink } from '@/components/ui/clickable-card';
import { NewItemForm } from '@/components/engagement/forms';
import { formatDate } from '@/components/labels';
import { requirePermission } from '@/app/_lib/authz';
import { createEngagementItemAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Requests and deliverables (Agreement §4 Team/Client Management; ADR-144): what the client has
 * asked of the team, and what the team owes the client, each with its status and history. A client
 * raises requests; the team adds deliverables and moves both along. Everyone involved is notified
 * in the product.
 */

/**
 * A row opens its item from anywhere on it (owner, 2026-10-14), as a clickable card does
 * (`ui/clickable-card`): the title is the one link, stretched over the row; the status beside it is
 * text. The row highlights on hover and on keyboard focus.
 */
const ROW = 'relative -mx-2 rounded-xl px-2 transition-colors hover:bg-accent-soft/40 focus-within:ring-2 focus-within:ring-accent/50';

function List({ orgSlug, items, empty }: { orgSlug: string; items: readonly EngagementItemView[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line">
      {items.map((item) => (
        <li key={item.id} className={`${ROW} flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm`}>
          <CardLink href={`/app/${orgSlug}/engagement/${item.id}`} className="min-w-0 font-medium text-ink underline-offset-2 [overflow-wrap:anywhere] after:rounded-xl hover:text-accent hover:underline">{item.title}</CardLink>
          <span className="flex flex-wrap items-center gap-2 text-ink-muted">
            {item.dueDate === null ? null : <span>wanted by {formatDate(item.dueDate)}</span>}
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
        description="Ask your team for something, and follow what they are working on. Every change is recorded, and everyone involved is told." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card><CardBody>
          <div className="flex min-w-0 items-center gap-3">
            <IconBadge tint="violet" size="sm"><Inbox /></IconBadge>
            <h2 className="min-w-0 font-serif text-lg text-ink">Requests</h2>
          </div>
          <div className="mt-3"><List orgSlug={orgSlug} items={items.filter((i) => i.kind === 'request' && open(i))} empty="No open requests. Use the form below to ask for something." /></div>
        </CardBody></Card>
        <Card><CardBody>
          <div className="flex min-w-0 items-center gap-3">
            <IconBadge tint="pink" size="sm"><PackageCheck /></IconBadge>
            <h2 className="min-w-0 font-serif text-lg text-ink">Deliverables</h2>
          </div>
          <div className="mt-3"><List orgSlug={orgSlug} items={items.filter((i) => i.kind === 'deliverable' && open(i))} empty="No deliverables being worked on right now." /></div>
        </CardBody></Card>
      </div>
      <Card className="mt-6"><CardBody>
        <div className="flex min-w-0 items-center gap-3">
          <IconBadge tint="violet" size="sm"><MessageSquarePlus /></IconBadge>
          <h2 className="min-w-0 font-serif text-lg text-ink">{team ? 'Add a request or deliverable' : 'Ask the team for something'}</h2>
        </div>
        <div className="mt-3 max-w-2xl">
          <NewItemForm action={createEngagementItemAction} orgSlug={orgSlug} kinds={team ? ['request', 'deliverable'] : ['request']} />
        </div>
      </CardBody></Card>
      <Card className="mt-6"><CardBody>
        <div className="flex min-w-0 items-center gap-3">
          <IconBadge tint="pink" size="sm"><CircleCheck /></IconBadge>
          <h2 className="min-w-0 font-serif text-lg text-ink">Done and closed</h2>
        </div>
        <div className="mt-3"><List orgSlug={orgSlug} items={items.filter((i) => !open(i))} empty="Nothing finished yet. Finished and withdrawn items move here." /></div>
      </CardBody></Card>
    </>
  );
}
