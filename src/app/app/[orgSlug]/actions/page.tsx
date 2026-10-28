import { can } from '@/core/permissions';
import { todayInTimeZone, systemClock } from '@/core/periods';
import {
  ACTION_VIEW_LABELS, canManage, isActionView, loadActionCentre, type ActionView,
} from '@/modules/actions';
import { getAccessContext } from '@/modules/tenancy';
import { ActionCard, ActionsNoneEmpty } from '@/components/dashboard';
import { PageHeader } from '@/components/ui/surfaces';
import { TOUCH_TARGET } from '@/components/ui/clickable-card';
import { StatusControls } from './status-controls';
import { NewActionForm } from './new-action-form';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/** A lens tab: a pill, and a full tap target on a touch screen. */
const LENS = `inline-flex items-center rounded-full px-3.5 py-1.5 ${TOUCH_TARGET}`;

/**
 * The lenses in two rows (client-friendliness pass, 2026-10-28). Seven equal pills was a row an
 * owner had to read before the list; the four that answer "what is on the list" come first, and
 * the three that narrow it by date or importance sit beneath, smaller, under their own label.
 * Every lens is still on the page with its count — nothing is hidden (journey-10 asserts all seven).
 */
const MAIN_LENSES: readonly ActionView[] = ['attention', 'mine', 'done', 'all'];
const NARROW_LENSES: readonly ActionView[] = ['due_soon', 'overdue', 'high'];

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
      {/* What the page is for, once, under the title (client-friendliness pass, 2026-10-28). */}
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Your to-do list for the business: things we spotted and things you added. Press
        &ldquo;Start&rdquo; when someone picks one up, and &ldquo;Mark as done&rdquo; when it is
        finished.
      </p>

      {/*
        * The lenses (SOW §17). A tab carries its count so a reader can see where the work is before
        * choosing, and a lens with nothing in it is shown greyed rather than hidden — "nothing is
        * overdue" is the most reassuring thing this page can say, and hiding the tab would make it
        * unsayable.
        */}
      <nav className="mt-6 flex flex-col gap-2.5 text-sm" aria-label="Filter actions">
        <div className="flex flex-wrap gap-2">
          {MAIN_LENSES.map((key) => (
            <a
              key={key}
              href={`/app/${orgSlug}/actions?show=${key}`}
              aria-current={selected === key ? 'page' : undefined}
              className={`${LENS} ${selected === key
                ? 'bg-accent-soft font-medium text-accent'
                : centre.counts[key] === 0
                  ? 'border border-line bg-surface text-ink-faint hover:text-ink'
                  : 'border border-line bg-surface text-ink-muted transition-colors hover:border-accent/45 hover:text-accent'}`}
            >
              {ACTION_VIEW_LABELS[key]}
              <span className="ml-1.5 tabular-nums text-ink-faint">{centre.counts[key]}</span>
            </a>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-ink-faint">Only show:</span>
          {NARROW_LENSES.map((key) => (
            <a
              key={key}
              href={`/app/${orgSlug}/actions?show=${key}`}
              aria-current={selected === key ? 'page' : undefined}
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 ${TOUCH_TARGET} ${selected === key
                ? 'bg-accent-soft font-medium text-accent'
                : centre.counts[key] === 0
                  ? 'text-ink-faint hover:text-ink'
                  : 'text-ink-muted underline underline-offset-2 hover:text-accent'}`}
            >
              {ACTION_VIEW_LABELS[key]}
              <span className="ml-1 tabular-nums text-ink-faint">{centre.counts[key]}</span>
            </a>
          ))}
        </div>
      </nav>

      {can(ctx, 'actions.create') ? (
        <div className="mt-6">
          <NewActionForm orgSlug={orgSlug} />
        </div>
      ) : null}

      {/* A readable width for the list on a very wide screen. */}
      <div className="mt-6 flex max-w-5xl flex-col gap-4">
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
