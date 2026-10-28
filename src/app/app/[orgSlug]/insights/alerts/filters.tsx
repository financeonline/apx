import Link from 'next/link';
import { TOUCH_TARGET } from '@/components/ui/clickable-card';
import { severityLabel } from '@/components/dashboard';
import type { AlertQuery, AlertSeverity } from '@/modules/alerts';

/**
 * The alert list's filters (UX_ARCHITECTURE.md §6).
 *
 * Links rather than a client-side control, so a filtered list is a URL somebody can send to their
 * accountant — and so the page keeps working with JavaScript off, which the whole app does.
 *
 * The DEFAULT is open and acknowledged: the things still standing. Resolved and dismissed alerts are
 * history, and a list that opens with a year of resolved items buries the four that matter.
 *
 * The three status choices are always visible; the five severities sit behind a "How serious"
 * toggle, open only when one is in use. Eight equal-weight pills was a row an owner had to read
 * before reaching the alerts, and most never narrow by severity at all.
 */

export type AlertStatusFilter = 'standing' | 'open' | 'all';

export interface AlertFilterState {
  readonly status: AlertStatusFilter;
  readonly severity: AlertSeverity | null;
  readonly query: AlertQuery;
  /** True when the reader has narrowed the list, so the empty state can say which one they hit. */
  readonly any: boolean;
}

const STATUS_QUERY: Readonly<Record<AlertStatusFilter, AlertQuery['statuses']>> = {
  standing: ['open', 'acknowledged'],
  open: ['open'],
  all: undefined,
};

const SEVERITIES: readonly AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function first(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export function parseAlertFilters(
  searchParams: Record<string, string | string[] | undefined>,
): AlertFilterState {
  const rawStatus = first(searchParams.status);
  const status: AlertStatusFilter =
    rawStatus === 'open' || rawStatus === 'all' ? rawStatus : 'standing';

  const rawSeverity = first(searchParams.severity);
  const severity = SEVERITIES.find((s) => s === rawSeverity) ?? null;

  return {
    status,
    severity,
    query: {
      statuses: STATUS_QUERY[status],
      severities: severity === null ? undefined : [severity],
      limit: 200,
    },
    any: status !== 'standing' || severity !== null,
  };
}

function href(orgSlug: string, status: AlertStatusFilter, severity: AlertSeverity | null): string {
  const params = new URLSearchParams();
  if (status !== 'standing') params.set('status', status);
  if (severity !== null) params.set('severity', severity);
  const query = params.toString();
  return `/app/${orgSlug}/insights${query === '' ? '' : `?${query}`}`;
}

const STATUS_LABELS: Readonly<Record<AlertStatusFilter, string>> = {
  standing: 'Not dealt with yet',
  open: 'Not seen yet',
  all: 'All, including dealt with',
};

export function AlertFilters({
  orgSlug, active,
}: {
  orgSlug: string;
  active: AlertFilterState;
}) {
  return (
    <nav className="flex flex-wrap items-center gap-1.5 text-sm" aria-label="Alert filters">
      {(Object.keys(STATUS_LABELS) as AlertStatusFilter[]).map((status) => (
        <FilterLink
          key={status}
          href={href(orgSlug, status, active.severity)}
          current={active.status === status}
        >
          {STATUS_LABELS[status]}
        </FilterLink>
      ))}
      <details open={active.severity !== null}>
        <summary className={`inline-flex cursor-pointer items-center rounded-full px-2.5 py-0.5 text-ink-muted hover:text-accent ${TOUCH_TARGET}`}>
          How serious: {active.severity === null ? 'Any' : severityLabel(active.severity)}
        </summary>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <FilterLink href={href(orgSlug, active.status, null)} current={active.severity === null}>
            Any
          </FilterLink>
          {SEVERITIES.map((severity) => (
            <FilterLink
              key={severity}
              href={href(orgSlug, active.status, severity)}
              current={active.severity === severity}
            >
              {severityLabel(severity)}
            </FilterLink>
          ))}
        </div>
      </details>
    </nav>
  );
}

function FilterLink({
  href: to, current, children,
}: {
  href: string; current: boolean; children: React.ReactNode;
}) {
  return (
    <Link
      href={to}
      aria-current={current ? 'true' : undefined}
      className={`inline-flex items-center ${TOUCH_TARGET} ${current
        ? 'rounded-full bg-accent-soft px-2.5 py-0.5 font-medium text-accent'
        : 'rounded-full bg-surface-sunken px-2.5 py-0.5 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent'}`}
    >
      {children}
    </Link>
  );
}
