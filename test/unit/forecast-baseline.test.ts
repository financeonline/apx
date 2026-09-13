import { describe, expect, it } from 'vitest';
import {
  FORECAST_LEAVES, MIN_PERIODS, buildBaseline, composeForecast, findOneOffs, selectWindow,
  type ActualPoint, type HorizonPeriod,
} from '@/modules/forecast';
import { Decimal } from '@/core/money';

/**
 * The forecast engine (REQ-FC-01, REQ-FC-05; ADR-099).
 *
 * The properties that carry the product meaning are all refusals: refusing to forecast on too
 * little history, refusing to average across a gap, refusing to let a one-off become the baseline,
 * refusing to invent an opening bank balance, and refusing to call any of it anything but
 * `estimated`. A forecast that is merely plausible is worse than none, because a reader remembers
 * the number and not the caveat.
 *
 * Pure: no clock, no database, no randomness. Every case is the same on every run.
 */

const month = (n: number): string => `2026-${String(n).padStart(2, '0')}-01`;
const label = (n: number): string => `M${n} 2026`;

const actual = (n: number, value: string | null, over: Partial<ActualPoint> = {}): ActualPoint => ({
  periodId: `p${n}`,
  periodStart: month(n),
  periodLabel: label(n),
  value,
  isComplete: true,
  assurance: 'verified',
  warnings: [],
  ...over,
});

const horizon: HorizonPeriod[] = [
  { periodId: 'h1', periodStart: '2026-09-01', periodLabel: 'Sep 2026' },
  { periodId: 'h2', periodStart: '2026-10-01', periodLabel: 'Oct 2026' },
  { periodId: 'h3', periodStart: '2026-11-01', periodLabel: 'Nov 2026' },
];

const flat = (n: number, value: string): ActualPoint[] =>
  Array.from({ length: n }, (_, i) => actual(i + 1, value));

// -----------------------------------------------------------------------------------------------
// Sufficiency (§2)
// -----------------------------------------------------------------------------------------------

describe('MOTION refuses to forecast on too little history', () => {
  it('refuses with no history at all', () => {
    expect(selectWindow([])).toMatchObject({ ok: false, reason: 'no_history' });
  });

  it(`refuses with fewer than ${MIN_PERIODS} complete periods`, () => {
    expect(selectWindow(flat(MIN_PERIODS - 1, '1000')))
      .toMatchObject({ ok: false, reason: 'too_few_periods' });
  });

  it(`accepts exactly ${MIN_PERIODS}`, () => {
    expect(selectWindow(flat(MIN_PERIODS, '1000')).ok).toBe(true);
  });

  it('ignores incomplete periods entirely, rather than scaling them (ADR-030.4)', () => {
    const points = [...flat(3, '1000'), actual(4, '90', { isComplete: false })];
    const verdict = selectWindow(points);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.window.map((p) => p.periodId), 'the part-month is not in the window')
        .toEqual(['p1', 'p2', 'p3']);
    }
  });

  it('ignores periods whose value was not computable, and says so when none are left', () => {
    expect(selectWindow([actual(1, null), actual(2, null)]))
      .toMatchObject({ ok: false, reason: 'no_complete_periods' });
  });
});

describe('the window is the most recent CONSECUTIVE run', () => {
  it('stops at a gap rather than averaging across it', () => {
    // Jan–Mar, then nothing in April, then May–Jul. Only the recent run may be used.
    const points = [...flat(3, '1000'), actual(5, '2000'), actual(6, '2000'), actual(7, '2000')];
    const verdict = selectWindow(points);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.window.map((p) => p.periodId)).toEqual(['p5', 'p6', 'p7']);
  });

  it('refuses when the recent run is too short, even though enough periods exist overall', () => {
    const points = [...flat(4, '1000'), actual(7, '2000'), actual(8, '2000')];
    expect(selectWindow(points))
      .toMatchObject({ ok: false, reason: 'history_not_continuous', periodsFound: 2 });
  });

  it('caps the window at twelve months', () => {
    const verdict = selectWindow(flat(18, '1000'));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.window).toHaveLength(12);
      expect(verdict.window[11]!.periodId, 'and keeps the NEWEST twelve').toBe('p18');
    }
  });
});

// -----------------------------------------------------------------------------------------------
// One-offs (§6)
// -----------------------------------------------------------------------------------------------

