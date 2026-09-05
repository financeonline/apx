import { describe, expect, it } from 'vitest';

import {
  CADENCE_BANDS,
  RECURRING_DETECTOR_VERSION,
  RECURRING_MIN_OCCURRENCES,
  RECURRING_SIGNATURE_MAX_LENGTH,
  RECURRING_WINDOW_MONTHS,
  addDays,
  cadenceLengthDays,
  classifyCadence,
  detectRecurring,
  recurringCounterpartyKey,
  recurringGroupKey,
  recurringSignature,
  subtractMonths,
  type RecurringTransaction,
} from '@/modules/banking';

/**
 * Recurring payment detection (FINANCIAL_ENGINE.md §4.3).
 *
 * Groups are recomputed on EVERY calculation run and upserted on
 * `(organization_id, bank_account_id, counterparty_key, direction)`. So the two things that must be
 * true are: the key does not move when the data around it does, and `asOf` — never a clock — decides
 * whether a series has stopped.
 */

const ORG = 'org-1';
const ACCOUNT = 'acc-current';

function series(
  dates: readonly string[],
  amount = '-410.00',
  description = 'DD NEST PENSIONS REF 4471',
): RecurringTransaction[] {
  return dates.map((transactionDate, index) => ({
    id: `t-${index}`,
    bankAccountId: ACCOUNT,
    transactionDate,
    amount,
    descriptionNormalized: description,
    counterpartyId: null,
  }));
}

function detect(transactions: readonly RecurringTransaction[], asOf: string) {
  return detectRecurring({ organizationId: ORG, transactions, asOf });
}

describe('the detector is versioned (§4.3 step 6, ADR-047.11)', () => {
  it('exports a version, because it enters the run fingerprint', () => {
    // A run whose fingerprint is unchanged finishes as `succeeded (no_change)` without computing.
    // If the detector changed but the version did not, that run would keep serving old groups.
    expect(RECURRING_DETECTOR_VERSION).toBe('banking.recurring.v1');
  });

  it('stamps the version on every group it produces', () => {
    const groups = detect(series(['2026-01-05', '2026-02-05', '2026-03-05']), '2026-03-10');
    expect(groups[0]!.detectorVersion).toBe(RECURRING_DETECTOR_VERSION);
  });
});

describe('the signature (§4.3 step 1)', () => {
  it('strips digits, dates and reference codes', () => {
    expect(recurringSignature('DD ACME LTD REF 4471 12MAR'))
      .toBe(recurringSignature('DD ACME LTD REF 5522 12APR'));
  });

  it('truncates to 40 characters', () => {
    const long = recurringSignature('a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(long.length).toBe(RECURRING_SIGNATURE_MAX_LENGTH);
  });

  it('adds the counterparty when one is set, so two payees never collide', () => {
    expect(recurringCounterpartyKey('ACME', 'cp-1')).not.toBe(recurringCounterpartyKey('ACME', 'cp-2'));
    expect(recurringCounterpartyKey('ACME', null)).toBe('acme');
  });
});

describe('the group key is stable, so upserts are idempotent (§4.3 step 6)', () => {
  it('is built only from the four columns of the unique key', () => {
    expect(recurringGroupKey({
      organizationId: ORG, bankAccountId: ACCOUNT, counterpartyKey: 'acme', direction: 'outflow',
    })).toBe('org-1|acc-current|acme|outflow');
  });

  it('does not move when new occurrences arrive', () => {
    const first = detect(series(['2026-01-05', '2026-02-05', '2026-03-05']), '2026-03-10');
    const second = detect(series(['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05']), '2026-04-10');
    expect(second[0]!.groupKey).toBe(first[0]!.groupKey);
  });

  it('does not move when the bank rewrites the reference on every line', () => {
    const rows = series(['2026-01-05', '2026-02-05', '2026-03-05']).map((t, i) => ({
      ...t,
      descriptionNormalized: `DD NEST PENSIONS REF ${1000 + i}`,
    }));
    const groups = detect(rows, '2026-03-10');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.occurrences).toBe(3);
  });

  it('splits an inflow series from an outflow series on the same payee', () => {
    const rows = [
      ...series(['2026-01-05', '2026-02-05', '2026-03-05'], '-100.00'),
      ...series(['2026-01-06', '2026-02-06', '2026-03-06'], '100.00').map((t) => ({ ...t, id: `in-${t.id}` })),
    ];
    const groups = detect(rows, '2026-03-10');
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.direction).sort()).toEqual(['inflow', 'outflow']);
  });

  it('splits the same payee on two bank accounts', () => {
    const rows = [
      ...series(['2026-01-05', '2026-02-05', '2026-03-05']),
      ...series(['2026-01-05', '2026-02-05', '2026-03-05']).map((t) => ({
        ...t, id: `b-${t.id}`, bankAccountId: 'acc-other',
      })),
    ];
    expect(detect(rows, '2026-03-10')).toHaveLength(2);
  });
});

