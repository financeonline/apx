import { isOpen, isOverdue, type Action, type ActionPriority } from './types';

/**
 * The lenses the Action Centre offers (SOW §17; ADR-098).
 *
 * They live here and not in the page for the reason every rule in this codebase does: "due soon"
 * and "needs attention" are statements about work, and a page that decided them would be a second
 * place for them to be decided. The page renders counts and lists; it does not define them.
 *
 * **A lens is not a deadline.** `DUE_SOON_DAYS` is how far ahead this screen looks, not a date
 * MOTION assigns to anybody's work: nothing here writes a `due_date`, and an action with no date
 * appears under neither "due soon" nor "overdue" because an undated action is not late — it is
 * undated, and pretending otherwise would invent a commitment nobody made.
 */
export const DUE_SOON_DAYS = 7;

export const ACTION_VIEWS = ['attention', 'mine', 'due_soon', 'overdue', 'high', 'done', 'all'] as const;
export type ActionView = (typeof ACTION_VIEWS)[number];

export const ACTION_VIEW_LABELS: Readonly<Record<ActionView, string>> = {
  attention: 'To do',
  mine: 'Mine',
  due_soon: 'Due soon',
  overdue: 'Overdue',
  high: 'Important',
  done: 'Finished',
  all: 'Everything',
};

const URGENT: readonly ActionPriority[] = ['critical', 'high'];

/** `YYYY-MM-DD` plus n days, on the calendar rather than on a clock (ADR-007). */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isDueSoon(action: Action, today: string): boolean {
  if (action.dueDate === null || !isOpen(action.status)) return false;
  return action.dueDate >= today && action.dueDate <= addDays(today, DUE_SOON_DAYS);
}

/**
 * Whether an action belongs in a lens.
 *
 * `done` and `all` are the two that are not about open work: the list is the record of what a
 * business decided, and a decision that has been carried out is still a decision.
 */
export function inView(
  view: ActionView, action: Action, today: string, userId: string,
): boolean {
  switch (view) {
    case 'attention': return isOpen(action.status);
    case 'mine': return isOpen(action.status) && action.ownerUserId === userId;
    case 'due_soon': return isDueSoon(action, today);
    case 'overdue': return isOverdue(action, today);
    case 'high': return isOpen(action.status) && URGENT.includes(action.priority);
    case 'done': return !isOpen(action.status);
    case 'all': return true;
  }
}

export function isActionView(value: string): value is ActionView {
  return (ACTION_VIEWS as readonly string[]).includes(value);
}
