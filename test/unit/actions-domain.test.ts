import { describe, expect, it } from 'vitest';
import {
  ACTION_STATUSES, byUrgency, canTransition, isOpen, isOverdue, type Action,
} from '@/modules/actions';

/**
 * The Action Centre's domain rules (SOW §17).
 *
 * An action is the one object in MOTION that records a DECISION rather than a fact, which is what
 * makes its status machine worth stating carefully: the list is an account of what a business chose
 * to do, and two contradictory accounts of the same work is worse than none.
 */

function action(over: Partial<Action> = {}): Action {
  return {
    id: 'a-1',
    title: 'Chase the overdue invoices',
    issue: null,
    recommendation: null,
    priority: 'medium',
    ownerUserId: null,
    ownerName: null,
    dueDate: null,
    status: 'open',
    sourceType: 'user',
    sourceId: null,
    evidenceBundleId: null,
    outcomeNotes: null,
    outcomeValue: null,
    outcomeCurrency: null,
    completedAt: null,
    dismissedReason: null,
    createdAt: '2026-03-01T09:00:00Z',
    ...over,
  };
}

describe('what counts as still somebody’s problem', () => {
  it('open and in progress, and nothing else', () => {
    expect(ACTION_STATUSES.filter(isOpen)).toEqual(['open', 'in_progress']);
  });
});

describe('the status machine (§17)', () => {
  /*
   * Re-opening is allowed on purpose. Work turns out not to have been finished, and a system that
   * forbade saying so would teach people to keep a second list somewhere it could not be audited.
   */
  it('lets finished work be re-opened', () => {
    expect(canTransition('completed', 'open')).toBe(true);
    expect(canTransition('dismissed', 'in_progress')).toBe(true);
  });

  /*
   * But completed and dismissed are two different accounts of the same work. One has to be
   * withdrawn before the other is asserted, or the record says both at once.
   */
  it('refuses to swap one final account for the other in place', () => {
    expect(canTransition('completed', 'dismissed')).toBe(false);
    expect(canTransition('dismissed', 'completed')).toBe(false);
  });

  it('allows the ordinary forward moves, and a no-op', () => {
    expect(canTransition('open', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
    expect(canTransition('open', 'dismissed')).toBe(true);
    expect(canTransition('open', 'open')).toBe(true);
  });
});

describe('overdue means late AND unfinished', () => {
  const today = '2026-03-15';

  it('is overdue when the date has passed and nobody has finished it', () => {
    expect(isOverdue(action({ dueDate: '2026-03-10' }), today)).toBe(true);
    expect(isOverdue(action({ dueDate: '2026-03-10', status: 'in_progress' }), today)).toBe(true);
  });

  it('is not overdue once the work is done or dropped', () => {
    expect(isOverdue(action({ dueDate: '2026-03-10', status: 'completed' }), today)).toBe(false);
    expect(isOverdue(action({ dueDate: '2026-03-10', status: 'dismissed' }), today)).toBe(false);
  });

  it('is not overdue on the due date itself, or without one', () => {
    expect(isOverdue(action({ dueDate: '2026-03-15' }), today)).toBe(false);
    expect(isOverdue(action({ dueDate: null }), today)).toBe(false);
  });
});

describe('the order a person would work them in', () => {
  it('puts the most urgent first, then the soonest due, then the oldest', () => {
    const list = [
      action({ id: 'low', priority: 'low' }),
      action({ id: 'critical', priority: 'critical' }),
      action({ id: 'high-later', priority: 'high', dueDate: '2026-04-01' }),
      action({ id: 'high-sooner', priority: 'high', dueDate: '2026-03-20' }),
    ];
    expect([...list].sort(byUrgency).map((a) => a.id))
      .toEqual(['critical', 'high-sooner', 'high-later', 'low']);
  });

  it('puts an action with no due date after one that has one, at the same priority', () => {
    const list = [
      action({ id: 'undated', priority: 'high' }),
      action({ id: 'dated', priority: 'high', dueDate: '2026-04-01' }),
    ];
    expect([...list].sort(byUrgency).map((a) => a.id)).toEqual(['dated', 'undated']);
  });

  it('is a total order — two identical actions fall back to when they were created', () => {
    const list = [
      action({ id: 'newer', createdAt: '2026-03-02T09:00:00Z' }),
      action({ id: 'older', createdAt: '2026-03-01T09:00:00Z' }),
    ];
    expect([...list].sort(byUrgency).map((a) => a.id)).toEqual(['older', 'newer']);
  });
});
