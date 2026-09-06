/**
 * The Action Centre's vocabulary (SOW §17; DATABASE_ARCHITECTURE.md `actions`).
 *
 * An action is the one thing in MOTION a person commits to. Everything else — a figure, an alert, a
 * health score — is the product telling somebody what is true; an action is somebody saying what
 * they are going to do about it, with their name on it. That is why it carries the evidence it was
 * created from, frozen at the moment of the decision (EVIDENCE_MODEL.md §5).
 */

export const ACTION_STATUSES = ['open', 'in_progress', 'completed', 'dismissed'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ACTION_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type ActionPriority = (typeof ACTION_PRIORITIES)[number];

export const ACTION_SOURCES = ['ai', 'alert', 'health_score', 'user', 'report'] as const;
export type ActionSource = (typeof ACTION_SOURCES)[number];

export interface Action {
  readonly id: string;
  readonly title: string;
  readonly issue: string | null;
  readonly recommendation: string | null;
  readonly priority: ActionPriority;
  readonly ownerUserId: string | null;
  readonly ownerName: string | null;
  readonly dueDate: string | null;
  readonly status: ActionStatus;
  readonly sourceType: ActionSource;
  readonly sourceId: string | null;
  readonly evidenceBundleId: string | null;
  readonly outcomeNotes: string | null;
  /** NUMERIC(18,2) as a string; money never becomes a JS number (ADR-006). */
  readonly outcomeValue: string | null;
  readonly outcomeCurrency: string | null;
  readonly completedAt: string | null;
  readonly dismissedReason: string | null;
  readonly createdAt: string;
}

/** The two statuses that mean "still somebody's problem". */
export const OPEN_STATUSES: readonly ActionStatus[] = ['open', 'in_progress'];

export function isOpen(status: ActionStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/**
 * Whether a status change is one the product allows.
 *
 * A completed or dismissed action can be RE-OPENED — work turns out not to have been finished, and
 * a system that forbade saying so would be encouraging people to keep a second list somewhere else.
 * What it cannot do is move from completed straight to dismissed, or the other way: those are two
 * different accounts of the same work, and one has to be withdrawn before the other is asserted.
 */
export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  if (from === to) return true;
  if (from === 'completed' && to === 'dismissed') return false;
  if (from === 'dismissed' && to === 'completed') return false;
  return true;
}

/**
 * An action is overdue when its due date has passed and nobody has finished it.
 *
 * `today` is passed in rather than read from a clock, so a list rendered on the server and a test
 * asserting on it can agree about what day it is.
 */
export function isOverdue(action: Pick<Action, 'dueDate' | 'status'>, today: string): boolean {
  return action.dueDate !== null && isOpen(action.status) && action.dueDate < today;
}

/** Critical first, then by due date, then oldest first — the order a person would work them in. */
const PRIORITY_ORDER: Readonly<Record<ActionPriority, number>> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

export function byUrgency(a: Action, b: Action): number {
  const priority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  if (priority !== 0) return priority;
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  }
  return a.createdAt.localeCompare(b.createdAt);
}
