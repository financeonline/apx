/**
 * Words for the Command Centre's facts. Pure, and the only place the portfolio does date
 * arithmetic — components render what this returns (`motion/no-arithmetic-in-components`).
 */

import type { ActionPriority } from '@/modules/actions';
import type { AlertSeverity } from '@/modules/alerts';
import type { AttentionReasonKind, CappedList, ClientCounts } from './types';

const DAY_MS = 86_400_000;

/** "today", "3 days ago", "6 weeks ago" — for how long an alert has stood. */
export function ageLabel(sinceIso: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(sinceIso).getTime()) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/** "overdue by 4 days", "due today", "due in 3 days", "due 12 Oct 2026", or null when undated. */
export function dueLabel(dueDate: string | null, today: string): string | null {
  if (dueDate === null) return null;
  const days = Math.round((new Date(`${dueDate}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY_MS);
  if (days < 0) return `overdue by ${-days} ${-days === 1 ? 'day' : 'days'}`;
  if (days === 0) return 'due today';
  if (days <= 14) return `due in ${days} ${days === 1 ? 'day' : 'days'}`;
  return `due ${dueDate}`;
}

export type Tone = 'neutral' | 'accent' | 'warn' | 'danger';

export function severityTone(severity: AlertSeverity): Tone {
  switch (severity) {
    case 'critical': return 'danger';
    case 'high': return 'warn';
    case 'medium': return 'accent';
    default: return 'neutral';
  }
}

export function priorityTone(priority: ActionPriority): Tone {
  switch (priority) {
    case 'critical': return 'danger';
    case 'high': return 'warn';
    case 'medium': return 'accent';
    default: return 'neutral';
  }
}

export function reasonTone(kind: AttentionReasonKind): Tone {
  switch (kind) {
    case 'critical_alert':
    case 'health_band_fell':
    case 'health_at_risk':
      return 'danger';
    case 'overdue_action':
    case 'high_alert':
    case 'organisation_suspended':
      return 'warn';
    default:
      return 'accent';
  }
}

export const SEVERITY_LABELS: Readonly<Record<AlertSeverity, string>> = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info',
};

export const PRIORITY_LABELS: Readonly<Record<ActionPriority, string>> = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
};

export const TREND_LABELS = { up: 'Rising', down: 'Falling', flat: 'Unchanged' } as const;

/** Critical plus high standing alerts, for the client row's badge. */
export function seriousAlerts(counts: Pick<ClientCounts, 'alertsCritical' | 'alertsHigh'>): number {
  return counts.alertsCritical + counts.alertsHigh;
}

/** "Showing the first 500 of 1,053, worst first." — or null when the list is complete. */
export function truncationNote(list: CappedList<unknown>, order: string): string | null {
  if (!list.truncated) return null;
  return `Showing the first ${list.rows.length.toLocaleString('en-GB')} of ${list.total.toLocaleString('en-GB')}, ${order}. Every count on this page is the full number.`;
}
