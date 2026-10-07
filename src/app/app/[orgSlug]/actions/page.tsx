import { can } from '@/core/permissions';
import { todayInTimeZone, systemClock } from '@/core/periods';
import {
  ACTION_VIEWS, ACTION_VIEW_LABELS, canManage, isActionView, loadActionCentre,
} from '@/modules/actions';
import { getAccessContext } from '@/modules/tenancy';
import { ActionCard, ActionsNoneEmpty } from '@/components/dashboard';
import { PageHeader } from '@/components/ui/surfaces';
import { StatusControls } from './status-controls';
import { NewActionForm } from './new-action-form';
import { requirePermission } from '@/app/_lib/authz';

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
  requirePermission(ctx, 'actions.view');

  const today = todayInTimeZone(systemClock, 'UTC');
  const selected = show !== undefined && isActionView(show) ? show : 'attention';
  const centre = await loadActionCentre(ctx, today, selected);
  const { actions } = centre;

  return (
    <>
      <PageHeader
        eyebrow="Action Centre"
        title="What we have decided to do"
        description={headline(centre.needingAttention, centre.overdue)}
      />

      {/*
        * The lenses (SOW §17). A tab carries its count so a reader can see where the work is before
        * choosing, and a lens with nothing in it is shown greyed rather than hidden — "nothing is
        * overdue" is the most reassuring thing this page can say, and hiding the tab would make it
        * unsayable.
        */}
      <nav className="mt-6 flex flex-wrap gap-2 text-sm" aria-label="Filter actions">
        {ACTION_VIEWS.map((key) => (
          <a
            key={key}
            href={`/app/${orgSlug}/actions?show=${key}`}
            aria-current={selected === key ? 'page' : undefined}
            className={selected === key
              ? 'rounded-full bg-accent-soft px-3.5 py-1.5 font-medium text-accent'
              : centre.counts[key] === 0
                ? 'rounded-full border border-line bg-surface px-3.5 py-1.5 text-ink-faint hover:text-ink'
                : 'rounded-full border border-line bg-surface px-3.5 py-1.5 text-ink-muted transition-colors hover:border-accent/45 hover:text-accent'}
          >
            {ACTION_VIEW_LABELS[key]}
            <span className="ml-1.5 tabular-nums text-ink-faint">{centre.counts[key]}</span>
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

/**
 * The sentence at the top: what needs doing, and whether anything is late.
 *
 * Plain words and a number, because that is the whole question the page answers on arrival. Nothing
 * is said about priority here — the list is already ordered by it, and a second summary of the same
 * fact is one more thing to read before acting.
 */
function headline(needingAttention: number, overdue: number): string {
  if (needingAttention === 0) return 'Nothing is waiting on anybody. Finished work is still here.';
  const thing = needingAttention === 1 ? '1 thing needs' : `${needingAttention} things need`;
  if (overdue === 0) return `${thing} attention.`;
  return `${thing} attention, and ${overdue === 1 ? '1 is' : `${overdue} are`} past its due date.`;
}
