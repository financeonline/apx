import { describe, expect, it } from 'vitest';
import { readQuantities, type ReadingContext } from '@/modules/portfolio';

/**
 * The adviser's quantity reader (ADR-115). Every way a magnitude can be written has to be SEEN —
 * audit M-1 was a figure written in words walking past a digit-only scan — and nothing that is not
 * a magnitude (a period, a reference, a quoted title, a client's name) may be read as one.
 */

const NONE: ReadingContext = { names: [], quoted: [], periodLabels: [] };
const read = (sentence: string, context: ReadingContext = NONE) => readQuantities(sentence, context);
const claims = (sentence: string, context: ReadingContext = NONE) =>
  read(sentence, context).quantities.map((q) => ({ value: q.value?.toString() ?? null, unit: q.unit, approximate: q.approximate }));
const one = (sentence: string, context: ReadingContext = NONE) => {
  const all = claims(sentence, context);
  expect(all).toHaveLength(1);
  return all[0]!;
};

describe('digits', () => {
  it.each([
    ['Alpha Ltd has 20 alerts.', '20', 'bare'],
    ['Runway is 1.5 months.', '1.5', 'months'],
    ['There are 2,500 alerts.', '2500', 'bare'],
    ['The change was -1,000.', '-1000', 'bare'],
    ['Health score fell 23 points.', '23', 'points'],
    ['Cash is £412,000.', '412000', 'money'],
    ['Cash is 8 pounds.', '8', 'money'],
  ])('%s', (sentence, value, unit) => {
    expect(one(sentence)).toMatchObject({ value, unit, approximate: false });
  });

  it('fullwidth digits are digits', () => {
    expect(one('Revenue fell ２３％.')).toMatchObject({ value: '23', unit: 'percent' });
  });
});

describe('percentages, in every spelling', () => {
  it.each([
    'Revenue fell 20%.', 'Revenue fell 20 percent.', 'Revenue fell 20 per cent.',
    'Revenue fell twenty percent.', 'Revenue fell by twenty per cent.', 'Revenue fell 20pc.', 'Revenue fell 20 pct.',
  ])('%s is 20 percent', (sentence) => {
    expect(one(sentence)).toMatchObject({ value: '20', unit: 'percent' });
  });

  it('twenty-five percent', () => {
    expect(one('Revenue declined twenty-five percent.')).toMatchObject({ value: '25', unit: 'percent' });
  });

  it('a percentage point is not a percent and not a point of a score', () => {
    expect(one('Margin fell 8pp.').unit).toBe('unknown');
    expect(one('Margin fell 8 percentage points.').unit).toBe('unknown');
  });
});

describe('number words', () => {
  it.each([
    ['There are one hundred alerts.', '100'],
    ['There are one thousand alerts.', '1000'],
    ['There are twenty-five alerts.', '25'],
    ['There are twenty alerts.', '20'],
    ['There are a hundred alerts.', '100'],
  ])('%s', (sentence, value) => {
    expect(one(sentence)).toMatchObject({ value, unit: 'bare' });
  });

  it('"one" in front of a unit or a counted noun is a claim', () => {
    expect(one('Runway is one month.')).toMatchObject({ value: '1', unit: 'months' });
    expect(one('Revenue fell by one percent.')).toMatchObject({ value: '1', unit: 'percent' });
    expect(one('Alpha Ltd has one critical alert.')).toMatchObject({ value: '1', unit: 'bare' });
  });

  it('"one" as ordinary English is not', () => {
    expect(claims('Alpha Ltd is one of the clients to watch.')).toEqual([]);
    expect(claims('No one has acted on it.')).toEqual([]);
  });

  it('"zero" and "no" in front of a counted noun are a count of 0', () => {
    expect(one('Beta Ltd has no critical alerts.')).toMatchObject({ value: '0', unit: 'bare' });
    expect(one('Beta Ltd has zero alerts.')).toMatchObject({ value: '0', unit: 'bare' });
  });
});

describe('fractions', () => {
  it.each([
    ['Runway is one and a half months.', '1.5', 'months'],
    ['Runway is two and three quarters months.', '2.75', 'months'],
    ['Runway is 1½ months.', '1.5', 'months'],
    ['Three quarters of the clients are healthy.', '0.75', 'proportion'],
    ['Half of the clients need attention.', '0.5', 'proportion'],
    ['One half of the clients need attention.', '0.5', 'proportion'],
  ])('%s', (sentence, value, unit) => {
    expect(one(sentence)).toMatchObject({ value, unit });
  });

  it('a third has no exact value', () => {
    expect(one('Revenue fell by a third.')).toMatchObject({ value: null, unit: 'proportion' });
    expect(one('Revenue fell by ⅓.').value).toBeNull();
  });
});

