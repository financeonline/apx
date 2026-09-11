import { describe, expect, it } from 'vitest';
import {
  ACTION_VIEWS, DUE_SOON_DAYS, addDays, inView, isActionView, isDueSoon,
  type Action, type ActionPriority, type ActionStatus,
} from '@/modules/actions';

/**
 * The Action Centre's lenses (SOW §17; ADR-098).
 *
 * Two properties carry the product meaning, and both are about NOT inventing a commitment:
 *   * an action with no due date is in neither "due soon" nor "overdue" — it is undated, not late;
 *   * "due soon" looks forward only, so an overdue action appears under Overdue and not under both,
 *     which is what lets the two counts be read as separate piles of work.
 *
 * Pure: every case passes `today` in, so the answers do not move when the suite runs.
 */

const TODAY = '2026-09-12';

const action = (over: Partial<Action> = {}): Action => ({
  id: 'a1',
  title: 'Review payroll',
  issue: null,
  recommendation: null,
  priority: 'medium' as ActionPriority,
  status: 'open' as ActionStatus,
  ownerUserId: null,
  ownerName: null,
  dueDate: null,
  sourceType: 'user',
  sourceId: null,
  evidenceBundleId: null,
  outcomeNotes: null,
  outcomeValue: null,
  outcomeCurrency: null,
  completedAt: null,
  dismissedReason: null,
  createdAt: '2026-09-01T00:00:00Z',
  ...over,
} as Action);

describe('addDays walks the calendar, including across a month end', () => {
  it('adds days without drifting on a boundary', () => {
    expect(addDays('2026-09-12', 7)).toBe('2026-09-19');
    expect(addDays('2026-09-28', 7)).toBe('2026-10-05');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
  });
});

describe('an undated action is not late (§17)', () => {
  it('appears in neither due soon nor overdue', () => {
    const undated = action({ dueDate: null });
    expect(isDueSoon(undated, TODAY)).toBe(false);
    expect(inView('due_soon', undated, TODAY, 'u1')).toBe(false);
    expect(inView('overdue', undated, TODAY, 'u1')).toBe(false);
    expect(inView('attention', undated, TODAY, 'u1'), 'but it is still work to do').toBe(true);
  });
});

describe('due soon looks forward, overdue looks back, and they do not overlap', () => {
  it('puts today’s and next week’s work in due soon', () => {
    expect(isDueSoon(action({ dueDate: TODAY }), TODAY)).toBe(true);
    expect(isDueSoon(action({ dueDate: addDays(TODAY, DUE_SOON_DAYS) }), TODAY)).toBe(true);
  });

  it('excludes work beyond the window', () => {
    expect(isDueSoon(action({ dueDate: addDays(TODAY, DUE_SOON_DAYS + 1) }), TODAY)).toBe(false);
  });

  it('puts yesterday’s work in overdue and not in due soon', () => {
    const late = action({ dueDate: addDays(TODAY, -1) });
    expect(inView('overdue', late, TODAY, 'u1')).toBe(true);
    expect(inView('due_soon', late, TODAY, 'u1'), 'one pile, not both').toBe(false);
  });

  it('stops calling finished work late, however old the date', () => {
    const done = action({ dueDate: '2026-01-01', status: 'completed' });
    expect(inView('overdue', done, TODAY, 'u1')).toBe(false);
    expect(inView('done', done, TODAY, 'u1')).toBe(true);
  });
});

describe('the lenses each hold what their name says', () => {
  it('mine is the reader’s own open work, and nobody else’s', () => {
    expect(inView('mine', action({ ownerUserId: 'u1' }), TODAY, 'u1')).toBe(true);
    expect(inView('mine', action({ ownerUserId: 'u2' }), TODAY, 'u1')).toBe(false);
    expect(inView('mine', action({ ownerUserId: null }), TODAY, 'u1')).toBe(false);
    expect(inView('mine', action({ ownerUserId: 'u1', status: 'completed' }), TODAY, 'u1')).toBe(false);
  });

  it('important is critical and high, and stops there', () => {
    for (const priority of ['critical', 'high'] as const) {
      expect(inView('high', action({ priority }), TODAY, 'u1'), priority).toBe(true);
    }
    for (const priority of ['medium', 'low'] as const) {
      expect(inView('high', action({ priority }), TODAY, 'u1'), priority).toBe(false);
    }
  });

  it('everything means everything, finished included', () => {
    expect(inView('all', action({ status: 'dismissed' }), TODAY, 'u1')).toBe(true);
    expect(inView('all', action({ status: 'open' }), TODAY, 'u1')).toBe(true);
  });

  it('names every lens it offers', () => {
    for (const view of ACTION_VIEWS) expect(isActionView(view)).toBe(true);
    expect(isActionView('nonsense')).toBe(false);
  });
});
