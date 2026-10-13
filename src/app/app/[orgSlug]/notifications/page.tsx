import { listNotifications } from '@/modules/engagement';
import { getAccessContext } from '@/modules/tenancy';
import { Bell, BellDot } from 'lucide-react';
import { Card, CardBody, EmptyState, IconBadge, PageHeader } from '@/components/ui/surfaces';
import { CardLink } from '@/components/ui/clickable-card';
import { MarkAllReadForm } from '@/components/engagement/forms';
import { requirePermission } from '@/app/_lib/authz';
import { markAllReadAction } from '../engagement/actions';

export const dynamic = 'force-dynamic';

/**
 * A notification that leads somewhere opens from anywhere on its row (owner, 2026-10-14), as a
 * clickable card does (`ui/clickable-card`): its title is the one link, stretched over the row.
 */
const ROW = 'relative -mx-2 rounded-xl px-2 transition-colors hover:bg-accent-soft/40 focus-within:ring-2 focus-within:ring-accent/50';

/** Your notifications in this organisation (ADR-144): new data, reports ready, requests, deliverables, comments. */
export default async function NotificationsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'financials.view');
  const items = await listNotifications(ctx);

  return (
    <>
      <PageHeader eyebrow="Inbox" title="Notifications" description="What has happened that concerns you. Nothing here is sent by email." />
      {/* A readable measure on a very wide screen. */}
      <div className="max-w-4xl">
        {items.length === 0 ? (
          <EmptyState title="Nothing yet">You will be told here when data is added, a report is ready, or a request, deliverable or action you are part of moves.</EmptyState>
        ) : (
          <>
            <div className="mb-4"><MarkAllReadForm action={markAllReadAction} orgSlug={orgSlug} /></div>
            <Card><CardBody>
              <ul className="flex flex-col divide-y divide-line">
                {items.map((n) => (
                  <li key={n.id} className={`flex min-w-0 items-start gap-3 py-3 text-sm ${n.href === null ? '' : ROW}`}>
                    <IconBadge tint={n.read ? 'violet' : 'pink'} size="sm">{n.read ? <Bell /> : <BellDot />}</IconBadge>
                    <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      <p className={n.read ? 'text-ink-muted' : 'font-medium text-ink'}>
                        {n.href === null ? n.title : <CardLink href={n.href} className="underline-offset-2 after:rounded-xl hover:text-accent hover:underline">{n.title}</CardLink>}
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
      </div>
    </>
  );
}
