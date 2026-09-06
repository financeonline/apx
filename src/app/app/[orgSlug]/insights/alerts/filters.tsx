import Link from 'next/link';
import type { AlertQuery, AlertSeverity } from '@/modules/alerts';

/**
 * The alert list's filters (UX_ARCHITECTURE.md §6).
 *
 * Links rather than a client-side control, so a filtered list is a URL somebody can send to their
 * accountant — and so the page keeps working with JavaScript off, which the whole app does.
 *
 * The DEFAULT is open and acknowledged: the things still standing. Resolved and dismissed alerts are
 * history, and a list that opens with a year of resolved items buries the four that matter.
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
  standing: 'Still standing',
  open: 'Open only',
  all: 'Everything, including resolved',
};

export function AlertFilters({
  orgSlug, active,
}: {
  orgSlug: string;
  active: AlertFilterState;
}) {
  return (
    <nav className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" aria-label="Alert filters">
      {(Object.keys(STATUS_LABELS) as AlertStatusFilter[]).map((status) => (
        <FilterLink
          key={status}
          href={href(orgSlug, status, active.severity)}
          current={active.status === status}
        >
          {STATUS_LABELS[status]}
        </FilterLink>
      ))}
      <span className="text-ink-faint">·</span>
      <FilterLink href={href(orgSlug, active.status, null)} current={active.severity === null}>
        Any severity
      </FilterLink>
      {SEVERITIES.map((severity) => (
        <FilterLink
          key={severity}
          href={href(orgSlug, active.status, severity)}
          current={active.severity === severity}
        >
          {severity}
        </FilterLink>
      ))}
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
      className={current ? 'text-ink underline underline-offset-2' : 'text-ink-muted hover:text-ink'}
    >
      {children}
    </Link>
  );
}
