import { listNotifications } from '@/modules/engagement';
import { NOTIFICATION_KIND_LABELS, formatDateTime } from '@/components/labels';
import { getAccessContext } from '@/modules/tenancy';
import { Bell, BellDot } from 'lucide-react';
import { Card, CardBody, EmptyState, IconBadge, PageHeader } from '@/components/ui/surfaces';
import { CardLink } from '@/components/ui/clickable-card';
import { MarkAllReadForm } from '@/components/engagement/forms';
import { forbidden } from 'next/navigation';
import { requirePermission } from '@/app/_lib/authz';
import { markAllReadAction } from '../engagement/actions';

export const dynamic = 'force-dynamic';

/**
 * A notification that leads somewhere opens from anywhere on its row (owner, 2026-10-14), as a
 * clickable card does (`ui/clickable-card`): its title is the one link, stretched over the row.
 */
const ROW = 'relative -mx-2 rounded-xl px-2 transition-colors hover:bg-accent-soft/40 focus-within:ring-2 focus-within:ring-accent/50';

/**
 * Your notifications in this organisation (ADR-144): new data, reports ready, requests, deliverables,
 * comments, and the answer to "Request more information" (ADR-172).
 *
 * Notifications are personal, so any member with the overview (`dashboard.view`) reads their own —
 * a 3rd party included; until ADR-172's follow-up this asked for `financials.view`, which left a
 * 3rd party no way to read the answer to their own request. Nothing here exposes the company's
 * detail: RLS returns only the reader's rows, `app.notify` wrote each only for someone who could open
 * what it points at, and `listNotifications` drops any kind the reader may no longer open.
 */
export default async function NotificationsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'dashboard.view');
  // A suspended organisation is frozen to its Home page for everyone (ADR-044.4); `suspended_member`
  // holds `dashboard.view` for exactly that one page.
  if (ctx.organizationStatus === 'suspended') forbidden();
  const items = await listNotifications(ctx);

  return (
    <>
      <PageHeader eyebrow="Inbox" title="Notifications" description="Updates that involve you — new data, finished reports, and requests or actions you are part of. These stay in APX; none are sent by email." />
      {/* A readable measure on a very wide screen. */}
      <div className="max-w-4xl">
        {items.length === 0 ? (
          <EmptyState title="Nothing yet">There is nothing to read. You will see a note here when data is added, a report is ready, or a request, deliverable or action you are part of moves on.</EmptyState>
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
                      <p className="mt-1 text-xs text-ink-faint">
                        {NOTIFICATION_KIND_LABELS[n.kind] ?? 'Notification'} · {formatDateTime(n.createdAt)} UTC
                      </p>
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
