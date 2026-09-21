import { describe, expect, it } from 'vitest';
import { formatMoney } from '@/core/money';
import {
  ASSUMPTION_KINDS, ASSUMPTION_NOTE, ASSUMPTION_QUESTION, SCENARIO_DISCLAIMER,
  assumptionSentence, unavailableText, type Assumption,
} from '@/modules/scenarios';

/**
 * The words a reader sees (§3, §15, §16; ADR-100).
 *
 * The assumptions list is the part of this phase that carries the meaning: the figures are
 * indefensible without it, so a sentence that dropped a term — the month it starts, whether direct
 * costs move, whether interest was given — would turn an explained answer into an unexplained one.
 * Every case below is about a term surviving into the sentence.
 */

// The product's own formatter, so these sentences are the ones a reader actually gets (ADR-006).
const pounds = (value: string): string => formatMoney(value, { currency: 'GBP' });
const say = (assumption: Assumption) => assumptionSentence(assumption, pounds);

describe('an assumption says, in words, exactly what was assumed', () => {
  it('states a percentage change in sales, and what it does NOT do to costs', () => {
    expect(say({
      kind: 'revenue_change', mode: 'percent', value: '10',
      directCostsFollow: false, startsInMonth: 1, cashEffect: 'none',
    })).toBe('Sales up by 10%, with direct costs unchanged');
  });

  it('states when direct costs DO move, and that the rate is the organisation’s own', () => {
    expect(say({
      kind: 'revenue_change', mode: 'percent', value: '10',
      directCostsFollow: true, startsInMonth: 1, cashEffect: 'none',
    })).toContain('direct costs moving at your current rate');
  });

  it('says "down by" for a fall rather than printing a minus sign at the reader', () => {
    expect(say({
      kind: 'revenue_change', mode: 'percent', value: '-20',
      directCostsFollow: false, startsInMonth: 1, cashEffect: 'none',
    })).toContain('Sales down by 20%');
  });

  it('formats an amount as money, per month', () => {
    expect(say({
      kind: 'payroll_change', mode: 'amount', value: '500', startsInMonth: 1, cashEffect: 'same_month',
    })).toBe('Wages up by £500 a month');
  });

  it('names the month a change starts, when it is not the first', () => {
    expect(say({
      kind: 'marketing_change', mode: 'amount', value: '250', startsInMonth: 3, cashEffect: 'same_month',
    })).toContain('from month 3');
  });

  it('does not clutter the sentence with a month when the change starts straight away', () => {
    expect(say({
      kind: 'supplier_cost_change', mode: 'percent', value: '15', startsInMonth: 1, cashEffect: 'same_month',
    })).toBe('Direct costs up by 15%');
  });

  it('states both halves of a price change, because one without the other means nothing (§9)', () => {
    const sentence = say({
      kind: 'pricing_change', pricePercent: '5', volumePercent: '-10',
      directCostsFollow: true, startsInMonth: 1, cashEffect: 'none',
    });
    expect(sentence).toContain('Prices up by 5%');
    expect(sentence).toContain('the number of sales down by 10%');
    expect(sentence).toContain('direct costs moving with the number of sales');
  });

  it('counts people correctly, and names the cost that was given (§8)', () => {
    expect(say({
      kind: 'hiring', headcount: 1, monthlyCostPerPerson: '3000', startsInMonth: 1, cashEffect: 'same_month',
    })).toContain('1 new person at £3,000 each a month');
    expect(say({
      kind: 'hiring', headcount: 2, monthlyCostPerPerson: '3000', startsInMonth: 2, cashEffect: 'same_month',
    })).toContain('2 new people');
  });

  it('says borrowing happens once, in its month', () => {
    expect(say({
      kind: 'debt_drawdown', amount: '25000', startsInMonth: 2, cashEffect: 'same_month',
    })).toBe('Borrow £25,000 in month 2');
  });

  it('says plainly that no interest is counted when none was given (§11)', () => {
    expect(say({
      kind: 'debt_repayment', monthlyAmount: '1200', monthlyInterest: null,
      startsInMonth: 1, cashEffect: 'same_month',
    })).toContain('no interest given, so none is counted');
  });

  it('names the interest when it was given', () => {
    expect(say({
      kind: 'debt_repayment', monthlyAmount: '1200', monthlyInterest: '300',
      startsInMonth: 1, cashEffect: 'same_month',
    })).toContain('plus £300 a month of interest');
  });
});

describe('nothing reaches the reader as a raw enum or a table name (§15)', () => {
  it('has a question and a note for every kind there is', () => {
    for (const kind of ASSUMPTION_KINDS) {
      expect(ASSUMPTION_QUESTION[kind], kind).toMatch(/\?$/);
      expect(ASSUMPTION_NOTE[kind].length, kind).toBeGreaterThan(20);
      expect(ASSUMPTION_QUESTION[kind], kind).not.toMatch(/_/);
    }
  });

  it('renders every refusal reason in words, and an unknown one without saying "unknown"', () => {
    for (const reason of ['no_forecast', 'metric_not_forecast', 'no_category_baseline', 'no_direct_costs', 'no_revenue_baseline']) {
      expect(unavailableText(reason), reason).not.toContain('_');
    }
    expect(unavailableText('something_new_later'))
      .toBe('MOTION cannot work this one out from the figures it has.');
  });

  it('separates a scenario from a forecast and from a result, in one sentence (§16)', () => {
    expect(SCENARIO_DISCLAIMER).toContain('not results and not a forecast');
  });
});
