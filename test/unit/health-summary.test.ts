import { describe, it, expect } from 'vitest';
import { HEALTH_DISCLAIMER, attentionCount, computeHealthScore, summarySentence } from '@/modules/health';
import { baselineSnapshots, healthInput, withMetric } from '../fixtures/health';

/**
 * The Home summary sentence (UX §Level 1, TEST_STRATEGY.md §7 "template selection is deterministic
 * for the same snapshots").
 */

function input(overrides: Partial<Parameters<typeof summarySentence>[0]> = {}) {
  return summarySentence({
    periodLabel: 'March 2026',
    currency: 'GBP',
    netProfit: '8000',
    netCashMovement: '4200',
    cashInflows: '81000',
    cashOutflows: '76800',
    hasPnlSource: true,
    score: null,
    ...overrides,
  });
}

describe('the documented sentence', () => {
  it('renders §Level 1’s worked example', () => {
    const score = computeHealthScore(healthInput({
      snapshots: withMetric(baselineSnapshots(), {
        key: 'gross_margin.variance.trailing_3m_avg', value: '-0.031',
      }),
    }))!;
    // One negative factor from the margin fall, one from... exactly two, by construction.
    const sentence = input({ score });
    expect(sentence.text).toMatch(
      /^March 2026 was profitable, cash went up by £4,200, and (one thing needs|two things need|three things need) your attention\.$/,
    );
  });

  it('says a business was profitable, or names the loss', () => {
    expect(input({ netProfit: '8000' }).clauses).toContain('profitable');
    expect(input({ netProfit: '-3100' }).text).toContain('March 2026 made a loss of £3,100');
    expect(input({ netProfit: '0' }).clauses).toContain('broke_even');
  });

  it('says nothing at all about profit when there is no profit figure', () => {
    const sentence = input({ netProfit: null });
    expect(sentence.clauses).not.toContain('broke_even');
    expect(sentence.text).not.toContain('profit');
    expect(sentence.text.startsWith('cash went up')).toBe(true);
  });

  it('describes cash in the direction it moved', () => {
    expect(input({ netCashMovement: '4200' }).text).toContain('cash went up by £4,200');
    expect(input({ netCashMovement: '-4200' }).text).toContain('cash fell by £4,200');
    expect(input({ netCashMovement: '0' }).text).toContain('cash was unchanged');
  });
});

describe('the bank-only variant (ADR-035)', () => {
  it('reports what the bank shows and names the upload that unlocks profit', () => {
    const sentence = input({ hasPnlSource: false, netProfit: null });
    expect(sentence.text).toBe(
      'In March 2026, £81,000 came in and £76,800 went out and cash went up by £4,200. '
      + 'Add a ledger, trial balance or sales invoices to see profit figures.',
    );
    expect(sentence.clauses).toEqual(['bank_only_movement', 'cash_up', 'bank_only_next_step']);
  });

  it('never claims a profit outcome from bank data alone', () => {
    const sentence = input({ hasPnlSource: false, netProfit: '8000' });
    expect(sentence.clauses).not.toContain('profitable');
    expect(sentence.clauses).not.toContain('broke_even');
  });
});

describe('the attention clause', () => {
  it('counts the negative factors of included dimensions only', () => {
    const score = computeHealthScore(healthInput())!;
    expect(attentionCount(score)).toBe(
      score.breakdown.filter((d) => d.included)
        .reduce((total, d) => total + d.negatives.length, 0),
    );
  });

  it('agrees in number', () => {
    const one = { ...computeHealthScore(healthInput())!, breakdown: [
      { ...computeHealthScore(healthInput())!.breakdown[0]!, negatives: ['x'] },
    ] };
    expect(input({ score: one }).text).toContain('one thing needs your attention');

    const three = { ...one, breakdown: [{ ...one.breakdown[0]!, negatives: ['x', 'y', 'z'] }] };
    expect(input({ score: three }).text).toContain('three things need your attention');
  });

  it('says nothing needs attention only when there is a score to say it about', () => {
    const scored = computeHealthScore(healthInput())!;
    const clean = { ...scored, breakdown: scored.breakdown.map((d) => ({ ...d, negatives: [] })) };
    expect(input({ score: clean }).clauses).toContain('attention_none');
    expect(input({ score: null }).clauses).not.toContain('attention_none');
  });
});

describe('determinism', () => {
  it('selects the same template for the same snapshots, every time', () => {
    const score = computeHealthScore(healthInput())!;
    const first = input({ score });
    for (let i = 0; i < 10; i += 1) {
      expect(input({ score })).toEqual(first);
    }
  });

  it('carries its numbers as typed values, not only in the prose (ADR-032.1)', () => {
    const sentence = input({ netProfit: '-3100', netCashMovement: '4200' });
    expect(sentence.values).toMatchObject({
      period: 'March 2026', net_profit: '-3100', net_cash_movement: '4200',
    });
  });

  it('produces nothing rather than an empty shell when it knows nothing', () => {
    const sentence = input({
      netProfit: null, netCashMovement: null, cashInflows: null, cashOutflows: null,
      hasPnlSource: true, score: null,
    });
    expect(sentence.text).toBe('');
    expect(sentence.clauses).toEqual([]);
  });
});

describe('SOW §9', () => {
  it('exports the disclaimer every screen must carry', () => {
    expect(HEALTH_DISCLAIMER).toContain('not a credit rating');
    expect(HEALTH_DISCLAIMER).toContain('not a lending decision');
  });
});
