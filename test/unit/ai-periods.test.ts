import { describe, expect, it } from 'vitest';
import { acceptableLabels, resolvePeriodContext, type PeriodRow } from '@/modules/ai';

/**
 * Period resolution (AI_ARCHITECTURE.md §8).
 *
 * Runs before the model sees the question, which is what makes a customer named
 * "Acme (fiscal year starts in July)" inert: it never participates, and tools reject any label
 * outside the set produced here (F-C-10).
 *
 * The property that matters most is agreement: the default is the latest COMPLETE month, the same
 * one Home uses (ADR-030, F-D-09). An analyst that disagreed with the dashboard about "this month"
 * would make every answer arguable, and the argument would be about MOTION rather than the business.
 */

function month(id: string, start: string, label: string, over: Partial<PeriodRow> = {}): PeriodRow {
  return { id, label, periodStart: start, isComplete: true, hasData: true, ...over };
}

const PERIODS: readonly PeriodRow[] = [
  month('p-2025-11', '2025-11-01', 'November 2025'),
  month('p-2025-12', '2025-12-01', 'December 2025'),
  month('p-2026-01', '2026-01-01', 'January 2026'),
  month('p-2026-02', '2026-02-01', 'February 2026'),
  month('p-2026-03', '2026-03-01', 'March 2026'),
  month('p-2026-04', '2026-04-01', 'April 2026', { isComplete: false }),
];

const resolve = (question: string, over: Partial<Parameters<typeof resolvePeriodContext>[0]> = {}) =>
  resolvePeriodContext({ question, periods: PERIODS, fiscalYearStartMonth: 1, ...over });

const labelsOf = (question: string, over = {}) => resolve(question, over).resolved.map((p) => p.label);

describe('the default is the latest complete month, as everywhere else in the product', () => {
  it('answers a question that names no period at all', () => {
    const context = resolve('How are we doing?');
    expect(context.default?.label).toBe('March 2026');
    expect(context.resolved.map((p) => p.label)).toEqual(['March 2026']);
  });

  it('"this month" means the latest COMPLETE month, and says why', () => {
    const context = resolve('How is this month looking?');
    expect(context.resolved.map((p) => p.label)).toEqual(['March 2026']);
    expect(context.notes.join(' ')).toMatch(/April 2026 is still partial/);
  });

  it('never offers a partial month as the default', () => {
    expect(resolve('How are we doing?').default?.label).not.toBe('April 2026');
  });
});

describe('the phrase map §8 lists', () => {
  it('a month with a year', () => {
    expect(labelsOf('What happened in March 2026?')).toEqual(['March 2026']);
  });

  it('a bare month, resolved to the most recent occurrence WITH data (§8)', () => {
    expect(labelsOf('What happened in December?')).toEqual(['December 2025']);
  });

  it('last month', () => {
    expect(labelsOf('How did last month compare?')).toEqual(['February 2026']);
  });

  it('the last N months, in the forms a person writes them', () => {
    expect(labelsOf('Show me the last 3 months.')).toHaveLength(3);
    expect(labelsOf('Show me the last three months.')).toHaveLength(3);
    expect(labelsOf('Show me the last six months.')).toHaveLength(5);
  });

  it('says so rather than inventing months it does not have', () => {
    expect(resolve('Show me the last six months.').notes.join(' '))
      .toMatch(/Only 5 complete months/);
  });

  it('year to date, from the fiscal year start', () => {
    expect(labelsOf('How is the year to date?'))
      .toEqual(['March 2026', 'February 2026', 'January 2026']);
  });

  it('a fiscal year by name', () => {
    expect(labelsOf('How was FY26?')).toEqual(['March 2026', 'February 2026', 'January 2026']);
  });

  it('last quarter, counted from the fiscal year start', () => {
    expect(labelsOf('How was last quarter?')).toEqual(['December 2025', 'November 2025']);
    expect(resolve('How was last quarter?').notes.join(' ')).toMatch(/Only part of the previous quarter/);
  });

  it('a month the organisation has no data for is said, not guessed at', () => {
    expect(resolve('What happened in March 2020?').notes.join(' ')).toMatch(/no data for march 2020/i);
  });
});

describe('ambiguity is a decision made here, not a mood the model adopts (§8, §7.7)', () => {
  /*
   * A business whose year starts in April has a Q1 of April–June. Answering with January–March
   * would be wrong in a way nobody notices until they reconcile it, and there is no safe default —
   * so the analyst asks. This flag is the ONLY thing that admits a `clarification` response.
   */
  it('flags Q1 when the financial year is not the calendar year', () => {
    const context = resolve('How was Q1?', { fiscalYearStartMonth: 4 });
    expect(context.ambiguous).toBe(true);
    expect(context.notes.join(' ')).toMatch(/financial year starts in april/i);
    expect(context.resolved, 'nothing is resolved, so no tool can run').toEqual([]);
  });

  it('does not flag Q1 when the two coincide', () => {
    const context = resolve('How was Q1?');
    expect(context.ambiguous).toBe(false);
    expect(context.resolved.map((p) => p.label))
      .toEqual(['March 2026', 'February 2026', 'January 2026']);
  });

  it('flags a comparison with a year that has no data', () => {
    const context = resolve('How does this compare to last year?');
    expect(context.ambiguous).toBe(true);
    expect(context.notes.join(' ')).toMatch(/no data for the same period last year/i);
  });

  it('resolves the comparison when the earlier year is there', () => {
    const withHistory = [...PERIODS, month('p-2025-03', '2025-03-01', 'March 2025')];
    const context = resolvePeriodContext({
      question: 'How does this compare to last year?', periods: withHistory, fiscalYearStartMonth: 1,
    });
    expect(context.ambiguous).toBe(false);
    expect(context.resolved.map((p) => p.label)).toContain('March 2025');
  });
});

describe('the label set a tool will accept (§3)', () => {
  it('is exactly what resolution produced, plus this turn’s meta periods', () => {
    const context = resolve('What happened in March 2026?');
    const labels = acceptableLabels(context, [{ id: 'p-2025-12', label: 'December 2025' }]);
    expect([...labels].sort()).toEqual(['December 2025', 'March 2026']);
    // A label the question never resolved to is not acceptable, however plausible it looks.
    expect(labels.has('April 2026')).toBe(false);
  });
});
