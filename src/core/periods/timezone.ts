import { ValidationError } from '@/core/errors';
import type { Clock } from './clock';
import { yearMonthOf, type IsoDate, type YearMonth } from './months';

/**
 * "Today" for an organization (ADR-030.5: `period_to = min(latest period with accepted records,
 * current month **in the organization's timezone**)`).
 *
 * `organizations.timezone text NOT NULL DEFAULT 'Europe/London'` exists precisely so that the
 * server's own zone never decides which month an organization is in. At 23:00 UTC on 31 March a
 * London organization is still in March and an Auckland one is already in April; deriving either
 * from the server would give one of them the wrong current period.
 */

/**
 * Format an instant as the calendar date in `timeZone`.
 *
 * `formatToParts` with an explicit `timeZone` rather than any arithmetic on the `Date`: the runtime's
 * IANA database knows the offset for that instant, including whichever side of a DST change it
 * falls on.
 */
export function todayInTimeZone(clock: Clock, timeZone: string): IsoDate {
  const now = clock.now();
  if (Number.isNaN(now.getTime())) {
    throw new ValidationError('The clock returned an invalid instant.', [
      { path: 'clock', message: 'now() must return a valid Date.' },
    ]);
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    // An unknown zone must fail loudly. Falling back to UTC would put an organization in the wrong
    // month for part of every day, invisibly.
    throw new ValidationError('That timezone is not recognised.', [
      { path: 'timezone', message: timeZone },
    ]);
  }
  const find = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new ValidationError('That timezone is not recognised.', [
      { path: 'timezone', message: timeZone },
    ]);
    return part.value;
  };
  return `${find('year')}-${find('month')}-${find('day')}`;
}

/** The month an organization is currently in. The upper bound of ADR-030.5's `period_to`. */
export function currentYearMonth(clock: Clock, timeZone: string): YearMonth {
  return yearMonthOf(todayInTimeZone(clock, timeZone));
}

/** The calendar date `days` after `date` (negative for before). Pure date arithmetic, no zone. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number];
  const instant = new Date(Date.UTC(y, m - 1, d + days));
  return instant.toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: IsoDate): number {
  const [y, m, d] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The offset of `timeZone` from UTC at `instant`, in milliseconds (local − UTC). */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant a calendar day begins in `timeZone` (Phase 17: report windows are organisation-local
 * days, and timestamps are compared against them).
 *
 * The offset is read for the instant itself, twice, because the first guess can sit on the other
 * side of a DST change from the answer. Where local midnight does not exist (a zone whose clocks
 * jump forward AT midnight) the result is the first instant of that day that does.
 */
export function startOfLocalDay(date: IsoDate, timeZone: string): Date {
  const [y, m, d] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  try {
    const first = wall - offsetAt(new Date(wall), timeZone);
    const second = wall - offsetAt(new Date(first), timeZone);
    return new Date(second);
  } catch {
    throw new ValidationError('That timezone is not recognised.', [{ path: 'timezone', message: timeZone }]);
  }
}
