import Link from 'next/link';
import { listNotifications } from '@/modules/engagement';
import { getAccessContext } from '@/modules/tenancy';
import { Bell, BellDot } from 'lucide-react';
import { Card, CardBody, EmptyState, IconBadge, PageHeader } from '@/components/ui/surfaces';
import { MarkAllReadForm } from '@/components/engagement/forms';
import { requirePermission } from '@/app/_lib/authz';
import { markAllReadAction } from '../engagement/actions';

export const dynamic = 'force-dynamic';

/** Your notifications in this organisation (ADR-144): new data, reports ready, requests, deliverables, comments. */
export default async function NotificationsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'financials.view');
  const items = await listNotifications(ctx);

  return (
    <>
      <PageHeader eyebrow="Inbox" title="Notifications" description="What has happened that concerns you. Nothing here is sent by email." />
      {items.length === 0 ? (
        <EmptyState title="Nothing yet">You will be told here when data is added, a report is ready, or a request, deliverable or action you are part of moves.</EmptyState>
      ) : (
        <>
          <div className="mb-4"><MarkAllReadForm action={markAllReadAction} orgSlug={orgSlug} /></div>
          <Card><CardBody>
            <ul className="flex flex-col divide-y divide-line">
              {items.map((n) => (
                <li key={n.id} className="flex min-w-0 items-start gap-3 py-3 text-sm">
                  <IconBadge tint={n.read ? 'violet' : 'pink'} size="sm">{n.read ? <Bell /> : <BellDot />}</IconBadge>
                  <div className="min-w-0 flex-1">
                  <p className={n.read ? 'text-ink-muted' : 'font-medium text-ink'}>
                    {n.href === null ? n.title : <Link href={n.href} className="underline-offset-2 hover:text-accent hover:underline">{n.title}</Link>}
                    {n.read ? null : <span className="sr-only"> (unread)</span>}
                  </p>
                  {n.body === null ? null : <p className="mt-1 text-ink-muted">{n.body}</p>}
                  <p className="mt-1 text-xs text-ink-faint">{n.createdAt.slice(0, 16).replace('T', ' ')} UTC</p>
                  </div>
                </li>
              ))}
            </ul>
          </CardBody></Card>
        </>
      )}
    </>
  );
}