describe('the ≥3 occurrence threshold (§4.3 step 2)', () => {
  it('qualifies at exactly three', () => {
    const groups = detect(series(['2026-01-05', '2026-02-05', '2026-03-05']), '2026-03-10');
    expect(RECURRING_MIN_OCCURRENCES).toBe(3);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.occurrences).toBe(3);
  });

  it('does not qualify at two', () => {
    expect(detect(series(['2026-02-05', '2026-03-05']), '2026-03-10')).toHaveLength(0);
  });

  it('counts only occurrences inside the trailing 18 months', () => {
    expect(RECURRING_WINDOW_MONTHS).toBe(18);
    // Two inside the window, one nearly three years old: two is not a pattern.
    const groups = detect(series(['2023-05-05', '2026-02-05', '2026-03-05']), '2026-03-10');
    expect(groups).toHaveLength(0);
  });

  it('ignores a row with neither a description nor a counterparty — nothing to key on', () => {
    const rows = series(['2026-01-05', '2026-02-05', '2026-03-05']).map((t) => ({
      ...t, descriptionNormalized: '12345', counterpartyId: null,
    }));
    expect(detect(rows, '2026-03-10')).toHaveLength(0);
  });

  it('ignores zero-amount rows, which are neither inflow nor outflow (§3.3)', () => {
    const rows = series(['2026-01-05', '2026-02-05', '2026-03-05'], '0.00');
    expect(detect(rows, '2026-03-10')).toHaveLength(0);
  });
});

