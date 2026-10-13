import { tryParseDecimal } from '@/core/money';
import { NOT_AVAILABLE, formatReportMoney, formatShare } from '@/modules/marketing';
import type { RiskLevel } from '../domain/types';

/**
 * The Investment Pack's figures and labels as text (ADR-171), on top of the Marketing report's
 * formatters (ADR-170), which this re-uses through the marketing barrel rather than restating:
 * `formatReportMoney` is money in the currency's symbol, whole units ("£2,073,600", "—" for no
 * figure), and `formatShare` a whole-percent string as "45%" (and a one-place margin, "15.0", as
 * "15%" — the client's document writes "Net profit at 15%"). What is here is only what the pack has
 * and the marketing report does not: the risk scale, a rounded "approximately" amount, the chart
 * axis, and the download's filename.
 *
 * Every figure stays a decimal string until it is shown (the product's no-floats-on-money rule,
 * ADR-006); a chart's plotted positions are the one place a figure becomes a `number`, through
 * `chartNumber`, and only to be placed on an axis — never to be added up or shown.
 *
 * Pure: no I/O, no clock.
 */

/** The six risk levels in the contract's order, from lower to very high (`RiskLevel`). */
export const RISK_LEVELS: readonly { readonly key: RiskLevel; readonly label: string; readonly short: string }[] = [
  { key: 'lower', label: 'Lower risk', short: 'Lower' },
  { key: 'low_medium', label: 'Low–medium risk', short: 'Low–medium' },
  { key: 'medium', label: 'Medium risk', short: 'Medium' },
  { key: 'higher', label: 'Higher risk', short: 'Higher' },
  { key: 'high', label: 'High risk', short: 'High' },
  { key: 'very_high', label: 'Very high risk', short: 'Very high' },
];

/** "Low–medium risk", as the client's "RISK PROFILE | Low–medium risk". */
export function riskLabel(risk: RiskLevel): string {
  return RISK_LEVELS.find((level) => level.key === risk)?.label ?? risk;
}

/** 0 for lower … 5 for very high; an unknown level sits in the middle rather than off the scale. */
export function riskIndex(risk: RiskLevel): number {
  const at = RISK_LEVELS.findIndex((level) => level.key === risk);
  return at < 0 ? 2 : at;
}

/** "45%" from "45", "15%" from "15.0", "14.6%" from "14.6"; the text as it came when not a number. */
export function percentText(value: string): string {
  return formatShare(value);
}

/** "20–50%" from the lowest and highest of the growth rates; "20%" when they are one rate. */
export function rangeText(values: readonly string[]): string {
  const parsed = values.map((v) => tryParseDecimal(v.replace(/%$/, ''))).filter((d) => d !== null);
  if (parsed.length === 0) return NOT_AVAILABLE;
  const low = parsed.reduce((a, b) => (b.lessThan(a) ? b : a));
  const high = parsed.reduce((a, b) => (b.greaterThan(a) ? b : a));
  const text = (d: typeof low) => d.toDecimalPlaces(1).toFixed();
  return low.equals(high) ? `${text(low)}%` : `${text(low)}–${text(high)}%`;
}

/**
 * "approximately £311,000": an amount to three significant figures, for a sentence that should not
 * read as more exact than an illustration is ("By Year 5 … rises to approximately £311,000").
 */
export function approximateMoney(value: string, currency: string): string {
  const parsed = tryParseDecimal(value);
  if (parsed === null) return formatReportMoney(value, currency);
  return formatReportMoney(parsed.toSignificantDigits(3).toFixed(0), currency);
}

/** The figure as a plain number, for a chart's axis only; null when there is none. */
export function chartNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = tryParseDecimal(value);
  return parsed === null ? null : parsed.toNumber();
}

/** "one" … "ten", for "Year 5 follows four annual growth periods"; digits beyond. */
export function countWord(n: number): string {
  const words = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  return words[n] ?? String(n);
}

export interface AxisTick {
  readonly value: number;
  /** "£2,000,000". */
  readonly label: string;
}

/**
 * A money axis from zero to a round figure above the highest value, in four or five steps of 1, 2,
 * 2.5 or 5 times a power of ten — zero always included, so a chart never flatters a small figure
 * (UX_ARCHITECTURE.md §5, as the trend charts).
 */
export function moneyAxis(highest: number, currency: string): { readonly max: number; readonly ticks: readonly AxisTick[] } {
  const top = Number.isFinite(highest) && highest > 0 ? highest : 1;
  const rough = top / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10) * magnitude;
  const steps = Math.max(1, Math.ceil(top / step - 1e-9));
  const ticks = Array.from({ length: steps + 1 }, (_, i) => {
    const value = step * i;
    return { value, label: formatReportMoney(value.toFixed(0), currency) };
  });
  return { max: step * steps, ticks };
}

/** "apx-investment-acme-ltd-2026-10-14.docx": the slug kept to the characters a filename needs. */
export function investmentFilename(orgSlug: string, generatedAt: string, format: 'docx' | 'pdf'): string {
  const slug = orgSlug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'organisation';
  const day = /^\d{4}-\d{2}-\d{2}/.test(generatedAt) ? generatedAt.slice(0, 10) : 'undated';
  return `apx-investment-${slug}-${day}.${format}`;
}