describe('multipliers', () => {
  it.each([
    ['Costs doubled.', '2'],
    ['Costs tripled.', '3'],
    ['Margin halved.', '0.5'],
    ['Costs increased twofold.', '2'],
    ['Costs increased 2-fold.', '2'],
    ['Costs decreased by half.', '0.5'],
    ['Costs were cut in half.', '0.5'],
    ['Costs increased by half.', '1.5'],
    ['Costs are twice as high.', '2'],
    ['Costs are three times as high.', '3'],
    ['Costs are 3x last year.', '3'],
  ])('%s', (sentence, value) => {
    expect(one(sentence)).toMatchObject({ value, unit: 'multiple' });
  });

  it('"three times higher" is read two ways, so it has no value', () => {
    expect(one('Costs are three times higher.')).toMatchObject({ value: null, unit: 'multiple' });
  });

  it('"double-check" is not a multiplier', () => {
    expect(claims('Double-check the alert.')).toEqual([]);
  });
});

describe('approximate figures and magnitudes with no figure', () => {
  it.each([
    'Revenue fell about 20%.', 'Revenue fell by roughly 20%.', 'Costs roughly doubled.', 'About half of the clients need attention.',
    'Runway is nearly one and a half months.', 'Revenue fell more than twenty percent.', 'Revenue fell 20% or more.', 'Over 3 alerts stand.',
  ])('%s is approximate', (sentence) => {
    expect(read(sentence).quantities.some((q) => q.approximate)).toBe(true);
  });

  it.each(['Revenue fell significantly.', 'Costs rose materially.', 'Revenue fell sharply.', 'Most of the clients are healthy.', 'Several alerts stand.'])(
    '%s states a magnitude no fact gives',
    (sentence) => {
      expect(read(sentence).unresolved.length).toBeGreaterThan(0);
    },
  );
});

describe('what is not a quantity', () => {
  it('periods, dates, quarters and references', () => {
    const r = read('Health score in Aug 2026 and August, Q3 2026, on 2026-09-01 and in 2025, per client:1 and alert:12.');
    expect(r.quantities).toEqual([]);
    expect(r.periods.map((p) => [p.month, p.year, p.quarter])).toEqual(expect.arrayContaining([[8, 2026, null], [8, null, null], [null, 2026, 3], [9, 2026, null], [null, 2025, null]]));
  });

  it('ordinals', () => {
    expect(claims('The 1st alert and the second action.')).toEqual([]);
  });

  it('a client name with a number in it', () => {
    expect(claims('Studio 54 Ltd has 2 alerts.', { ...NONE, names: ['Studio 54 Ltd'] })).toEqual([{ value: '2', unit: 'bare', approximate: false }]);
  });
});

describe('titles are text, never figures (audit L-2)', () => {
  const titled: ReadingContext = { names: [], quoted: ['Revenue issue 8', '3', 'Cash runway under two months'], periodLabels: [] };

  it('a quoted, cited title is taken out whole', () => {
    expect(claims('The alert “Cash runway under two months” stands.', titled)).toEqual([]);
    expect(claims('The alert "Revenue issue 8" stands.', titled)).toEqual([]);
  });

  it('an unquoted title is scanned like any other text', () => {
    expect(claims('Cash runway under two months is the alert that stands.', titled)).toHaveLength(1);
  });

  it('a title substring is never stripped out of a figure', () => {
    // The old grounder removed every occurrence of a cited title's text — "3" out of "3%".
    expect(one('Revenue fell 3% this quarter.', titled)).toMatchObject({ value: '3', unit: 'percent' });
  });

  it('a quoted title with a unit or a currency against it is a title used as a figure', () => {
    expect(read('Revenue fell “3”%.', titled).unresolved).toEqual(['the quoted title "3" is used as a figure']);
    expect(read('Cash is £"3".', titled).unresolved).toHaveLength(1);
  });

  it('a quoted string that is not a cited title is scanned', () => {
    expect(claims('The alert "Revenue fell 9%" stands.', titled)).toHaveLength(1);
  });

  it('a name used as a figure is refused the same way', () => {
    expect(read('Revenue fell 3%.', { ...NONE, names: ['3'] }).unresolved).toEqual(['the name "3" is used as a figure']);
  });
});

describe('clauses', () => {
  it('two claims joined by "while" are two clauses', () => {
    const r = read('Revenue fell 8% while runway is 3 months.');
    expect(r.quantities).toHaveLength(2);
    const clauseOf = (start: number) => r.clauses.findIndex((c) => start >= c.start && start < c.end);
    expect(clauseOf(r.quantities[0]!.start)).not.toBe(clauseOf(r.quantities[1]!.start));
  });

  it('"one and a half" is one figure, not two clauses', () => {
    const r = read('Runway is one and a half months.');
    expect(r.quantities).toHaveLength(1);
    expect(r.clauses).toHaveLength(1);
  });
});
