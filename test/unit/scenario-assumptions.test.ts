import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/core/errors';
import {
  MAX_AMOUNT, MAX_ASSUMPTIONS, MAX_HEADCOUNT, MAX_PERCENT, MIN_PERCENT,
  boundIssues, conflictIssues, defaultCashEffect, parseAssumptions,
  type Assumption,
} from '@/modules/scenarios';

/**
 * What a user may assume (REQ-SC-02…08, §4; ADR-100).
 *
 * The property every case below is really about: **bad input never becomes a number**. A scenario
 * that silently read `12abc` as 12, or an empty box as zero, would answer a question nobody asked
 * and answer it confidently.
 */

const revenue = (over: Partial<Record<string, unknown>> = {}): unknown => ({
  kind: 'revenue_change', mode: 'percent', value: '10',
  directCostsFollow: false, startsInMonth: 1, cashEffect: 'none', ...over,
});

const issuesOf = (input: unknown): Array<{ path: string; message: string }> => {
  try {
    parseAssumptions(input);
  } catch (error) {
    if (error instanceof ValidationError) return error.issues;
    throw error;
  }
  throw new Error('expected the assumptions to be refused');
};

describe('an assumption is accepted only when MOTION can read every part of it', () => {
  it('accepts a well-formed set and hands it back typed', () => {
    const parsed = parseAssumptions([revenue()]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.kind).toBe('revenue_change');
  });

  it.each([
    ['text in a number box', '12abc'],
    ['a thousands separator', '1,500'],
    ['an empty box', ''],
    ['only a sign', '-'],
    ['exponent notation', '1e5'],
    ['three decimal places', '10.005'],
    ['a currency symbol', '£2500'],
  ])('refuses %s rather than reading a number out of it', (_name, value) => {
    const issues = issuesOf([revenue({ mode: 'amount', value })]);
    expect(issues.length).toBeGreaterThan(0);
    // The decisive assertion: nothing was accepted, so nothing became zero.
    expect(() => parseAssumptions([revenue({ mode: 'amount', value })])).toThrow(ValidationError);
  });

  it('refuses a percentage outside the bounds it can speak about', () => {
    expect(issuesOf([revenue({ value: String(MAX_PERCENT + 1) })])[0]!.message)
      .toContain(`${MIN_PERCENT}%`);
    expect(issuesOf([revenue({ value: String(MIN_PERCENT - 1) })]).length).toBeGreaterThan(0);
  });

  it('allows a fall of exactly one hundred per cent, which is a real thing to model', () => {
    expect(parseAssumptions([revenue({ value: '-100' })])).toHaveLength(1);
  });

  it('judges the same string differently in the two modes, because the modes mean different things', () => {
    // 500 is a plausible marketing budget and an implausible percentage.
    expect(() => parseAssumptions([
      { kind: 'marketing_change', mode: 'amount', value: '500', startsInMonth: 1, cashEffect: 'same_month' },
    ])).not.toThrow();
    expect(() => parseAssumptions([
      { kind: 'marketing_change', mode: 'percent', value: '5000', startsInMonth: 1, cashEffect: 'same_month' },
    ])).toThrow(ValidationError);
  });

  it('refuses an amount larger than MOTION can model rather than overflowing quietly', () => {
    const issues = issuesOf([revenue({ mode: 'amount', value: String(MAX_AMOUNT + 1) })]);
    expect(issues[0]!.message).toMatch(/larger than MOTION can model/);
  });

  it('refuses a month outside the three the forecast speaks about', () => {
    expect(() => parseAssumptions([revenue({ startsInMonth: 4 })])).toThrow(ValidationError);
    expect(() => parseAssumptions([revenue({ startsInMonth: 0 })])).toThrow(ValidationError);
  });

  it('refuses an unknown kind instead of ignoring it', () => {
    expect(() => parseAssumptions([{ ...(revenue() as object), kind: 'tax_change' }]))
      .toThrow(ValidationError);
  });
});

