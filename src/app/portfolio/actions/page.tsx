import Link from 'next/link';
import { getPortfolioContext, loadPortfolio } from '@/modules/portfolio';
import { byUrgency, inView, isActionView, type Action, type ActionView } from '@/modules/actions';
import { PageHeader } from '@/components/ui/surfaces';
import { ActionsTable } from '@/components/portfolio';

export const dynamic = 'force-dynamic';

/** The adviser's lenses over open work, in the Action Centre's own words and rules (ADR-098). */
const LENSES: ReadonlyArray<{ view: ActionView; label: string }> = [
  { view: 'attention', label: 'All open' },
  { view: 'overdue', label: 'Overdue' },
  { view: 'due_soon', label: 'Due soon' },
  { view: 'high', label: 'Urgent' },
  { view: 'mine', label: 'Assigned to me' },
];

export default async function PortfolioActionsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view: requested } = await searchParams;
  const view: ActionView = requested !== undefined && isActionView(requested) && LENSES.some((l) => l.view === requested)
    ? requested
    : 'attention';
  const ctx = await getPortfolioContext();
  const portfolio = await loadPortfolio(ctx);

  // `inView` and `byUrgency` are the Action Centre's; the portfolio row carries the fields they read.
  const asAction = (a: (typeof portfolio.actions)[number]): Pick<Action, 'status' | 'ownerUserId' | 'dueDate' | 'priority' | 'createdAt'> =>
    ({ status: a.status, ownerUserId: a.ownerUserId, dueDate: a.dueDate, priority: a.priority, createdAt: a.createdAt });
  const rows = portfolio.actions
    .filter((a) => inView(view, asAction(a) as Action, portfolio.today, ctx.userId))
    .sort((a, b) => byUrgency(asAction(a) as Action, asAction(b) as Action));
  const counts = Object.fromEntries(
    LENSES.map((l) => [l.view, portfolio.actions.filter((a) => inView(l.view, asAction(a) as Action, portfolio.today, ctx.userId)).length]),
  ) as Record<ActionView, number>;

  return (
    <>
      <PageHeader
        eyebrow="Command Centre"
        title={`${portfolio.counts.openActions} open ${portfolio.counts.openActions === 1 ? 'action' : 'actions'} across your clients`}
        description={`${portfolio.counts.overdueActions} overdue. Open an action to update it inside the organisation, where its lifecycle lives.`}
      />
      <nav aria-label="Action lenses" className="mb-4 flex flex-wrap gap-2 text-sm">
        {LENSES.map((lens) => (
          <Link
            key={lens.view}
            href={lens.view === 'attention' ? '/portfolio/actions' : `/portfolio/actions?view=${lens.view}`}
            aria-current={lens.view === view ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 ${lens.view === view ? 'border-ink bg-ink text-surface' : 'border-line text-ink-muted hover:text-ink'}`}
          >
            {lens.label} <span className="tabular-nums">{counts[lens.view]}</span>
          </Link>
        ))}
      </nav>
      <ActionsTable actions={rows} organisations={portfolio.organisations} today={portfolio.today} viewerUserId={ctx.userId} />
    </>
  );
}