describe('cadence from the median gap (§4.3 step 3)', () => {
  it('classifies a monthly series with 28 and 31 day gaps', () => {
    // Jan 5 → Feb 2 is 28 days; Feb 2 → Mar 5 is 31. Both inside the 27–32 band.
    const groups = detect(series(['2026-01-05', '2026-02-02', '2026-03-05']), '2026-03-10');
    expect(groups[0]!.cadence).toBe('monthly');
    expect(groups[0]!.medianGapDays).toBe(29.5);
  });

  it('classifies calendar-monthly dates as monthly', () => {
    const groups = detect(series(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']), '2026-04-20');
    expect(groups[0]!.cadence).toBe('monthly');
  });

  it('classifies weekly, fortnightly and quarterly series', () => {
    expect(detect(series(['2026-03-02', '2026-03-09', '2026-03-16']), '2026-03-20')[0]!.cadence).toBe('weekly');
    expect(detect(series(['2026-02-02', '2026-02-16', '2026-03-02']), '2026-03-05')[0]!.cadence).toBe('fortnightly');
    expect(detect(series(['2025-06-01', '2025-09-01', '2025-12-01']), '2025-12-10')[0]!.cadence).toBe('quarterly');
  });

  /**
   * DOCUMENT CONTRADICTION, pinned rather than worked around.
   *
   * §4.3 step 2 needs ≥3 occurrences INSIDE the trailing 18 months, and step 3 offers an `annual`
   * band of 355–375 days. Three annual occurrences span at least ~24 months, so no real annual
   * series can ever satisfy both: `detectRecurring` can never return `annual`. The band is
   * implemented and tested at the classifier, which is where it would start working the moment the
   * window rule changes; nothing here quietly widens the window to make it reachable.
   */
  it('has an annual band that the 18-month window makes unreachable end to end', () => {
    expect(classifyCadence([365, 366]).cadence).toBe('annual');
    expect(detect(series(['2023-01-01', '2024-01-01', '2025-01-01']), '2025-01-10')).toHaveLength(0);
  });

  it('calls a wildly irregular series irregular', () => {
    // Gaps of 5, 61 and 12 days. No band, and no consistency either.
    const groups = detect(series(['2026-01-01', '2026-01-06', '2026-03-08', '2026-03-20']), '2026-03-25');
    expect(groups[0]!.cadence).toBe('irregular');
    expect(groups[0]!.cadenceDays).toBeNull();
    expect(groups[0]!.nextExpected).toBeNull();
  });

  it('calls a series irregular when the median lands in a band that most gaps miss', () => {
    // Gaps 5, 30, 55: the median is 30 (monthly band) but only one gap is within ±20% of it.
    const outcome = classifyCadence([5, 30, 55]);
    expect(outcome.medianGapDays).toBe(30);
    expect(outcome.cadence).toBe('irregular');
    expect(outcome.consistency).toBeCloseTo(1 / 3, 10);
  });

  it('requires 70% of gaps within ±20% of the median', () => {
    expect(classifyCadence([30, 30, 30, 90]).cadence).toBe('monthly');   // 75% within
    expect(classifyCadence([30, 30, 90, 90]).cadence).toBe('irregular'); // 50% within
  });

  it('has disjoint, ascending bands with a canonical length inside each', () => {
    for (const band of CADENCE_BANDS) {
      expect(band.days).toBeGreaterThanOrEqual(band.minDays);
      expect(band.days).toBeLessThanOrEqual(band.maxDays);
      expect(cadenceLengthDays(band.cadence)).toBe(band.days);
    }
    expect(cadenceLengthDays('irregular')).toBeNull();
  });

  it('reports no cadence for a series with no gaps at all', () => {
    expect(classifyCadence([])).toEqual({ cadence: 'irregular', medianGapDays: null, consistency: null });
  });
});

describe('expected amount and tolerance (§4.3 step 4)', () => {
  it('takes the median amount as a positive magnitude, with direction carrying the sign', () => {
    const rows = series(['2026-01-05', '2026-02-05', '2026-03-05']).map((t, i) => ({
      ...t, amount: ['-400.00', '-410.00', '-420.00'][i]!,
    }));
    const group = detect(rows, '2026-03-10')[0]!;
    expect(group.expectedAmount).toBe('410.00');
    expect(group.direction).toBe('outflow');
  });

  it('floors the tolerance at 10%, so a perfectly steady series still has room', () => {
    const group = detect(series(['2026-01-05', '2026-02-05', '2026-03-05']), '2026-03-10')[0]!;
    expect(group.amountToleranceRatio).toBe('0.100000');
  });

  it('widens the tolerance to MAD/median when the series is genuinely variable', () => {
    // 100, 200, 300 → median 200, deviations 100/0/100 → MAD 100 → ratio 0.5.
    const rows = series(['2026-01-05', '2026-02-05', '2026-03-05']).map((t, i) => ({
      ...t, amount: ['-100.00', '-200.00', '-300.00'][i]!,
    }));
    expect(detect(rows, '2026-03-10')[0]!.amountToleranceRatio).toBe('0.500000');
  });
});

describe('next expected and status (§4.3 step 5)', () => {
  it('projects next_expected as last_seen + cadence', () => {
    const group = detect(series(['2026-01-05', '2026-02-05', '2026-03-05']), '2026-03-10')[0]!;
    expect(group.lastSeen).toBe('2026-03-05');
    expect(group.nextExpected).toBe(addDays('2026-03-05', 30));
  });

  it('is active while the next payment is still due', () => {
    expect(detect(series(['2026-01-05', '2026-02-05', '2026-03-05']), '2026-03-10')[0]!.status).toBe('active');
  });

  it('is still active just before asOf passes next_expected + 1.5 × cadence', () => {
    // next_expected 2026-04-04; + 45 days = 2026-05-19. asOf on the boundary is not "past" it.
    expect(detect(series(['2026-01-05', '2026-02-05', '2026-03-05']), '2026-05-19')[0]!.status).toBe('active');
  });

  it('is stopped once asOf passes next_expected + 1.5 × cadence', () => {
    expect(detect(series(['2026-01-05', '2026-02-05', '2026-03-05']), '2026-05-20')[0]!.status).toBe('stopped');
  });

  it('takes "stopped" from asOf alone, never from a clock', () => {
    const rows = series(['2026-01-05', '2026-02-05', '2026-03-05']);
    expect(detect(rows, '2026-03-10')[0]!.status).toBe('active');
    expect(detect(rows, '2026-08-01')[0]!.status).toBe('stopped');
  });

  it('is changed when the last amount deviates beyond tolerance', () => {
    // Steady at 400 then 800: tolerance is the 10% floor, so 800 is far outside it.
    const rows = series(['2026-01-05', '2026-02-05', '2026-03-05']).map((t, i) => ({
      ...t, amount: ['-400.00', '-400.00', '-800.00'][i]!,
    }));
    const group = detect(rows, '2026-03-10')[0]!;
    expect(group.status).toBe('changed');
    expect(group.lastAmount).toBe('800.00');
    expect(group.expectedAmount).toBe('400.00');
  });

  it('is NOT changed by a movement inside the tolerance', () => {
    const rows = series(['2026-01-05', '2026-02-05', '2026-03-05']).map((t, i) => ({
      ...t, amount: ['-400.00', '-400.00', '-420.00'][i]!,
    }));
    expect(detect(rows, '2026-03-10')[0]!.status).toBe('active');
  });

  it('prefers stopped over changed, because a quiet series is the bigger news', () => {
    const rows = series(['2026-01-05', '2026-02-05', '2026-03-05']).map((t, i) => ({
      ...t, amount: ['-400.00', '-400.00', '-800.00'][i]!,
    }));
    expect(detect(rows, '2026-08-01')[0]!.status).toBe('stopped');
  });

  it('never marks an irregular series stopped, because it has no next_expected', () => {
    // Nine months of silence would stop a monthly series many times over; an irregular one has no
    // expectation to miss, so calling it "stopped" would assert something never established.
    const groups = detect(series(['2026-01-01', '2026-01-06', '2026-03-08', '2026-03-20']), '2026-12-01');
    expect(groups[0]!.cadence).toBe('irregular');
    expect(groups[0]!.nextExpected).toBeNull();
    expect(groups[0]!.status).not.toBe('stopped');
  });
});

describe('date arithmetic is UTC and clamps, so a window never slides', () => {
  it('adds whole days', () => {
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
  });

  it('clamps the day when the target month is shorter', () => {
    expect(subtractMonths('2026-08-31', 18)).toBe('2025-02-28');
    expect(subtractMonths('2026-03-31', 1)).toBe('2026-02-28');
  });

  it('subtracts across a year boundary', () => {
    expect(subtractMonths('2026-03-10', 18)).toBe('2024-09-10');
  });
});

describe('determinism: shuffling the input changes nothing', () => {
  const rows: RecurringTransaction[] = [
    ...series(['2026-01-05', '2026-02-05', '2026-03-05'], '-410.00', 'DD NEST PENSIONS'),
    ...series(['2026-01-12', '2026-02-12', '2026-03-12'], '-1500.00', 'RENT UNIT 4')
      .map((t) => ({ ...t, id: `r-${t.id}` })),
    ...series(['2026-01-20', '2026-02-20', '2026-03-20'], '2400.00', 'STRIPE PAYOUT')
      .map((t) => ({ ...t, id: `s-${t.id}` })),
    // A pair that never becomes a group, to prove the threshold is order-independent too.
    ...series(['2026-02-01', '2026-03-01'], '-99.00', 'ADOBE').map((t) => ({ ...t, id: `a-${t.id}` })),
  ];

  function rotate<T>(items: readonly T[], by: number): T[] {
    return [...items.slice(by), ...items.slice(0, by)];
  }

  it('produces identical groups under every rotation and under reversal', () => {
    const expected = detect(rows, '2026-03-25');
    expect(expected).toHaveLength(3);
    for (let by = 0; by < rows.length; by += 1) {
      expect(detect(rotate(rows, by), '2026-03-25')).toEqual(expected);
    }
    expect(detect([...rows].reverse(), '2026-03-25')).toEqual(expected);
  });

  it('returns groups in stable group-key order', () => {
    const groups = detect(rows, '2026-03-25');
    expect(groups.map((g) => g.groupKey)).toEqual([...groups].map((g) => g.groupKey).sort());
  });

  it('lists member transactions in date order regardless of input order', () => {
    const forwards = detect(rows, '2026-03-25');
    const backwards = detect([...rows].reverse(), '2026-03-25');
    expect(backwards[0]!.transactionIds).toEqual(forwards[0]!.transactionIds);
    expect(forwards[0]!.firstSeen < forwards[0]!.lastSeen).toBe(true);
  });
});
