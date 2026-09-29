import { describe, expect, it } from 'vitest';
import { quantitativeContent } from '@/modules/portfolio';

/**
 * The rule for the adviser's own words (ADR-116): prose is never the source of a quantity. The
 * cases below must be caught — every form the final audit (F-4) and the brief list — and honest
 * qualitative prose must not be, or the check becomes one that fails correct answers.
 */

const flagged = (text: string, names: string[] = []) => quantitativeContent(text, names).length > 0;

describe('quantitative prose is caught', () => {
  it.each([
    // numerals, in any script
    'Revenue fell 8%.', 'It has 12 open actions.', 'Revenue fell ２３％.', 'It has ٥ critical alerts.', 'It has ५ alerts.',
    'Runway is 1½ months.', 'It is item Ⅳ.', 'Costs rose 3x.',
    // Roman numerals
    'It has III critical alerts.', 'It has IV open actions.', 'It has XII alerts.',
    // number and cardinality words
    'Revenue fell by twenty per cent.', 'It has twenty-five alerts.', 'It has one critical alert.', 'It has a dozen overdue actions.',
    'It has a couple of critical alerts.', 'It has a single critical alert.', 'It has a pair of overdue actions.', 'Both clients need attention.',
    'It has a handful of alerts.', 'Hundreds of alerts stand.', 'It has zero alerts.',
    // ordinals used as counts
    'This is the third consecutive month.', 'It is the second time.',
    // fractions and multipliers
    'Runway is one and a half months.', 'Half of the clients need attention.', 'Three quarters are healthy.', 'Costs doubled.',
    'Costs were halved.', 'Revenue increased twofold.', 'Costs are twice as high.', 'Costs are three times higher.', 'Revenue fell by a third.',
    // proportions, points
    'Revenue fell by twenty percent.', 'Margin fell by a few percentage points.', 'The majority of clients are healthy.', 'Most of the clients are healthy.',
    // all / none
    'All clients are healthy.', 'Every client is healthy.', 'None of its actions are overdue.', 'It has no critical alerts.', 'Nothing is overdue.',
    'Neither client is at risk.',
    // magnitudes
    'Revenue fell sharply.', 'Costs rose significantly.', 'Cash is materially lower.',
    // periods
    'Revenue fell in August.', 'It improved in March.', 'Health is worse this month.', 'Revenue is down year to date.', 'It fell last quarter.',
    'It was better in Q3.', 'Revenue is down year on year.',
    // other scripts
    'Выручка упала.', 'الإيرادات انخفضت',
  ])('%s', (text) => {
    expect(flagged(text)).toBe(true);
  });
});

describe('qualitative prose is not', () => {
  it.each([
    'Alpha Ltd needs attention first.', 'Several actions are overdue.', 'Cash pressure is increasing.', 'Client Y requires attention.',
    'Some clients have no scored month yet, so their health is unknown.', 'Its health is at risk and falling.', 'Look at Alpha Ltd first.',
    'One of the clients needs a call.', 'The revenue alert is the one to act on.', 'No one owns the overdue work.',
    'Review the overdue work with the owner.', 'It may improve once the ledger is imported.', 'Financial figures are not in the data.',
    'Many of the alerts concern cash.', 'A few actions need an owner.',
  ])('%s', (text) => {
    expect(quantitativeContent(text)).toEqual([]);
  });

  it('a client\'s own name is set aside, even with a number in it', () => {
    expect(quantitativeContent('Studio 54 Ltd needs attention.', ['Studio 54 Ltd'])).toEqual([]);
    expect(quantitativeContent("Studio 54 Ltd's health is at risk.", ['Studio 54 Ltd'])).toEqual([]);
  });

  it('but a name is set aside only whole, and a name with no letter never', () => {
    expect(flagged('Studio 54 needs attention.', ['Studio 54 Ltd'])).toBe(true);
    expect(flagged('Revenue fell 3%.', ['3'])).toBe(true);
  });
});

describe('what it reports', () => {
  it('names each thing it found', () => {
    expect(quantitativeContent('It has a dozen alerts, up 3% in August.')).toEqual([
      "a numeral: '3'", "a percent sign: '%'", "a number word: 'dozen'", "a period: 'August'",
    ]);
  });
});
