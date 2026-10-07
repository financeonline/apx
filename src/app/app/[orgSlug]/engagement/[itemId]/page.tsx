import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@/core/permissions';
import { ENGAGEMENT_STATUS_LABELS, getEngagementItem, type EngagementStatus } from '@/modules/engagement';
import { getAccessContext } from '@/modules/tenancy';
import { ArrowRightLeft, History } from 'lucide-react';
import { Badge, Card, CardBody, IconBadge, PageHeader } from '@/components/ui/surfaces';
import { CommentForm, StatusForm } from '@/components/engagement/forms';
import { requirePermission } from '@/app/_lib/authz';
import { commentEngagementItemAction, updateEngagementStatusAction } from '../actions';

export const dynamic = 'force-dynamic';

/** One request or deliverable, its full history, and what the viewer may do next (ADR-144). */
export default async function EngagementItemPage({ params }: { params: Promise<{ orgSlug: string; itemId: string }> }) {
  const { orgSlug, itemId } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'actions.view');
  const found = await getEngagementItem(ctx, itemId);
  if (found === null) notFound();
  const { item, events } = found;
  const team = can(ctx, 'actions.assign');
  const options = team
    ? (['open', 'in_progress', 'delivered', 'closed'] as EngagementStatus[]).filter((s) => s !== item.status)
    : item.kind === 'request' && item.mine && item.status !== 'closed' ? (['closed'] as EngagementStatus[]) : [];

  return (
    <>
      <p className="mb-2 text-sm"><Link href={`/app/${orgSlug}/engagement`} className="text-accent underline underline-offset-2">Back to requests and deliverables</Link></p>
      <PageHeader eyebrow={item.kind === 'request' ? 'Request' : 'Deliverable'} title={item.title} />
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <Badge tone={item.status === 'delivered' ? 'accent' : item.status === 'closed' ? 'neutral' : 'warn'}>{ENGAGEMENT_STATUS_LABELS[item.status]}</Badge>
        Raised by {item.createdBy} on {item.createdAt.slice(0, 10)}{item.dueDate === null ? '' : ` · wanted by ${item.dueDate}`}
      </p>
      {item.detail === null ? null : <p className="mt-4 whitespace-pre-line text-sm text-ink">{item.detail}</p>}

      {options.length === 0 ? null : (
        <Card className="mt-6"><CardBody>
          <div className="flex min-w-0 items-center gap-3">
            <IconBadge tint="violet" size="sm"><ArrowRightLeft /></IconBadge>
            <h2 className="min-w-0 font-serif text-lg text-ink">{team ? 'Move it along' : 'Withdraw your request'}</h2>
          </div>
          <div className="mt-3">
            <StatusForm action={updateEngagementStatusAction} orgSlug={orgSlug} itemId={item.id}
              options={options.map((s) => ({ value: s, label: ENGAGEMENT_STATUS_LABELS[s] }))} />
          </div>
        </CardBody></Card>
      )}

      <Card className="mt-6"><CardBody>
        <div className="flex min-w-0 items-center gap-3">
          <IconBadge tint="pink" size="sm"><History /></IconBadge>
          <h2 className="min-w-0 font-serif text-lg text-ink">History</h2>
        </div>
        <ol className="mt-3 flex flex-col gap-3 text-sm">
          {events.map((e) => (
            <li key={e.id} className="border-b border-line pb-2 last:border-0">
              <p className="text-ink">
                {e.actor}{' '}
                {e.event === 'created' ? 'raised it' : e.event === 'commented' ? 'commented'
                  : `moved it from ${ENGAGEMENT_STATUS_LABELS[e.fromStatus ?? 'open']} to ${ENGAGEMENT_STATUS_LABELS[e.toStatus ?? 'open']}`}
                <span className="text-ink-muted"> · {e.createdAt.slice(0, 16).replace('T', ' ')} UTC</span>
              </p>
              {e.note === null ? null : <p className="mt-1 whitespace-pre-line text-ink-muted">{e.note}</p>}
            </li>
          ))}
        </ol>
        <div className="mt-4">
          <CommentForm action={commentEngagementItemAction} hidden={{ org_slug: orgSlug, item_id: item.id }} />
        </div>
      </CardBody></Card>
    </>
  );
}
