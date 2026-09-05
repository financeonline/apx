/**
 * Recurring payment detection (FINANCIAL_ENGINE.md §4.3).
 *
 * Pure and order-independent: `detectRecurring` sorts every list it walks, so the same transactions
 * in any sequence produce the same groups with the same ids. That matters more here than almost
 * anywhere else in the engine, because groups are RECOMPUTED on every calculation run and upserted
 * on the unique key `(organization_id, bank_account_id, counterparty_key, direction)` — an unstable
 * key would create a new group each run and re-notify the customer about the same standing order
 * every day.
 *
 * `asOf` is an explicit input. §1.1 forbids a clock in `domain/`: "today" decides whether a series
 * is `stopped`, so reading it from the machine would make the same run produce different answers on
 * different days and break the replay guarantee (§6).
 */

import { Decimal, abs, cashDirection, divide, toMoneyString, toRatioString, type CashDirection } from '@/core/money';
import { descriptionSignature } from './categorisation';
import { daysBetween } from './transfers';

/**
 * The detector version enters the calculation run's input fingerprint (ADR-047.11).
 *
 * The fingerprint decides whether a run may finish as `succeeded (no_change)` without computing
 * anything. If the detector changed but the version did not, a run over identical records would be
 * judged unchanged and would keep serving groups the old detector produced. Bump this on ANY change
 * to the grouping, the cadence bands, the tolerance formula or the status rules.
 */
export const RECURRING_DETECTOR_VERSION = 'banking.recurring.v1';

/** §4.3 step 1: the signature is truncated to 40 characters. */
export const RECURRING_SIGNATURE_MAX_LENGTH = 40;

/** §4.3 step 2: the detection window. */
export const RECURRING_WINDOW_MONTHS = 18;

/** §4.3 step 2: fewer than this many occurrences is not a pattern, it is a coincidence. */
export const RECURRING_MIN_OCCURRENCES = 3;

/** §4.3 step 3: the share of gaps that must sit within ±20% of the median. */
export const RECURRING_GAP_CONSISTENCY = 0.7;
export const RECURRING_GAP_BAND = 0.2;

/** §4.3 step 4: the floor on `amount_tolerance_ratio`. */
export const RECURRING_MIN_TOLERANCE_RATIO = '0.10';

/** §4.3 step 5: how far past `next_expected` a series may drift before it is `stopped`. */
export const RECURRING_STOPPED_MULTIPLE = 1.5;

export type RecurringCadence =
  | 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annual' | 'irregular';

export type RecurringStatus = 'active' | 'changed' | 'stopped';

// ---------------------------------------------------------------------------------------------
// Signature (§4.3 step 1)
// ---------------------------------------------------------------------------------------------

/**
 * The signature: `description_normalized` reduced to the payee, truncated to 40 characters.
 *
 * The input is already masked of account numbers and sort codes (ADR-038.4); `descriptionSignature`
 * (§4.1) additionally removes digits, dates, reference codes and whitespace runs, which is exactly
 * the list §4.3 step 1 asks for — so the two stages share one implementation rather than drifting
 * into two slightly different ideas of what a payee is.
 */
export function recurringSignature(descriptionNormalized: string | null | undefined): string {
  return descriptionSignature(descriptionNormalized).slice(0, RECURRING_SIGNATURE_MAX_LENGTH);
}

/**
 * The `counterparty_key` column of the unique key.
 *
 * §4.3 step 1 says the signature is the description part "plus `counterparty_id` when set", so a
 * confirmed counterparty splits two payees whose descriptions happen to reduce to the same words,
 * and keeps the key stable when a bank starts writing the description differently.
 */
export function recurringCounterpartyKey(
  descriptionNormalized: string | null | undefined,
  counterpartyId: string | null,
): string {
  const signature = recurringSignature(descriptionNormalized);
  return counterpartyId === null ? signature : `${signature}|cp:${counterpartyId}`;
}

/**
 * The stable group key, so that upserts are idempotent (§4.3 step 6).
 *
 * Its four parts are exactly the columns of the unique index
 * `(organization_id, bank_account_id, counterparty_key, direction)`. Nothing derived from the run,
 * the dates or the amounts appears in it: those all change between runs, and the whole point is that
 * the id does not.
 */
export function recurringGroupKey(parts: {
  readonly organizationId: string;
  readonly bankAccountId: string;
  readonly counterpartyKey: string;
  readonly direction: CashDirection;
}): string {
  return [parts.organizationId, parts.bankAccountId, parts.counterpartyKey, parts.direction].join('|');
}

// ---------------------------------------------------------------------------------------------
// Cadence (§4.3 step 3)
// ---------------------------------------------------------------------------------------------

