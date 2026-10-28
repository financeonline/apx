import 'server-only';

/**
 * Small pure helpers of the job area: the `job_type_enum` values and the organisation-local
 * calendar the SQL took from `now() at time zone o.timezone` and `pg_timezone_names`.
 */

/** `public.job_type_enum`. A value outside it failed the SQL call's type cast. */
export const JOB_TYPES: ReadonlySet<string> = new Set([
  'calculation.run', 'document.extract', 'import.commit_large', 'alerts.evaluate', 'org.purge',
  'report.render', 'ai.eval', 'storage.cleanup_orphans', 'snapshots.compact', 'report.compose',
  'funding.assess', 'marketing.generate', 'investment.generate',
]);

/** Whether the runtime knows a timezone name (the SQL's join to `pg_timezone_names`). */
export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `(at at time zone tz)::date` as `YYYY-MM-DD`. */
export function localDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

/** `date + n` for `YYYY-MM-DD`. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** `(x)::date` for the date strings the payloads carry: `YYYY-MM-DD` and a real calendar day, else null. */
export function parseDate(value: unknown): string | null | 'invalid' {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'invalid';
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return 'invalid';
  return s;
}

/** ISO day of week, Monday = 1 … Sunday = 7 (`extract(isodow from d)`). */
export function isoDow(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
