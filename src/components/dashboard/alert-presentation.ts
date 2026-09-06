import type { BadgeTone } from '@/components/ui/surfaces';
import {
  SEVERITY_ORDER, familyOf, thresholdNoteFor, whyItMattersFor, type AlertSeverity,
} from '@/modules/alerts';

import { type AlertStatus } from './alert-status';

export { familyOf, thresholdNoteFor, whyItMattersFor };
export {
  STATUS_ACTION_LABELS, STATUS_LABELS, UNDO_WINDOW_MS, allowedStatuses, type AlertStatus,
} from './alert-status';

/** Tone per status, for the badge on a resolved or dismissed row. */
export const STATUS_TONES: Readonly<Record<AlertStatus, BadgeTone>> = {
  open: 'neutral',
  acknowledged: 'accent',
  resolved: 'accent',
  dismissed: 'neutral',
};

/**
 * Presenting an alert (UX_ARCHITECTURE.md §8.3, DESIGN.md §11).
 *
 * Pure, so the wording and the colour semantics can be asserted without a DOM — including the rule
 * that matters most here: severity is the ONLY thing that decides an alert's colour, and every badge
 * carries its word as well as its hue, because a red dot means nothing to a reader who cannot see
 * red.
 */

export const SEVERITY_TONES: Readonly<Record<AlertSeverity, BadgeTone>> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warn',
  low: 'neutral',
  info: 'neutral',
};

export const SEVERITY_LABELS: Readonly<Record<AlertSeverity, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'For information',
};

export function severityTone(severity: AlertSeverity): BadgeTone {
  return SEVERITY_TONES[severity];
}

export function severityLabel(severity: AlertSeverity): string {
  return SEVERITY_LABELS[severity];
}

/** Worst first. The list's order is the order a reader should work through it. */
export function bySeverity<T extends { severity: AlertSeverity; lastEvaluatedAt: string }>(
  alerts: readonly T[],
): T[] {
  return [...alerts].sort((a, b) => {
    const severity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (severity !== 0) return severity;
    return b.lastEvaluatedAt.localeCompare(a.lastEvaluatedAt);
  });
}

/**
 * Why an alert is in the state it is in.
 *
 * `condition_cleared` and `condition_returned` are the two a reader is most likely to be confused
 * by — an alert they never touched has changed state — so both say plainly that the engine did it.
 */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  user: '',
  condition_cleared: 'Resolved automatically — this is no longer happening.',
  condition_returned: 'This came back after being resolved.',
  record_removed: 'Resolved automatically — the transaction behind it was removed.',
  rule_retired: 'This check is no longer in use.',
  severity_increased: 'Re-opened because it got worse.',
};

export function reasonText(code: string): string | null {
  const text = REASON_TEXT[code];
  return text === undefined || text === '' ? null : text;
}

/** §6: the empty state for a list with nothing in it is a good outcome, and should read like one. */
export const NO_ALERTS_TITLE = 'Nothing needs your attention';
export const NO_ALERTS_BODY =
  'We check your figures for seventeen things every time your data changes. Nothing has tripped a threshold this month.';
export const NO_ALERTS_FILTERED_TITLE = 'Nothing matches these filters';
export const NO_ALERTS_FILTERED_BODY = 'Try widening the status or severity filter.';