describe('hiring, pricing and debt each need the number that makes them answerable', () => {
  it('will not take a hire without a cost (§8)', () => {
    expect(() => parseAssumptions([
      { kind: 'hiring', headcount: 2, startsInMonth: 1, cashEffect: 'same_month' },
    ])).toThrow(ValidationError);
  });

  it('will not take a hire whose cost is zero or negative', () => {
    for (const cost of ['0', '-100']) {
      const issues = issuesOf([
        { kind: 'hiring', headcount: 1, monthlyCostPerPerson: cost, startsInMonth: 1, cashEffect: 'same_month' },
      ]);
      expect(issues[0]!.message, cost).toMatch(/more than zero/);
    }
  });

  it('caps headcount so a mistyped field is an error, not a forecast', () => {
    expect(() => parseAssumptions([
      { kind: 'hiring', headcount: MAX_HEADCOUNT + 1, monthlyCostPerPerson: '3000', startsInMonth: 1, cashEffect: 'same_month' },
    ])).toThrow(ValidationError);
  });

  it('will not take a price change without saying what happens to the number of sales (§9)', () => {
    expect(() => parseAssumptions([
      { kind: 'pricing_change', pricePercent: '5', directCostsFollow: false, startsInMonth: 1, cashEffect: 'none' },
    ])).toThrow(ValidationError);
  });

  it('accepts zero sales-volume change, which is the statement "the same number of sales"', () => {
    expect(parseAssumptions([
      { kind: 'pricing_change', pricePercent: '5', volumePercent: '0', directCostsFollow: false, startsInMonth: 1, cashEffect: 'none' },
    ])).toHaveLength(1);
  });

  it('accepts a repayment with no interest, because "none given" is an answer (§11)', () => {
    const parsed = parseAssumptions([
      { kind: 'debt_repayment', monthlyAmount: '1200', monthlyInterest: null, startsInMonth: 1, cashEffect: 'same_month' },
    ]);
    expect((parsed[0] as { monthlyInterest: string | null }).monthlyInterest).toBeNull();
  });
});

describe('a set of assumptions can be wrong even when every one of them is right (§4)', () => {
  const pricing = {
    kind: 'pricing_change', pricePercent: '5', volumePercent: '0',
    directCostsFollow: false, startsInMonth: 1, cashEffect: 'none',
  };

  it('refuses an empty set: a scenario has to change something', () => {
    expect(issuesOf([])[0]!.message).toMatch(/at least one/);
  });

  it('refuses the same kind twice, which would apply the change twice over', () => {
    expect(issuesOf([revenue(), revenue({ value: '20' })])[0]!.message).toMatch(/changed twice/);
  });

  it('refuses a sales change beside a price change: both move sales', () => {
    expect(issuesOf([revenue(), pricing])[0]!.message).toMatch(/Choose one of the two/);
  });

  it('refuses more changes at once than the page can honestly present', () => {
    const many = Array.from({ length: MAX_ASSUMPTIONS + 1 }, (_, i) => revenue({ value: String(i + 1) }));
    expect(issuesOf(many).some((issue) => /at most/.test(issue.message))).toBe(true);
  });

  it('refuses a borrowing that claims not to move cash', () => {
    const issues = conflictIssues([
      { kind: 'debt_drawdown', amount: '5000', startsInMonth: 1, cashEffect: 'none' } as Assumption,
    ]);
    expect(issues.some((i) => /always move cash/.test(i.message))).toBe(true);
  });

  it('reports every objection at once rather than one at a time', () => {
    const issues = issuesOf([revenue({ value: '9999' }), revenue({ value: '8888' })]);
    expect(issues.length).toBeGreaterThan(1);
  });
});

describe('the answers the form offers first are stated, never hidden', () => {
  it('offers costs as cash and sales as not cash, because collection terms are unknown (§7, §10)', () => {
    expect(defaultCashEffect('payroll_change')).toBe('same_month');
    expect(defaultCashEffect('marketing_change')).toBe('same_month');
    expect(defaultCashEffect('hiring')).toBe('same_month');
    expect(defaultCashEffect('revenue_change')).toBe('none');
    expect(defaultCashEffect('pricing_change')).toBe('none');
  });

  it('finds no fault with a well-formed assumption', () => {
    expect(boundIssues(parseAssumptions([revenue()])[0]!)).toEqual([]);
  });
});