interface CadenceBand {
  readonly cadence: Exclude<RecurringCadence, 'irregular'>;
  readonly minDays: number;
  readonly maxDays: number;
  /** The canonical length used for `next_expected`; each sits inside its own band. */
  readonly days: number;
}

/** §4.3 step 3's bands, in ascending order. Disjoint by construction. */
export const CADENCE_BANDS: readonly CadenceBand[] = [
  { cadence: 'weekly', minDays: 6, maxDays: 8, days: 7 },
  { cadence: 'fortnightly', minDays: 13, maxDays: 15, days: 14 },
  { cadence: 'monthly', minDays: 27, maxDays: 32, days: 30 },
  { cadence: 'quarterly', minDays: 85, maxDays: 95, days: 91 },
  { cadence: 'annual', minDays: 355, maxDays: 375, days: 365 },
];

/** The canonical length of a cadence in days, or `null` for `irregular`. */
export function cadenceLengthDays(cadence: RecurringCadence): number | null {
  return CADENCE_BANDS.find((b) => b.cadence === cadence)?.days ?? null;
}

/** The median of a numeric list. Even counts take the mean of the two middle values. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface CadenceOutcome {
  readonly cadence: RecurringCadence;
  readonly medianGapDays: number | null;
  /** The share of gaps within ±20% of the median. `null` when there are no gaps. */
  readonly consistency: number | null;
}

/**
 * Classify a series' gaps (§4.3 step 3).
 *
 * Two independent ways to be `irregular`: a median outside every band (a payment every 45 days is
 * not monthly), or a median inside a band that most gaps miss. The second test is what stops three
 * unrelated payments at 5, 30 and 55 days from being called monthly on the strength of their middle
 * value alone.
 */
export function classifyCadence(gapsInDays: readonly number[]): CadenceOutcome {
  if (gapsInDays.length === 0) {
    return { cadence: 'irregular', medianGapDays: null, consistency: null };
  }
  const median = medianOf(gapsInDays);
  const band = CADENCE_BANDS.find((b) => median >= b.minDays && median <= b.maxDays);
  const within = gapsInDays.filter(
    (gap) => Math.abs(gap - median) <= median * RECURRING_GAP_BAND,
  ).length;
  const consistency = within / gapsInDays.length;
  if (band === undefined || consistency < RECURRING_GAP_CONSISTENCY) {
    return { cadence: 'irregular', medianGapDays: median, consistency };
  }
  return { cadence: band.cadence, medianGapDays: median, consistency };
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

/** Add whole days to an ISO date, in UTC. */
export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Subtract whole months from an ISO date, clamping the day to the target month's length.
 *
 * 31 August minus 18 months is 28 February, not 3 March: a window that silently slid forward would
 * include an occurrence in one run and drop it in the next.
 */
export function subtractMonths(date: string, months: number): string {
  const parsed = new Date(Date.parse(`${date}T00:00:00Z`));
  const year = parsed.getUTCFullYear();
  const month = parsed.getUTCMonth();
  const day = parsed.getUTCDate();
  const target = new Date(Date.UTC(year, month - months, 1));
  const daysInTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTargetMonth));
  return target.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/** A subset of `BankTransaction`. The caller passes ACCEPTED rows only (§1.3). */
export interface RecurringTransaction {
  readonly id: string;
  readonly bankAccountId: string;
  /** ISO `yyyy-mm-dd`. */
  readonly transactionDate: string;
  /** Signed: positive is an inflow. */
  readonly amount: string;
  readonly descriptionNormalized: string | null;
  readonly counterpartyId: string | null;
}

export interface RecurringDetectionInput {
  readonly organizationId: string;
  readonly transactions: readonly RecurringTransaction[];
  /** Today, in the organization's timezone, as an ISO date. Never a clock read (§1.1). */
  readonly asOf: string;
}

export interface RecurringGroup {
  /** Stable across runs; see `recurringGroupKey`. */
  readonly groupKey: string;
  readonly organizationId: string;
  readonly bankAccountId: string;
  readonly counterpartyKey: string;
  readonly direction: CashDirection;
  readonly signature: string;
  readonly counterpartyId: string | null;
  readonly cadence: RecurringCadence;
  /** The canonical cadence length in days, or `null` when irregular. */
  readonly cadenceDays: number | null;
  readonly medianGapDays: number | null;
  readonly occurrences: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** Median |amount|, 2 dp. `direction` carries the sign, as it does on the column. */
  readonly expectedAmount: string;
  readonly lastAmount: string;
  /** `max(0.10, MAD/median)`, 6 dp. */
  readonly amountToleranceRatio: string;
  readonly nextExpected: string | null;
  readonly status: RecurringStatus;
  readonly detectorVersion: string;
  /** Members, in (date, id) order, for `bank_transactions.recurring_group_id`. */
  readonly transactionIds: readonly string[];
}

