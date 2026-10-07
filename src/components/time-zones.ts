/**
 * The time zones offered in a drop-down, each with its offset today ("GMT+4 · Asia/Dubai"). The
 * regions MOTION serves come first. Built on the server from the runtime's own list, so the value
 * saved is always an IANA name the database and the browser both understand.
 */
const FIRST = ['Europe/London', 'Asia/Dubai', 'Asia/Kolkata', 'Europe/Dublin'] as const;

export interface TimeZoneOption {
  readonly value: string;
  readonly label: string;
}

function offsetOf(zone: string, at: Date): string {
  const part = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? 'GMT';
}

export function timeZoneOptions(current: string, at: Date = new Date()): { first: TimeZoneOption[]; rest: TimeZoneOption[] } {
  const all = Intl.supportedValuesOf('timeZone');
  const known = new Set(all);
  const option = (zone: string): TimeZoneOption => ({ value: zone, label: `${offsetOf(zone, at)} · ${zone.replace(/_/g, ' ')}` });
  const first = FIRST.filter((z) => known.has(z)).map(option);
  const rest = all.filter((z) => !(FIRST as readonly string[]).includes(z)).map(option);
  // A saved zone the runtime does not list (an alias such as "UTC") is kept, never silently changed.
  if (current && !known.has(current) && !(FIRST as readonly string[]).includes(current)) rest.unshift({ value: current, label: current });
  return { first, rest };
}
