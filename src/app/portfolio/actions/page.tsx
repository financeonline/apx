import Link from 'next/link';
import { getPortfolioContext, lensTotal, loadPortfolio, loadPortfolioActions, type OpenLens } from '@/modules/portfolio';
import { PageHeader } from '@/components/ui/surfaces';
import { ActionsTable } from '@/components/portfolio';

export const dynamic = 'force-dynamic';

/**
 * The adviser's lenses over open work, in the Action Centre's own words and rules (ADR-098). Each
 * lens is a predicate in the statement and each count comes from the aggregate (ADR-114), so a
 * capped list can never make a count wrong.
 */
const LENSES: ReadonlyArray<{ view: OpenLens; label: string }> = [
  { view: 'attention', label: 'All open' },
  { view: 'overdue', label: 'Overdue' },
  { view: 'due_soon', label: 'Due soon' },
  { view: 'high', label: 'Urgent' },
  { view: 'mine', label: 'Assigned to me' },
];

export default async function PortfolioActionsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view: requested } = await searchParams;
  const lens: OpenLens = LENSES.find((l) => l.view === requested)?.view ?? 'attention';
  const ctx = await getPortfolioContext();
  const portfolio = await loadPortfolio(ctx);
  const list = await loadPortfolioActions(ctx, portfolio, lens);

  return (
    <>
      <PageHeader
        eyebrow="Command Centre"
        title={`${portfolio.counts.openActions.toLocaleString('en-GB')} open ${portfolio.counts.openActions === 1 ? 'action' : 'actions'} across your clients`}
        description={`${portfolio.counts.overdueActions.toLocaleString('en-GB')} overdue. Open an action to update it inside the organisation, where its lifecycle lives.`}
      />
      <nav aria-label="Action lenses" className="mb-4 flex flex-wrap gap-2 text-sm">
        {LENSES.map((l) => (
          <Link
            key={l.view}
            href={l.view === 'attention' ? '/portfolio/actions' : `/portfolio/actions?view=${l.view}`}
            aria-current={l.view === lens ? 'page' : undefined}
            className={`rounded-xl border px-3 py-1 font-medium transition-colors ${l.view === lens ? 'border-accent bg-accent text-surface' : 'border-line bg-surface text-ink-muted hover:border-accent/45 hover:bg-accent-soft hover:text-accent'}`}
          >
            {l.label} <span className="tabular-nums">{lensTotal(portfolio, l.view).toLocaleString('en-GB')}</span>
          </Link>
        ))}
      </nav>
      <ActionsTable list={list} organisations={portfolio.organisations} today={portfolio.today} viewerUserId={ctx.userId} />
    </>
  );
}