/** Median of money magnitudes, exact. */
function medianDecimal(values: readonly Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : sorted[middle - 1]!.plus(sorted[middle]!).dividedBy(2);
}

/**
 * Detect recurring payment groups (§4.3).
 *
 * Zero-amount rows are skipped: `cashDirection` is `null` at exactly zero (§3.3 defines inflow and
 * outflow with strict inequalities), and a group has to be one or the other to be a group.
 */
export function detectRecurring(input: RecurringDetectionInput): RecurringGroup[] {
  const windowStart = subtractMonths(input.asOf, RECURRING_WINDOW_MONTHS);

  // Sorted once, up front: everything below inherits (date, id) order, which is what makes the
  // output independent of the order rows arrived in.
  const inWindow = [...input.transactions]
    .filter((t) => t.transactionDate >= windowStart && t.transactionDate <= input.asOf)
    .sort((a, b) =>
      a.transactionDate !== b.transactionDate
        ? a.transactionDate < b.transactionDate ? -1 : 1
        : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );

  const groups = new Map<string, RecurringTransaction[]>();
  for (const transaction of inWindow) {
    const direction = cashDirection(transaction.amount);
    if (direction === null) continue;
    const counterpartyKey = recurringCounterpartyKey(
      transaction.descriptionNormalized,
      transaction.counterpartyId,
    );
    if (counterpartyKey === '') continue; // Nothing to key on: no description, no counterparty.
    const key = recurringGroupKey({
      organizationId: input.organizationId,
      bankAccountId: transaction.bankAccountId,
      counterpartyKey,
      direction,
    });
    const members = groups.get(key);
    if (members) members.push(transaction);
    else groups.set(key, [transaction]);
  }

  const result: RecurringGroup[] = [];

  for (const [groupKey, members] of groups) {
    if (members.length < RECURRING_MIN_OCCURRENCES) continue;

    const first = members[0]!;
    const last = members[members.length - 1]!;
    const direction = cashDirection(first.amount)!;

    const gaps: number[] = [];
    for (let i = 1; i < members.length; i += 1) {
      gaps.push(daysBetween(members[i - 1]!.transactionDate, members[i]!.transactionDate));
    }
    const cadence = classifyCadence(gaps);
    const cadenceDays = cadenceLengthDays(cadence.cadence);

    // ---- Step 4: expected amount and tolerance ----
    const magnitudes = members.map((m) => abs(m.amount));
    const expected = medianDecimal(magnitudes);
    const deviations = magnitudes.map((m) => m.minus(expected).abs());
    const mad = medianDecimal(deviations);
    const madRatio = divide(mad, expected);
    const floor = new Decimal(RECURRING_MIN_TOLERANCE_RATIO);
    // A zero median makes MAD/median undefined, not infinite: the floor stands.
    const tolerance = madRatio === null || madRatio.lessThan(floor) ? floor : madRatio;

    // ---- Step 5: next expected and status ----
    const nextExpected = cadenceDays === null ? null : addDays(last.transactionDate, cadenceDays);
    const lastMagnitude = abs(last.amount);
    const drift = lastMagnitude.minus(expected).abs();
    // `expected` is a median of strictly positive magnitudes (zero-amount rows never reach here),
    // so it is never zero and the comparison never degenerates.
    const changed = drift.greaterThan(expected.times(tolerance));
    // `stopped` wins over `changed`: once a series has gone quiet, whether its final payment was a
    // little larger is not the thing the reader needs told.
    const stopped =
      nextExpected !== null &&
      input.asOf > addDays(nextExpected, Math.round(cadenceDays! * RECURRING_STOPPED_MULTIPLE));
    const status: RecurringStatus = stopped ? 'stopped' : changed ? 'changed' : 'active';

    result.push({
      groupKey,
      organizationId: input.organizationId,
      bankAccountId: first.bankAccountId,
      counterpartyKey: recurringCounterpartyKey(first.descriptionNormalized, first.counterpartyId),
      direction,
      signature: recurringSignature(first.descriptionNormalized),
      counterpartyId: first.counterpartyId,
      cadence: cadence.cadence,
      cadenceDays,
      medianGapDays: cadence.medianGapDays,
      occurrences: members.length,
      firstSeen: first.transactionDate,
      lastSeen: last.transactionDate,
      expectedAmount: toMoneyString(expected),
      lastAmount: toMoneyString(lastMagnitude),
      amountToleranceRatio: toRatioString(tolerance),
      nextExpected,
      status,
      detectorVersion: RECURRING_DETECTOR_VERSION,
      transactionIds: members.map((m) => m.id),
    });
  }

  // Sorted by the stable key so the output array itself is order-independent.
  result.sort((a, b) => (a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : 0));
  return result;
}
