import { Decimal } from '@/core/money';

/**
 * The claim grammar (AI_ARCHITECTURE.md §7.9, R2-C-05) — Spike S3's subject.
 *
 * The spike asks whether ADR-010's numeric grounding is "implementable without false positives on
 * formatted numbers". This module is the answer, and the risk lives in both directions:
 *
 *   * a FALSE POSITIVE — treating "Q1 2026", "INV-1042", "3 April 2026" or a customer called
 *     "Beta 12% Ltd" as a numeric claim — makes every honest answer degrade, and a grounding check
 *     that fires on correct answers is one that gets switched off;
 *   * a FALSE NEGATIVE — missing "£12.9k" or "two hundred" — lets a fabricated figure through,
 *     which is the entire thing being defended against.
 *
 * §7.9 fixes the order of operations for exactly this reason, and it is followed literally: period
 * labels and dates are located and removed, then entity names (longest first), then references —
 * and only what SURVIVES is scanned for numbers. Removal blanks the span rather than deleting it,
 * so every offset still points where it did: §7.4 and §7.5 measure "within six tokens", and a
 * grammar that shifted the text underneath them would quietly move the answer.
 *
 * Pure and deterministic: the same statement and the same context always give the same claims.
 */

export type ClaimKind = 'currency' | 'plain' | 'percentage' | 'points' | 'word';
export type Abbreviation = 'k' | 'm' | 'bn';

export interface Claim {
  /** The span exactly as written, for the mismatch message a human reads. */
  readonly text: string;
  readonly kind: ClaimKind;
  /** Fully scaled: "£12.9k" is 12900, "8.3%" is 8.3 (compared against ratio × 100, §7.9). */
  readonly value: Decimal;
  /** Decimals AS WRITTEN, which set the tolerance for an abbreviated form (§7.3). */
  readonly writtenDecimals: number;
  readonly abbreviation: Abbreviation | null;
  /** Character offsets into the normalised statement, for the proximity rules (§7.4, §7.5). */
  readonly start: number;
  readonly end: number;
}

export interface ClaimContext {
  /** Canonical period labels of this turn (`period_context ∪ meta.periods`). */
  readonly periodLabels: readonly string[];
  /** Every `name` a tool returned this turn. */
  readonly entityNames: readonly string[];
  /** Every `invoice_number`, `reference` and `source_ref` a tool returned this turn. */
  readonly references: readonly string[];
}

export interface ExtractionResult {
  readonly claims: readonly Claim[];
  /** The statement with exempt spans blanked, offsets preserved — what §7.4/§7.5 measure over. */
  readonly residue: string;
  /** Period-label spans found, so §7.4 can check every one against `Statement.period`. */
  readonly periodSpans: readonly { readonly label: string; readonly start: number }[];
  /** Entity-name spans found, so §7.5 can bind the nearest one to a number. */
  readonly entitySpans: readonly { readonly name: string; readonly start: number }[];
}

// -----------------------------------------------------------------------------------------------
// Normalisation (§7.9 header)
// -----------------------------------------------------------------------------------------------

/**
 * NFKC, thin and no-break spaces to a space, minus-sign and en-dash to a hyphen.
 *
 * Every one of these is a way the same number arrives looking different: a model that writes a
 * Unicode minus, or a description pasted from a spreadsheet carrying a no-break space inside a
 * thousands group, must not read as a different figure from the one a person typed.
 *
 * Length-preserving by construction — each replacement is one character for one character — so the
 * offsets this module reports are offsets into the string the caller passed.
 */
