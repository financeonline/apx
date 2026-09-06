import Link from 'next/link';
import { toPeriodOptions, type PeriodOptionInput } from './presentation';

/**
 * The month a period-scoped page is showing (UX_ARCHITECTURE.md §5, ADR-030).
 *
 * A list of links, not a control with state. The period is in the URL, so a refresh, the back
 * button, a bookmark and a link pasted to a colleague all land on the same month — which is the
 * behaviour a page whose whole job is "March 2026" needs. There is no client JavaScript here at
 * all.
 *
 * Monthly only (ADR-030.6). Quarters and years need materialised aggregate snapshots and are
 * post-MVP; offering them here would mean computing them in a component, which is exactly what is
 * not allowed.
 *
 * Only months that carry data are offered (§5), so the picker never leads to an empty page, and the
 * latest complete month — the one Home, Insights and Reports open on (§4) — is marked.
 */
export function PeriodPicker({
  periods,
  value,
  hrefFor,
  label = 'Period',
}: {
  /** Months with accepted data, newest first. */
  periods: readonly PeriodOptionInput[];
  value: string | null;
  /** Where each month lives. The caller owns the route, so the picker works on every page. */
  hrefFor: (periodId: string) => string;
  label?: string;
}) {
  const options = toPeriodOptions(periods, value);

  if (options.length === 0) {
    return <p className="text-sm text-ink-faint">No months with data yet.</p>;
  }

  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {options.map((option) => (
        <Link
          key={option.id}
          href={hrefFor(option.id)}
          aria-current={option.isCurrent ? 'page' : undefined}
          className={
            'rounded-md border px-2.5 py-1 text-sm transition-colors duration-100 '
            + (option.isCurrent
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-line bg-surface text-ink-muted hover:bg-surface-sunken hover:text-ink')
          }
        >
          <span className="tabular">{option.label}</span>
          {option.isLatestComplete ? (
            <>
              {/*
                The default month, named in words as well as marked (§11).
                `ink-muted`, not `ink-faint`: this label sits on the accent-soft chip of the selected
                period, where the faint token measures 4.5:1 on white but only 3.9:1 here.
              */}
              <span aria-hidden="true" className="ml-1.5 text-xs text-ink-muted">
                latest complete
              </span>
              <span className="sr-only"> — the latest complete month</span>
            </>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