describe('a one-off does not become the baseline (§6)', () => {
  const d = (n: string) => new Decimal(n);

  it('finds a single far-out month among steady ones', () => {
    const values = ['100', '105', '98', '102', '99', '5000'].map(d);
    expect([...findOneOffs(values)]).toEqual([5]);
  });

  it('finds nothing when every month is identical', () => {
    expect(findOneOffs(['100', '100', '100', '100', '100'].map(d)).size).toBe(0);
  });

  it('finds nothing in ordinary variation', () => {
    expect(findOneOffs(['100', '110', '95', '105', '98', '103'].map(d)).size).toBe(0);
  });

  it('never drops more than a quarter of the window', () => {
    const values = ['100', '100', '5000', '6000', '7000', '8000', '100', '100'].map(d);
    expect(findOneOffs(values).size).toBeLessThanOrEqual(2);
  });

  it('will not judge a window too short to have a middle', () => {
    expect(findOneOffs(['100', '9999', '100'].map(d)).size).toBe(0);
  });

  it('excludes the one-off from the average and records why', () => {
    const window = [
      actual(1, '1000'), actual(2, '1000'), actual(3, '1000'),
      actual(4, '1000'), actual(5, '1000'), actual(6, '50000'),
    ];
    const baseline = buildBaseline('operating_expenses', window);

    expect(baseline.periodsExcluded).toBe(1);
    expect(baseline.periodsUsed).toBe(5);
    expect(baseline.value, 'the exceptional month does not raise the running cost').toBe('1000.00');

    const dropped = baseline.points.find((p) => p.excluded);
    expect(dropped?.periodLabel).toBe(label(6));
    expect(dropped?.exclusionReason).toBe('one_off');
    expect(dropped?.weight).toBe(0);
  });
});

// -----------------------------------------------------------------------------------------------
// Weighting and determinism
// -----------------------------------------------------------------------------------------------

describe('the baseline leans on the recent months', () => {
  it('lands nearer the latest value than a plain mean would', () => {
    const window = [actual(1, '100'), actual(2, '100'), actual(3, '400')];
    // Plain mean would be 200. Weights 1,2,3 → (100 + 200 + 1200) / 6 = 250.
    expect(buildBaseline('revenue', window).value).toBe('250.00');
  });

  it('returns the level itself when the level has not moved', () => {
    expect(buildBaseline('revenue', flat(6, '1234.56')).value).toBe('1234.56');
  });

  it('is the same answer however the points arrive', () => {
    const points = [actual(1, '100'), actual(2, '250'), actual(3, '400'), actual(4, '175')];
    const forward = selectWindow(points);
    const shuffled = selectWindow([points[2]!, points[0]!, points[3]!, points[1]!]);
    expect(forward.ok && shuffled.ok).toBe(true);
    if (forward.ok && shuffled.ok) {
      expect(buildBaseline('revenue', shuffled.window).value)
        .toBe(buildBaseline('revenue', forward.window).value);
    }
  });
});

describe('how much to lean on it, in words rather than a number (§19)', () => {
  it('calls a full clean window strong', () => {
    expect(buildBaseline('revenue', flat(6, '1000')).basis).toBe('strong');
  });

  it('calls a short window limited', () => {
    expect(buildBaseline('revenue', flat(3, '1000')).basis).toBe('limited');
  });

  it('drops to limited when the history rested on estimated figures', () => {
    const window = flat(8, '1000').map((p, i) => (i === 0 ? { ...p, assurance: 'estimated' as const } : p));
    expect(buildBaseline('revenue', window).basis).toBe('limited');
  });

  it('carries the history’s own data-quality warnings forward', () => {
    const window = flat(6, '1000').map((p, i) => (i === 1 ? { ...p, warnings: ['basis_differs'] } : p));
    expect(buildBaseline('revenue', window).warnings).toContain('basis_differs');
  });
});

// -----------------------------------------------------------------------------------------------
// Composition (§7, §8)
// -----------------------------------------------------------------------------------------------

const history = (over: Partial<Record<string, ActualPoint[]>> = {}) => ({
  revenue: flat(6, '10000'),
  cost_of_sales: flat(6, '4000'),
  operating_expenses: flat(6, '3000'),
  cash_inflows: flat(6, '9000'),
  cash_outflows: flat(6, '7000'),
  receivables: flat(6, '5000'),
  payables: flat(6, '2000'),
  ...over,
});

