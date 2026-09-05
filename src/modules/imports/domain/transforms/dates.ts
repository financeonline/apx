/**
 * Date transforms (IMPORT_ENGINE.md §6.4 "Dates").
 *
 * The whole point of this file is the ambiguity rule. `03/04/2026` is 3 April in a UK export and
 * 4 March in a US one, and there is no way to tell from the value itself. Guessing would silently
 * move a transaction between two months — and every metric MOTION publishes is a calendar month —
 * so when a column gives no evidence the detector returns `order: null, choiceRequired: true` and
 * the mapping step must ask. It never defaults quietly, not even to the organization's country;
 * the country only decides which option is PRE-SELECTED.
 *
 * Pure: no clock, no locale, no `Date` arithmetic beyond `Date.UTC` for calendar validation.
 */

import type { DateOrder } from '../pipeline-types';

/** ISO `YYYY-MM-DD`, the shape every `date` column holds. */
export type IsoDate = string;

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * A two-digit year window. 69–99 are the 1900s, 00–68 the 2000s — the POSIX convention, and the one
 * Excel uses, so `14-03-26` reads as 2026 and a 1998 archive still reads as 1998.
 */
const TWO_DIGIT_YEAR_PIVOT = 68;

/** Trailing times ("2026-03-14 00:00:00", "14/03/2026T00:00:00Z") come from XLSX and CSV exports. */
const TRAILING_TIME = /[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:am|pm)?\s*(?:z|[+-]\d{2}:?\d{2})?$/iu;