export function normalise(text: string): string {
  return text
    .normalize('NFKC')
    .replaceAll(' ', ' ')
    .replaceAll(' ', ' ')
    .replaceAll(' ', ' ')
    .replaceAll('−', '-')
    .replaceAll('–', '-');
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_ALT = [...MONTHS, ...MONTH_ABBR].join('|');

/** §7.9 "Period label (exempt)" and "Date (exempt)", as patterns over the normalised text. */
const PERIOD_PATTERNS: readonly RegExp[] = [
  /\b\d{4}-(0[1-9]|1[0-2])\b/gi,                                  // ISO YYYY-MM
  new RegExp(`\\b(${MONTH_ALT})\\.?\\s+\\d{4}\\b`, 'gi'),          // Month YYYY / Mon YYYY
  /\bQ[1-4]\s?\d{4}\b/gi,                                          // Q1 2026
  /\bFY\s?\d{2,4}\b/gi,                                            // FY25 / FY2025
];

const DATE_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b\\d{1,2}\\s+(${MONTH_ALT})\\.?\\s+\\d{4}\\b`, 'gi'),  // 3 April 2026
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,                                       // 03/04/2026
  /\b\d{4}-\d{2}-\d{2}\b/g,                                             // ISO date
];

// -----------------------------------------------------------------------------------------------
// Numeric grammar (§7.9 table)
// -----------------------------------------------------------------------------------------------

const CURRENCY_BEFORE = String.raw`(?:[£€$]|\b[A-Z]{3}\s?)`;
/*
 * Thousands-grouped OR ungrouped, never "up to three digits and then whatever".
 *
 * `\d{1,3}(,\d{3})*` alone matches "201" of "2019" and leaves a stray "9" behind — two claims
 * where there is one, and neither of them the number on the page. The grouped form therefore
 * requires at least one actual group.
 */
const DIGITS = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const ABBR = String.raw`(?:\s?(?:k|m|bn)\b)`;

const CURRENCY_RE = new RegExp(
  String.raw`-?${CURRENCY_BEFORE}\s?(?:${DIGITS})${ABBR}?` +
  '|' +
  String.raw`-?(?:${DIGITS})${ABBR}?\s?(?:[£€$]|\b[A-Z]{3}\b)`,
  'g',
);
/*
 * The `\b` belongs to the WORD forms only. `%` is not a word character, so a trailing `\b` after
 * it demands a word character next — and "8.3%." at the end of a sentence stops matching, falls
 * through to the plain-number class, and is then compared against a money field. A percentage
 * quoted for a money field is one of the traps the eval set plants; the grammar must not create it.
 */
const PERCENT_RE = /-?\d+(?:\.\d+)?\s?(?:%|(?:per ?cent|percent)\b)/gi;
const POINTS_RE = /-?\d+(?:\.\d+)?\s?(?:percentage points?|points?|pts?)\b/gi;
const PLAIN_RE = new RegExp(String.raw`-?(?:${DIGITS})${ABBR}?`, 'g');

/** §7.9 "Ordinal — **not a claim** (words)". Removed before the plain-number pass. */
const ORDINAL_RE = /\b(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|largest|second-largest)\b/gi;

const UNITS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Readonly<Record<string, number>> = { hundred: 100, thousand: 1_000, million: 1_000_000 };

/**
 * §7.9 "Word number": composed words are a claim; `one` ALONE is exempt, as are three idioms.
 *
 * The exemption matters more than it looks. "one" is the most common word in this grammar's range
 * and almost never a figure — "one of the customers", "one another", "a one-off payment" — and a
 * grammar that demanded a `NumberRef` for each of those would fail every honest answer that used
 * ordinary English.
 */
const WORD_NUMBER_RE = new RegExp(
  String.raw`\b(?:(?:${Object.keys(UNITS).join('|')})(?:[- ](?:${Object.keys(UNITS).join('|')}))*` +
  String.raw`(?:\s+(?:${Object.keys(SCALES).join('|')}))*` +
  String.raw`|(?:a\s+)?(?:${Object.keys(SCALES).join('|')}))\b`,
  'gi',
);
const WORD_IDIOMS = /\b(?:no one|one-off|one another|one of|at one|in one)\b/gi;

function wordValue(span: string): Decimal | null {
  const tokens = span.toLowerCase().replaceAll('-', ' ').split(/\s+/).filter((t) => t !== 'a');
  let total = 0;
  let current = 0;
  let sawAny = false;
  for (const token of tokens) {
    if (UNITS[token] !== undefined) { current += UNITS[token]; sawAny = true; continue; }
    const scale = SCALES[token];
    if (scale === undefined) return null;
    sawAny = true;
    if (scale === 100) current = (current === 0 ? 1 : current) * 100;
    else { total += (current === 0 ? 1 : current) * scale; current = 0; }
  }
  return sawAny ? new Decimal(total + current) : null;
}

/** Blanks a span, preserving every offset after it (see the module note). */
function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
}

function scaleOf(abbreviation: Abbreviation | null): number {
  if (abbreviation === 'k') return 1_000;
  if (abbreviation === 'm') return 1_000_000;
  if (abbreviation === 'bn') return 1_000_000_000;
  return 1;
}

function readNumeric(span: string): {
  value: Decimal; writtenDecimals: number; abbreviation: Abbreviation | null;
} | null {
  const lower = span.toLowerCase();
  const abbreviation: Abbreviation | null = /\d\s?bn\b/.test(lower)
    ? 'bn'
    : /\d\s?m\b/.test(lower) ? 'm' : /\d\s?k\b/.test(lower) ? 'k' : null;

  const digits = lower.replace(/[^0-9.,-]/g, '').replaceAll(',', '');
  const negative = digits.startsWith('-');
  const magnitude = digits.replace(/^-/, '');
  if (magnitude === '' || !/^\d*\.?\d+$/.test(magnitude)) return null;

  const dot = magnitude.indexOf('.');
  const writtenDecimals = dot === -1 ? 0 : magnitude.length - dot - 1;
  const scaled = new Decimal(magnitude).times(scaleOf(abbreviation));
  return { value: negative ? scaled.negated() : scaled, writtenDecimals, abbreviation };
}

/** Escapes a literal for use inside a RegExp. Names and references are arbitrary customer text. */
function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest first, so "Acme Trading Ltd" is removed whole rather than leaving "Trading Ltd". */
function longestFirst(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v.trim() !== ''))].sort((a, b) => b.length - a.length);
}

/**
 * §7.9's four steps, in order. Everything that survives step 3 and contains a digit is a claim.
 */
export function extractClaims(statement: string, context: ClaimContext): ExtractionResult {
  const text = normalise(statement);
  let residue = text;

  // (1) period labels and dates
  const periodSpans: { label: string; start: number }[] = [];
  for (const pattern of [...DATE_PATTERNS, ...PERIOD_PATTERNS]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (residue.slice(start, start + match[0].length).trim() === '') continue;
      periodSpans.push({ label: match[0], start });
      residue = blank(residue, start, start + match[0].length);
    }
  }
  /*
   * A bare year is a period label ONLY when the turn actually knows that period (§7.9). Blanking
   * every four-digit number would hide a real claim: "we wrote off 2019 invoices" is a count.
   */
  for (const label of context.periodLabels) {
    if (!/^\d{4}$/.test(label)) continue;
    for (const match of text.matchAll(new RegExp(String.raw`\b${label}\b`, 'g'))) {
      const start = match.index ?? 0;
      if (residue.slice(start, start + label.length).trim() === '') continue;
      periodSpans.push({ label, start });
      residue = blank(residue, start, start + label.length);
    }
  }
  for (const label of longestFirst(context.periodLabels.filter((l) => !/^\d{4}$/.test(l)))) {
    for (const match of residue.matchAll(new RegExp(escapeRe(label), 'gi'))) {
      const start = match.index ?? 0;
      periodSpans.push({ label, start });
      residue = blank(residue, start, start + label.length);
    }
  }

  // (2) entity names, longest first
  const entitySpans: { name: string; start: number }[] = [];
  for (const name of longestFirst(context.entityNames)) {
    const pattern = new RegExp(String.raw`(?<![\w])${escapeRe(name)}(?:'s)?(?![\w])`, 'gi');
    for (const match of residue.matchAll(pattern)) {
      const start = match.index ?? 0;
      entitySpans.push({ name, start });
      residue = blank(residue, start, start + match[0].length);
    }
  }

  // (3) references
  for (const reference of longestFirst(context.references)) {
    for (const match of residue.matchAll(new RegExp(escapeRe(reference), 'gi'))) {
      const start = match.index ?? 0;
      residue = blank(residue, start, start + reference.length);
    }
  }

  // Ordinals are words, not claims (§7.9), and are taken out before the numeric passes so that
  // "1st" and "second-largest" cannot be read as figures.
  let scannable = residue;
  for (const match of scannable.matchAll(ORDINAL_RE)) {
    const start = match.index ?? 0;
    scannable = blank(scannable, start, start + match[0].length);
  }
  for (const match of scannable.matchAll(WORD_IDIOMS)) {
    const start = match.index ?? 0;
    scannable = blank(scannable, start, start + match[0].length);
  }

  // (4) numeric claims, most specific class first so "8.3%" is a percentage and not a plain number
  const claims: Claim[] = [];
  const take = (kind: ClaimKind, pattern: RegExp, value: (span: string) => Claim | null): void => {
    for (const match of scannable.matchAll(pattern)) {
      const span = match[0];
      const start = match.index ?? 0;
      if (scannable.slice(start, start + span.length).trim() === '') continue;
      const claim = value(span);
      if (claim === null) continue;
      claims.push({ ...claim, kind, start, end: start + span.length });
      scannable = blank(scannable, start, start + span.length);
    }
  };

  const numeric = (span: string, start: number): Claim | null => {
    const read = readNumeric(span);
    return read === null ? null : { text: span.trim(), kind: 'plain', ...read, start, end: start };
  };

  take('points', POINTS_RE, (span) => numeric(span, 0));
  take('percentage', PERCENT_RE, (span) => numeric(span, 0));
  take('currency', CURRENCY_RE, (span) => numeric(span, 0));
  take('plain', PLAIN_RE, (span) => numeric(span, 0));
  take('word', WORD_NUMBER_RE, (span) => {
    const value = wordValue(span);
    // `one` alone is exempt (§7.9); composed forms like "twenty one" are claims.
    if (value === null || (value.equals(1) && /^\s*(?:a\s+)?one\s*$/i.test(span))) return null;
    return { text: span.trim(), kind: 'word', value, writtenDecimals: 0, abbreviation: null, start: 0, end: 0 };
  });

  return {
    claims: [...claims].sort((a, b) => a.start - b.start),
    residue,
    periodSpans,
    entitySpans,
  };
}
