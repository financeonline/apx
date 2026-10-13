import { formatMoney, formatPercent, tryParseDecimal } from '@/core/money';

/**
 * The Marketing report's figures as text (ADR-170), shared by the page, the Word file and the PDF so
 * the three can never disagree about a number.
 *
 * Money goes through `core/money` (UX_ARCHITECTURE.md §11: the only number formatters), in whole
 * units with the organisation's currency symbol ("£1,633,422", "−£5,100"). The report's percentages
 * are PERCENT figures, not ratios — the contract writes a share as "35" and a margin as "42.6"
 * (`domain/types.ts`) — so they are divided by a hundred once, here, and then handed to
 * `formatPercent` like any other ratio: one decimal place, a true minus sign (§8.2). Shares that the
 * contract keeps whole ("35") are shown whole ("35%"), as the client's document shows them.
 *
 * A value the data does not have is "—", never "0": an absent figure and a zero are different facts.
 * A value that does not parse is shown as it came rather than thrown on — it is the model's text in
 * a report somebody is reading, and a crashed page would tell them less.
 *
 * Pure: no I/O, no clock.
 */

export const NOT_AVAILABLE = '—';

/** "£1,633,422" in the report's currency, whole units; "—" when there is no figure. */
export function formatReportMoney(value: string | null, currency: string): string {
  if (value === null || value.trim() === '') return NOT_AVAILABLE;
  if (tryParseDecimal(value) === null) return value;
  return formatMoney(value, { currency });
}

/** A percent figure ("57.4", "-21.3") as "57.4%" / "−21.3%"; "—" when there is none. */
export function formatReportPercent(value: string | null): string {
  if (value === null || value.trim() === '') return NOT_AVAILABLE;
  const parsed = tryParseDecimal(value.replace(/%$/, ''));
  if (parsed === null) return value;
  return formatPercent(parsed.div(100));
}

/** A share the contract keeps as a whole percent ("35") as "35%", without a forced decimal. */
export function formatShare(value: string): string {
  const parsed = tryParseDecimal(value.replace(/%$/, ''));
  if (parsed === null) return value;
  return `${parsed.toDecimalPlaces(1).toFixed()}%`;
}

/** A share as a CSS width ("35%") for the effort bar, clamped to 0–100; null when it is not a number. */
export function shareWidth(value: string): string | null {
  const parsed = tryParseDecimal(value.replace(/%$/, ''));
  if (parsed === null || parsed.isNegative()) return null;
  return `${parsed.greaterThan(100) ? '100' : parsed.toDecimalPlaces(1).toFixed()}%`;
}

/** "13 Oct 2026", in UTC so server, Word file and PDF agree (the product's date style, §8.2). */
export function formatReportDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** "13 Oct 2026, 14:05 UTC", for the provenance line. */
export function formatReportDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const formatted = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }).format(date);
  return `${formatted} UTC`;
}

/**
 * Removes a lead the model may already have written ("Strategic objective: …"), so the report does
 * not say it twice when the lead is added back in bold.
 */
export function withoutLead(text: string, lead: string): string {
  const trimmed = text.trim();
  const bare = lead.replace(/[:.]\s*$/, '');
  const pattern = new RegExp(`^${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:—–-]?\\s*`, 'i');
  return trimmed.replace(pattern, '');
}

/** "apx-marketing-acme-ltd-2026-10-13.docx": the slug kept to the characters a filename needs. */
export function marketingFilename(orgSlug: string, generatedAt: string, format: 'docx' | 'pdf'): string {
  const slug = orgSlug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'organisation';
  const day = /^\d{4}-\d{2}-\d{2}/.test(generatedAt) ? generatedAt.slice(0, 10) : 'undated';
  return `apx-marketing-${slug}-${day}.${format}`;
}