function clean(cell: string): string {
  return cell
    .normalize('NFKC')
    .trim()
    .replace(TRAILING_TIME, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

/** A real calendar day, checked by round trip: `2026-02-30` matches every pattern and is not a date. */
function isoIfReal(year: number, month: number, day: number): IsoDate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function expandYear(year: number, digits: number): number {
  if (digits > 2) return year;
  return year <= TWO_DIGIT_YEAR_PIVOT ? 2000 + year : 1900 + year;
}

/**
 * Excel keeps dates as a day count from 1899-12-31, and carries a 1900 leap-year bug: serial 60 is
 * "29 February 1900", a day that never existed. Serials at or below 59 therefore sit one day off
 * from the modern epoch, and 60 itself is refused rather than turned into 1 March.
 */
export function fromExcelSerial(serial: number): IsoDate | null {
  if (!Number.isFinite(serial)) return null;
  const days = Math.floor(serial);
  if (days < 1 || days > 2_958_465) return null;
  if (days === 60) return null;
  const epoch = days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const utc = new Date(epoch + days * 86_400_000);
  return isoIfReal(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

/** What a single cell can be, before any column-level choice is made. */
type Shape =
  | { readonly kind: 'empty' }
  | { readonly kind: 'iso'; readonly iso: IsoDate }
  | { readonly kind: 'textual'; readonly iso: IsoDate }
  | { readonly kind: 'serial'; readonly iso: IsoDate }
  | { readonly kind: 'numeric'; readonly dayFirst: IsoDate | null; readonly monthFirst: IsoDate | null }
  | { readonly kind: 'unparseable' };

const ISO_SHAPE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u;
const NUMERIC_TRIPLE = /^(\d{1,2})([/\-.])(\d{1,2})\2(\d{2,4})$/u;
const DAY_MONTH_NAME = /^(\d{1,2})[\s\-/]([a-z]{3,9})\.?[\s\-/,]*(\d{2,4})$/iu;
const MONTH_NAME_DAY = /^([a-z]{3,9})\.?[\s\-/](\d{1,2})(?:st|nd|rd|th)?,?[\s\-/]*(\d{2,4})$/iu;
const SERIAL = /^\d{1,7}(?:\.\d+)?$/u;

/**
 * Serials below this would also read as a plain integer someone typed, so a column of small whole
 * numbers is not silently read as 1900s dates. 20000 is 1954-10-03; no real ledger predates it.
 */
const MIN_PLAUSIBLE_SERIAL = 20_000;

function classify(cell: string): Shape {
  const text = clean(cell);
  if (text === '') return { kind: 'empty' };

  const iso = ISO_SHAPE.exec(text);
  if (iso !== null) {
    const built = isoIfReal(
      Number.parseInt(iso[1] as string, 10),
      Number.parseInt(iso[2] as string, 10),
      Number.parseInt(iso[3] as string, 10),
    );
    return built === null ? { kind: 'unparseable' } : { kind: 'iso', iso: built };
  }

  const dayMonth = DAY_MONTH_NAME.exec(text);
  if (dayMonth !== null) {
    const month = MONTH_NAMES[(dayMonth[2] as string).toLowerCase()];
    if (month !== undefined) {
      const built = isoIfReal(
        expandYear(Number.parseInt(dayMonth[3] as string, 10), (dayMonth[3] as string).length),
        month,
        Number.parseInt(dayMonth[1] as string, 10),
      );
      return built === null ? { kind: 'unparseable' } : { kind: 'textual', iso: built };
    }
  }

  const monthDay = MONTH_NAME_DAY.exec(text);
  if (monthDay !== null) {
    const month = MONTH_NAMES[(monthDay[1] as string).toLowerCase()];
    if (month !== undefined) {
      const built = isoIfReal(
        expandYear(Number.parseInt(monthDay[3] as string, 10), (monthDay[3] as string).length),
        month,
        Number.parseInt(monthDay[2] as string, 10),
      );
      return built === null ? { kind: 'unparseable' } : { kind: 'textual', iso: built };
    }
  }

  const triple = NUMERIC_TRIPLE.exec(text);
  if (triple !== null) {
    const first = Number.parseInt(triple[1] as string, 10);
    const second = Number.parseInt(triple[3] as string, 10);
    const yearText = triple[4] as string;
    const year = expandYear(Number.parseInt(yearText, 10), yearText.length);
    return {
      kind: 'numeric',
      dayFirst: isoIfReal(year, second, first),
      monthFirst: isoIfReal(year, first, second),
    };
  }

  if (SERIAL.test(text)) {
    const serial = fromExcelSerial(Number.parseInt(text, 10));
    if (serial !== null) return { kind: 'serial', iso: serial };
  }

  return { kind: 'unparseable' };
}

/** Parse one cell under a chosen column order. `null` is `IMP-DATE-001` at row validation. */
export function parseDateValue(cell: string, order: DateOrder): IsoDate | null {
  const shape = classify(cell);
  switch (shape.kind) {
    case 'empty':
    case 'unparseable':
      return null;
    case 'iso':
    case 'textual':
      // Year-first and month-name values carry their own ordering; the column's choice cannot
      // change what they mean, so they parse under any order.
      return shape.iso;
    case 'serial':
      return order === 'excel_serial' ? shape.iso : null;
    case 'numeric':
      if (order === 'day_first') return shape.dayFirst;
      if (order === 'month_first') return shape.monthFirst;
      // An `iso` or `excel_serial` column that turns out to hold `14/03/2026` is a mixed column;
      // the row fails rather than being read under a guessed order.
      return null;
  }
}

/** `day_first` ↔ `month_first`; the other two orders have no alternative reading. */
export function alternateOrder(order: DateOrder): DateOrder | null {
  if (order === 'day_first') return 'month_first';
  if (order === 'month_first') return 'day_first';
  return null;
}

/** §6.4: the country default is what the choice is PRE-SET to, never what it silently becomes. */
export function defaultDateOrder(countryCode?: string): DateOrder {
  return (countryCode ?? 'GB').toUpperCase() === 'US' ? 'month_first' : 'day_first';
}

/**
 * Would this row be read differently under the other ordering? `IMP-DATE-003` (warning) at row
 * validation. `05/05/2026` reads the same both ways and is not flagged; `03/04/2026` is.
 */
export function readsDifferentlyUnderAlternate(cell: string, order: DateOrder): boolean {
  const other = alternateOrder(order);
  if (other === null) return false;
  const chosen = parseDateValue(cell, order);
  const alternative = parseDateValue(cell, other);
  return chosen !== null && alternative !== null && chosen !== alternative;
}

/** "31 rows would be read differently if month-first" (§6.4, and the §7 preview statistics). */
export function countRowsReadDifferently(
  cells: readonly (string | null | undefined)[],
  order: DateOrder,
): number {
  let count = 0;
  for (const cell of cells) {
    if (cell === null || cell === undefined) continue;
    if (readsDifferentlyUnderAlternate(cell, order)) count += 1;
  }
  return count;
}

export type DateDetectionReason =
  /** Every value carries its own ordering (year-first or a month name). */
  | 'iso'
  | 'excel_serial'
  /** At least one value has a day part above 12, which fixes the ordering for the whole column. */
  | 'disambiguated'
  /** Every value parses both ways: §6.4 requires an explicit choice. */
  | 'all_ambiguous'
  /** Some values force day-first and others month-first — the column is not one format. */
  | 'conflicting'
  | 'unreadable'
  | 'empty';

export interface DateColumnDetection {
  /** `null` when the reviewer must choose; never a guess. */
  readonly order: DateOrder | null;
  readonly choiceRequired: boolean;
  /** What the mapping step pre-selects: the detected order, else the organization's country. */
  readonly proposedOrder: DateOrder;
  readonly countryDefault: DateOrder;
  readonly reason: DateDetectionReason;
  readonly total: number;
  readonly parsed: number;
  /** Values that parse validly both ways. */
  readonly ambiguous: number;
  /** Values whose day part is above 12, which is what fixed the ordering. */
  readonly disambiguating: number;
  readonly unparsed: number;
  /** Up to five unreadable values, so the reviewer can see what went wrong. */
  readonly unparsedSamples: readonly string[];
  /** Rows that would change meaning under the other ordering, counted against `proposedOrder`. */
  readonly changedUnderAlternate: number;
}

export interface DateDetectionOptions {
  /** `organizations.country`; `GB` → day-first (§6.4). */
  readonly countryCode?: string;
}

/** Detect one column's date format (§6.4). */
export function detectDateColumn(
  cells: readonly (string | null | undefined)[],
  options: DateDetectionOptions = {},
): DateColumnDetection {
  const countryDefault = defaultDateOrder(options.countryCode);
  const present = cells.filter((cell): cell is string => cell !== null && cell !== undefined && clean(cell) !== '');

  let iso = 0;
  let textual = 0;
  let serial = 0;
  let ambiguous = 0;
  let forcedDayFirst = 0;
  let forcedMonthFirst = 0;
  let unparsed = 0;
  const unparsedSamples: string[] = [];

  for (const cell of present) {
    const shape = classify(cell);
    switch (shape.kind) {
      case 'iso': iso += 1; break;
      case 'textual': textual += 1; break;
      case 'serial': {
        // A small whole number is far more likely to be a quantity than a 1950s date.
        if (Number.parseInt(clean(cell), 10) >= MIN_PLAUSIBLE_SERIAL) serial += 1;
        else { unparsed += 1; if (unparsedSamples.length < 5) unparsedSamples.push(cell); }
        break;
      }
      case 'numeric': {
        if (shape.dayFirst !== null && shape.monthFirst !== null) ambiguous += 1;
        else if (shape.dayFirst !== null) forcedDayFirst += 1;
        else if (shape.monthFirst !== null) forcedMonthFirst += 1;
        else { unparsed += 1; if (unparsedSamples.length < 5) unparsedSamples.push(cell); }
        break;
      }
      default:
        unparsed += 1;
        if (unparsedSamples.length < 5) unparsedSamples.push(cell);
    }
  }

  const total = present.length;
  const numeric = ambiguous + forcedDayFirst + forcedMonthFirst;
  const parsed = iso + textual + serial + numeric;

  let order: DateOrder | null;
  let reason: DateDetectionReason;
  if (total === 0) {
    order = null;
    reason = 'empty';
  } else if (serial > 0 && serial === parsed) {
    order = 'excel_serial';
    reason = 'excel_serial';
  } else if (numeric === 0 && iso + textual > 0) {
    // No cell in the column can be read two ways, so there is nothing to choose.
    order = 'iso';
    reason = 'iso';
  } else if (forcedDayFirst > 0 && forcedMonthFirst > 0) {
    order = null;
    reason = 'conflicting';
  } else if (forcedDayFirst > 0) {
    order = 'day_first';
    reason = 'disambiguated';
  } else if (forcedMonthFirst > 0) {
    order = 'month_first';
    reason = 'disambiguated';
  } else if (ambiguous > 0) {
    // §6.4: "the mapping step REQUIRES an explicit choice, defaulting to the organization's
    // country". The default is the pre-selection, not the answer.
    order = null;
    reason = 'all_ambiguous';
  } else {
    order = null;
    reason = 'unreadable';
  }

  const proposedOrder = order ?? countryDefault;
  return {
    order,
    choiceRequired: order === null && reason !== 'empty',
    proposedOrder,
    countryDefault,
    reason,
    total,
    parsed,
    ambiguous,
    disambiguating: forcedDayFirst + forcedMonthFirst,
    unparsed,
    unparsedSamples,
    changedUnderAlternate: countRowsReadDifferently(present, proposedOrder),
  };
}
