import { notFound } from 'next/navigation';
import { can } from '@/core/permissions';
import { todayInTimeZone, systemClock } from '@/core/periods';
import { canManage, listActions, type ActionStatus } from '@/modules/actions';
import { getAccessContext } from '@/modules/tenancy';
import { ActionCard, ActionsNoneEmpty } from '@/components/dashboard';
import { PageHeader } from '@/components/ui/surfaces';
import { StatusControls } from './status-controls';
import { NewActionForm } from './new-action-form';

export const dynamic = 'force-dynamic';

/**
 * The Action Centre (SOW §17; ROUTE_ARCHITECTURE.md §116).
 *
 * Open work first, because that is what the page is for. Finished and dismissed actions stay
 * reachable — the list is the record of what a business decided, and a decision that has been acted
 * on is still a decision — but they are behind their own filter rather than in the way.
 */
export default async function ActionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ show?: string }>;
}) {
  const { orgSlug } = await params;
  const { show } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  if (!can(ctx, 'actions.view')) notFound();

  const filters: Readonly<Record<string, readonly ActionStatus[]>> = {
    open: ['open', 'in_progress'],
    done: ['completed', 'dismissed'],
    all: ['open', 'in_progress', 'completed', 'dismissed'],
  };
  const selected = show === 'done' || show === 'all' ? show : 'open';
  const actions = await listActions(ctx, { status: filters[selected] });
  const today = todayInTimeZone(systemClock, 'UTC');

  return (
    <>
      <PageHeader
        eyebrow="Action Centre"
        title="What we have decided to do"
        description="Everything this business chose to act on, and who is doing it."
      />

      <nav className="mt-6 flex flex-wrap gap-2 text-sm" aria-label="Filter actions">
        {(['open', 'done', 'all'] as const).map((key) => (
          <a
            key={key}
            href={`/app/${orgSlug}/actions?show=${key}`}
            aria-current={selected === key ? 'page' : undefined}
            className={selected === key
              ? 'rounded-md bg-accent-soft px-3 py-1.5 text-accent'
              : 'rounded-md px-3 py-1.5 text-ink-muted hover:text-ink'}
          >
            {key === 'open' ? 'To do' : key === 'done' ? 'Finished' : 'Everything'}
          </a>
        ))}
      </nav>

      {can(ctx, 'actions.create') ? (
        <div className="mt-6">
          <NewActionForm orgSlug={orgSlug} />
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-4">
        {actions.length === 0 ? (
          <ActionsNoneEmpty
            createHref={`/app/${orgSlug}/insights`}
            canCreate={can(ctx, 'actions.create')}
          />
        ) : (
          actions.map((action) => (
            <ActionCard
              key={action.id}
              action={action}
              today={today}
              viewerUserId={ctx.userId}
              href={`/app/${orgSlug}/actions/${action.id}`}
            >
              {canManage(ctx, action) ? (
                <StatusControls orgSlug={orgSlug} actionId={action.id} status={action.status} />
              ) : null}
            </ActionCard>
          ))
        )}
      </div>
    </>
  );
}