describe('the forecast respects the engine’s own identities (§7)', () => {
  const result = composeForecast({ history: history(), horizon, lastActualClosingCash: '20000' });
  const at = (key: string, periodId: string) =>
    result.points.find((p) => p.metricKey === key && p.periodId === periodId);

  it('derives gross profit as revenue minus cost of sales', () => {
    expect(at('gross_profit', 'h1')?.value).toBe('6000.00');
    expect(at('gross_profit', 'h1')?.derivation).toBe('identity');
    expect(at('gross_profit', 'h1')?.from).toEqual(['revenue', 'cost_of_sales']);
  });

  it('derives operating profit as gross profit minus operating expenses', () => {
    expect(at('operating_profit', 'h1')?.value).toBe('3000.00');
    expect(at('operating_profit', 'h1')?.from).toEqual(['gross_profit', 'operating_expenses']);
  });

  it('never averages operating profit directly — it is always an identity', () => {
    for (const p of result.points.filter((x) => x.metricKey === 'operating_profit')) {
      expect(p.derivation).toBe('identity');
    }
  });

  it('reconciles: the forecast components add up to the forecast profit', () => {
    const revenue = new Decimal(at('revenue', 'h2')!.value);
    const gross = new Decimal(at('gross_profit', 'h2')!.value);
    const opex = new Decimal(at('operating_expenses', 'h2')!.value);
    expect(gross.minus(opex).toFixed(2)).toBe(at('operating_profit', 'h2')!.value);
    expect(revenue.greaterThan(gross), 'and cost of sales is really taken off').toBe(true);
  });
});

describe('the cash chain opens on a real balance and then on itself (§8)', () => {
  it('adds each month’s movement to the balance before it', () => {
    const result = composeForecast({ history: history(), horizon, lastActualClosingCash: '20000' });
    const closing = (id: string) =>
      result.points.find((p) => p.metricKey === 'closing_cash' && p.periodId === id)?.value;
    // Movement is 9000 − 7000 = 2000 a month.
    expect(closing('h1')).toBe('22000.00');
    expect(closing('h2')).toBe('24000.00');
    expect(closing('h3')).toBe('26000.00');
  });

  it('states no closing cash at all when there is no balance to start from', () => {
    const result = composeForecast({ history: history(), horizon, lastActualClosingCash: null });
    expect(result.points.some((p) => p.metricKey === 'closing_cash'),
      'inventing an opening balance is forbidden (§8)').toBe(false);
    expect(result.unavailable.map((u) => u.metricKey)).toContain('closing_cash');
    expect(result.points.some((p) => p.metricKey === 'net_cash_movement'),
      'but the movement is still forecastable, and is still said').toBe(true);
  });

  it('states no gross profit when the business has no cost of sales (CD-05)', () => {
    const result = composeForecast({
      history: history({ cost_of_sales: [] }), horizon, lastActualClosingCash: '20000',
    });
    expect(result.points.some((p) => p.metricKey === 'gross_profit')).toBe(false);
    expect(result.points.some((p) => p.metricKey === 'operating_profit'),
      'and so no operating profit either, rather than one that assumes all margin').toBe(false);
    expect(result.points.some((p) => p.metricKey === 'revenue'),
      'revenue is unaffected').toBe(true);
  });
});

describe('what the forecast will not say', () => {
  it('names every metric it refused, with a real reason', () => {
    const result = composeForecast({
      history: history({ receivables: flat(2, '100'), payables: [] }),
      horizon,
      lastActualClosingCash: '1000',
    });
    const reasons = Object.fromEntries(result.unavailable.map((u) => [u.metricKey, u.reason]));
    expect(reasons.receivables).toBe('too_few_periods');
    expect(reasons.payables).toBe('no_history');
    expect(result.points.some((p) => p.metricKey === 'receivables'),
      'and forecasts neither, rather than forecasting zero (§20)').toBe(false);
  });

  it('forecasts nothing at all for an organisation with no history', () => {
    const result = composeForecast({ history: {}, horizon, lastActualClosingCash: null });
    expect(result.points).toHaveLength(0);
    expect(result.basis).toBeNull();
    expect(result.unavailable.map((u) => u.metricKey).sort()).toEqual([...FORECAST_LEAVES].sort());
  });

  it('marks every figure estimated, however firm the history behind it (REQ-FC-05)', () => {
    const verified = history();
    const result = composeForecast({ history: verified, horizon, lastActualClosingCash: '20000' });
    expect(result.points.length).toBeGreaterThan(0);
    for (const p of result.points) expect(p.assurance, p.metricKey).toBe('estimated');
  });

  it('speaks only about the periods it was given, and invents no month', () => {
    const result = composeForecast({ history: history(), horizon, lastActualClosingCash: '1' });
    const ids = new Set(result.points.map((p) => p.periodId));
    expect([...ids].sort()).toEqual(['h1', 'h2', 'h3']);
  });

  it('is byte-identical on a second run over the same input', () => {
    const input = { history: history(), horizon, lastActualClosingCash: '20000' };
    expect(JSON.stringify(composeForecast(input))).toBe(JSON.stringify(composeForecast(input)));
  });
});
