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
