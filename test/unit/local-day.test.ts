import { describe, expect, it } from 'vitest';
import { addDays, isoWeekday, startOfLocalDay } from '@/core/periods';

/** Phase 17: report windows are organisation-local days (expected instants worked by hand). */
describe('startOfLocalDay', () => {
  it.each([
    // London in summer time is UTC+1, so its midnight is 23:00 the evening before.
    ['2026-09-08', 'Europe/London', '2026-09-07T23:00:00.000Z'],
    // The clocks go forward at 01:00 GMT on 29 March 2026; midnight is still GMT.
    ['2026-03-29', 'Europe/London', '2026-03-29T00:00:00.000Z'],
    // …and the day after, midnight is BST.
    ['2026-03-30', 'Europe/London', '2026-03-29T23:00:00.000Z'],
    // Los Angeles leaves DST at 02:00 on 1 November 2026; midnight is still PDT (UTC−7).
    ['2026-11-01', 'America/Los_Angeles', '2026-11-01T07:00:00.000Z'],
    ['2026-11-02', 'America/Los_Angeles', '2026-11-02T08:00:00.000Z'],
    ['2026-09-08', 'Asia/Kolkata', '2026-09-07T18:30:00.000Z'],
    ['2026-09-08', 'Pacific/Kiritimati', '2026-09-07T10:00:00.000Z'],
    ['2026-09-08', 'UTC', '2026-09-08T00:00:00.000Z'],
  ])('%s in %s begins at %s', (date, zone, expected) => {
    expect(startOfLocalDay(date, zone).toISOString()).toBe(expected);
  });

  it('refuses an unknown zone rather than falling back to UTC', () => {
    expect(() => startOfLocalDay('2026-09-08', 'Mars/Olympus')).toThrow(/timezone/);
  });
});

describe('date arithmetic', () => {
  it('crosses month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('names ISO weekdays, Monday first', () => {
    expect(isoWeekday('2026-09-07')).toBe(1); // a Monday
    expect(isoWeekday('2026-09-13')).toBe(7); // a Sunday
  });
});
