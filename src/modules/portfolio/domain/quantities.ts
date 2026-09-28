import { Decimal } from '@/core/money';
import { extractClaims, normalise } from '@/modules/ai';

/**
 * What a sentence of the adviser's briefing claims, quantitatively (ADR-115). Pure.
 *
 * The digit and number-word grammar is the AI module's (`extractClaims`, AI_ARCHITECTURE §7.9) —
 * there is one claim grammar in MOTION, not two. That grammar was written for the organisation
 * analyst, whose checker compares every claim with a tool value, and it deliberately leaves some
 * English alone ("one" on its own, "a third", "doubled"). The adviser's digest carries only counts
 * and scores, so here every way of stating a magnitude has to be SEEN, or a figure written in words
 * walks past the check (audit M-1). This module reads, before handing the rest to that grammar:
 *
 *   - fractions ("one and a half", "three quarters", "a third", "½"), with the exact value when one
 *     exists and none when it does not ("a third" is not a decimal);
 *   - multipliers ("doubled", "halved", "cut by half", "twice as", "3x", "twofold") as a `multiple`,
 *     and the ambiguous ones ("three times higher") as a multiple with no value;
 *   - "one", "zero" and "no" in front of a counted noun or a unit ("one month", "no critical
 *     alerts"), which the shared grammar exempts because "one of the customers" is not a figure;
 *   - the unit each claim is stated in, including the spellings the shared grammar does not know
 *     ("8pc", "8 pct", "8pp", "months", "days", "pounds");
 *   - qualifiers that make a figure approximate ("about 20%", "roughly doubled", "more than 3") and
 *     words that state a magnitude with no figure at all ("sharply", "significantly", "most of").
 *
 * Nothing here decides whether a claim is TRUE. It says what is claimed; `briefing.ts` binds each
 * claim to one cited fact. Titles and client names are text, never facts: a quoted, cited title and
 * a client's name are taken out before the scan, and only when nothing adjacent turns them into a
 * figure ("fell “3”%" is refused, audit L-2).
 */

export type QuantityUnit =
  /** No unit: a count or a score. */
  | 'bare'
  | 'percent'
  /** Points of a score ("23 points"). A percentage point is not one: it is `unknown`. */
  | 'points'
  | 'months'
  | 'money'
  /** A ratio of a value to its comparison ("doubled" = 2, "halved" = 0.5). */
  | 'multiple'
  /** A share with no unit ("half of the clients", "fell by a third"). */
  | 'proportion'
  /** A unit no fact can be stated in (days, weeks, percentage points, "times" on its own). */
  | 'unknown';

export interface Quantity {
  /** The span as written, for the removal record. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** The exact value, or null when the words do not resolve to one. Never a float. */
  readonly value: Decimal | null;
  readonly unit: QuantityUnit;
  /** Hedged ("about", "over", "roughly", "or more"): no fact states a range, so never grounded. */
  readonly approximate: boolean;
}

export interface PeriodMention {
  readonly text: string;
  readonly start: number;
  /** 1–12, or null when the mention names no month (a year, a quarter, an unparsed label). */
  readonly month: number | null;
  readonly year: number | null;
  readonly quarter: number | null;
}

export interface NameMention {
  /** The name as the caller listed it. */
  readonly name: string;
  readonly start: number;
}

export interface Reading {
  /** The normalised sentence; every offset below points into it. */
  readonly text: string;
  /** The sentence with titles, names, periods, references and quantities blanked — where metric,
   * direction and portfolio words are read from, so a title or a name cannot supply them. */
  readonly words: string;
  readonly quantities: readonly Quantity[];
  readonly periods: readonly PeriodMention[];
  readonly names: readonly NameMention[];
  /** Language that states a magnitude the server cannot resolve, or a title used as a figure. */
  readonly unresolved: readonly string[];
  /** Clause ranges; a quantity is bound to the words of its own clause only. */
  readonly clauses: readonly { readonly start: number; readonly end: number }[];
}

export interface ReadingContext {
  /** Names that may be mentioned (client names and their short forms), longest first or not. */
  readonly names: readonly string[];
  /** Titles the sentence may quote — the alerts and actions it cites. */
  readonly quoted: readonly string[];
  /** The digest's period labels, for labels this module could not otherwise recognise. */
  readonly periodLabels: readonly string[];
}

// -----------------------------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const WORD_VALUES: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const WORD = Object.keys(WORD_VALUES).join('|');
/** A number in digits or in words ("25", "1.5", "twenty-five", "a hundred"). */
const NUM = String.raw`(?:\d+(?:\.\d+)?|(?:${WORD})(?:[- ](?:${WORD}))*(?:\s+(?:hundred|thousand|million))?)`;

/** Fractions with an exact decimal. A third, a sixth… have none, and are never grounded. */
const FRACTIONS: Readonly<Record<string, string | null>> = {
  half: '0.5', halves: '0.5', quarter: '0.25', quarters: '0.25', third: null, thirds: null,
  fifth: '0.2', fifths: '0.2', tenth: '0.1', tenths: '0.1',
};
const FRACTION = Object.keys(FRACTIONS).join('|');

const VULGAR: Readonly<Record<string, string | null>> = {
  '½': '.5', '¼': '.25', '¾': '.75', '⅛': '.125', '⅜': '.375', '⅝': '.625', '⅞': '.875',
  '⅕': '.2', '⅖': '.4', '⅗': '.6', '⅘': '.8', '⅒': '.1', '⅓': null, '⅔': null, '⅙': null, '⅚': null,
};

/** Counted nouns: "one critical alert", "no overdue actions". */
const COUNTED = String.raw`(?:(?:more|critical|high|open|overdue|standing|urgent|new|further|other|acknowledged|unscored|healthy)\s+){0,2}(?:alerts?|actions?|clients?|organisations?|organizations?)\b`;
/** Units a bare "one" can carry. */
const ONE_UNIT = String.raw`(?:months?|points?|per ?cent|percent|%)`;

/** Words that make the figure after them approximate. */
const APPROX_BEFORE = /(?:\babout|\baround|\bapproximately|\bapprox\.?|\broughly|\bnearly|\balmost|\bcirca|\bc\.|\bsome|\bover|\bunder|\bmore than|\bless than|\bfewer than|\bat least|\bat most|\bup to|\bjust over|\bjust under|\bclose to|\bupwards of|\bin excess of|\bbelow|\babove|\bbetween|\ban estimated|\bestimated|\bpotentially|\bperhaps|\bmaybe|~)\s*(?:by\s+)?$/i;
const APPROX_AFTER = /^\s*(?:or so\b|or more\b|or less\b|or fewer\b|plus\b|\+|odd\b|-ish\b|ish\b)/i;

/**
 * A magnitude stated with no figure. §12 of the remediation brief: never coerce these into a number
 * and never let them pass as grounded — the digest holds no fact that says "sharply".
 */
const VAGUE = /\b(?:significantly|significant|materially|substantially|substantial|sharply|sharp|dramatically|dramatic|considerably|considerable|markedly|massively|massive|hugely|huge|steeply|steep|drastically|drastic|majority|minority|most of|several|a few|a handful|many|numerous|dozens|a lot|lots of|double-digit|triple-digit|single-digit)\b/gi;

/**
 * What separates two claims in one sentence. "Revenue fell 8% while runway is 3 months" is two
 * claims, and neither may borrow the other's metric (remediation brief §9).
 */
const CLAUSE_BREAK = /[,;:()]|\s[-–—]\s|\b(?:and|but|while|whilst|whereas|although|though|yet|with|however|plus|because|since|after|due to|following|which|so)\b/gi;

/** Something next to a title or a name that would turn it into a figure. */
const FIGURE_AFTER = /^\s*(?:%|per ?cent\b|percent\b|pct\b|pc\b|pp\b|points?\b|pts?\b|months?\b|[x×](?![\w])|times\b|k\b|m\b|bn\b|[.,]\d)/i;
const FIGURE_BEFORE = /(?:[£$€]\s*|\d[.,]?)$/;

// -----------------------------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------------------------

function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
}

function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "twenty-five" → 25, "a hundred" → 100, "1.5" → 1.5. Null when it is not one number. */
export function numberValue(span: string): Decimal | null {
  const s = span.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(s)) return new Decimal(s);
  const tokens = s.replaceAll('-', ' ').split(/\s+/).filter((t) => t !== 'a' && t !== 'and');
  let total = 0;
  let current = 0;
  let seen = false;
  for (const token of tokens) {
    const unit = WORD_VALUES[token];
    if (unit !== undefined) { current += unit; seen = true; continue; }
    if (token === 'hundred') { current = (current === 0 ? 1 : current) * 100; seen = true; continue; }
    const scale = token === 'thousand' ? 1_000 : token === 'million' ? 1_000_000 : null;
    if (scale === null) return null;
    total += (current === 0 ? 1 : current) * scale;
    current = 0;
    seen = true;
  }
  return seen ? new Decimal(total + current) : null;
}

/** The unit written after a figure, and how far it runs. */
function unitAfter(after: string): { unit: QuantityUnit; length: number } | null {
  const tests: ReadonlyArray<[RegExp, QuantityUnit]> = [
    [/^\s?(?:%|per ?cent\b|percent\b|pct\b|pc\b)/i, 'percent'],
    [/^\s?(?:pp\b|percentage points?\b|ppts?\b)/i, 'unknown'],
    [/^\s*(?:points?\b|pts?\b)/i, 'points'],
    [/^\s*(?:-\s*)?months?\b/i, 'months'],
    [/^\s*(?:-\s*)?(?:weeks?|days?|years?|quarters?|hours?)\b/i, 'unknown'],
    [/^\s*(?:pounds?|sterling|dollars?|euros?|dirhams?|aed|gbp|usd|eur)\b/i, 'money'],
    [/^\s*times\b/i, 'unknown'],
  ];
  for (const [re, unit] of tests) {
    const m = re.exec(after);
    if (m) return { unit, length: m[0].length };
  }
  return null;
}

/** Month, year and quarter of a period mention or a `Mon YYYY` label, where it names them. */
export function periodOf(text: string): Omit<PeriodMention, 'text' | 'start'> {
  const lower = text.toLowerCase();
  const year = /\b((?:19|20)\d{2})\b/.exec(lower);
  const iso = /\b(\d{4})-(\d{2})/.exec(lower);
  if (iso) return { month: Number(iso[2]), year: Number(iso[1]), quarter: null };
  const q = /\bq([1-4])\b/.exec(lower);
  let month: number | null = null;
  for (const word of lower.split(/[^a-z]+/)) {
    const full = MONTHS.indexOf(word);
    const abbr = MONTH_ABBR.indexOf(word === 'sept' ? 'sep' : word);
    if (full !== -1) { month = full + 1; break; }
    if (abbr !== -1) { month = abbr + 1; break; }
  }
  return { month, year: year ? Number(year[1]) : null, quarter: q ? Number(q[1]) : null };
}

// -----------------------------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------------------------

export function readQuantities(sentence: string, context: ReadingContext): Reading {
  // Vulgar fractions first: NFKC would turn "1½" into "11⁄2".
  const text = normalise(sentence.replace(/(\d*)([½¼¾⅛⅜⅝⅞⅕⅖⅗⅘⅒⅓⅔⅙⅚])/g, (_, whole: string, fraction: string) => {
    const decimal = VULGAR[fraction];
    return decimal === null || decimal === undefined ? `${whole} a third` : `${whole === '' ? '0' : whole}${decimal}`;
  }));
  let scan = text;
  const unresolved: string[] = [];
  const quantities: Quantity[] = [];
  const periods: PeriodMention[] = [];
  const names: NameMention[] = [];

  const guarded = (start: number, end: number, what: string): void => {
    if (FIGURE_AFTER.test(text.slice(end)) || FIGURE_BEFORE.test(text.slice(0, start))) {
      unresolved.push(`${what} is used as a figure`);
    }
  };

  // 1. Quoted titles of cited alerts and actions: text, not facts. Only the exact title, only in
  //    quotation marks, and never with a unit or a currency against it (audit L-2).
  const quoted = new Set(context.quoted.map((t) => normalise(t).trim()).filter((t) => t !== ''));
  for (const m of text.matchAll(/[“"‘]([^“”"‘’]+)[”"’]/g)) {
    const inner = m[1]!.trim();
    if (!quoted.has(inner)) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    guarded(start, end, `the quoted title "${inner}"`);
    scan = blank(scan, start, end);
  }

  // 2. Client names, longest first — who a claim is about, never a figure.
  for (const name of [...new Set(context.names.filter((n) => n.trim() !== ''))].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(String.raw`(?<![\w])${escapeRe(normalise(name))}(?:'s|’s)?(?![\w])`, 'gi');
    for (const m of scan.matchAll(pattern)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      names.push({ name, start });
      guarded(start, end, `the name "${name}"`);
      scan = blank(scan, start, end);
    }
  }

  // 3. Periods and dates. A figure's period is a claim too (checked against the fact's).
  const MONTH_ALT = [...MONTHS, ...MONTH_ABBR, 'sept'].join('|');
  const periodPatterns: RegExp[] = [
    /\b\d{4}-\d{2}-\d{2}\b/g,
    new RegExp(String.raw`\b\d{1,2}\s+(?:${MONTH_ALT})\.?\s+\d{4}\b`, 'gi'),
    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
    /\b\d{4}-(?:0[1-9]|1[0-2])\b/g,
    new RegExp(String.raw`\b(?:${MONTH_ALT})\.?\s+\d{4}\b`, 'gi'),
    /\bQ[1-4](?:\s?\d{4})?\b/g,
    /\bFY\s?\d{2,4}\b/gi,
    // A month on its own is a period only when capitalised: "may" is a verb.
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b/g,
    ...context.periodLabels.filter((l) => l.trim() !== '').map((l) => new RegExp(escapeRe(normalise(l)), 'gi')),
  ];
  for (const pattern of periodPatterns) {
    for (const m of scan.matchAll(pattern)) {
      const start = m.index ?? 0;
      periods.push({ text: m[0], start, ...periodOf(m[0]) });
      scan = blank(scan, start, start + m[0].length);
    }
  }
  // A bare year only after a preposition: "in 2025". Elsewhere a four-digit number is a figure.
  for (const m of scan.matchAll(/\b(?:in|since|during|for|from|to|until|by|of|through)\s+((?:19|20)\d{2})\b/gi)) {
    const start = (m.index ?? 0) + m[0].length - m[1]!.length;
    periods.push({ text: m[1]!, start, month: null, year: Number(m[1]), quarter: null });
    scan = blank(scan, start, start + m[1]!.length);
  }

  // 4. References are identifiers, not figures.
  for (const m of scan.matchAll(/\b(?:client|alert|action):\d+\b/gi)) {
    scan = blank(scan, m.index ?? 0, (m.index ?? 0) + m[0].length);
  }

  // The words a claim is read against: what is left, before any quantity is taken out.
  let words = scan;

  // 5. Magnitudes with no figure.
  for (const m of scan.matchAll(VAGUE)) unresolved.push(`"${m[0]}" states a magnitude no fact gives`);

  // 6. Multipliers, fractions and the counted "one"/"zero"/"no" — longest forms first.
  const take = (pattern: RegExp, read: (m: RegExpMatchArray) => { value: Decimal | null; unit: QuantityUnit } | null): void => {
    for (const m of scan.matchAll(pattern)) {
      const start = m.index ?? 0;
      if (scan.slice(start, start + m[0].length).trim() === '') continue;
      const q = read(m);
      if (q === null) continue;
      let end = start + m[0].length;
      let unit = q.unit;
      if (unit === 'bare' || unit === 'proportion') {
        const after = unitAfter(text.slice(end));
        if (after) { unit = after.unit; end += after.length; }
      }
      quantities.push({ text: text.slice(start, end).trim(), start, end, value: q.value, unit, approximate: false });
      scan = blank(scan, start, end);
    }
  };
  const d = (value: string | number) => new Decimal(value);

  take(/\b(?:single|double|triple)[- ]digits?\b/gi, () => ({ value: null, unit: 'unknown' }));
  take(/\b(?:cut|fell|fallen|dropped|declined|decreased|reduced|down|shrank|shrunk|lower)\s+(?:by|in)\s+(?:a\s+|one\s+)?half\b/gi, () => ({ value: d('0.5'), unit: 'multiple' }));
  take(/\b(?:rose|risen|increased|grew|grown|up|higher|gained)\s+by\s+(?:a\s+|one\s+)?half\b/gi, () => ({ value: d('1.5'), unit: 'multiple' }));
  take(/\b(?:doubled|doubles|doubling|double)\b(?![- ]check)/gi, () => ({ value: d(2), unit: 'multiple' }));
  take(/\b(?:tripled|triples|tripling|trebled|triple)\b/gi, () => ({ value: d(3), unit: 'multiple' }));
  take(/\b(?:quadrupled|quadruples|quadrupling)\b/gi, () => ({ value: d(4), unit: 'multiple' }));
  take(/\b(?:halved|halves|halving)\b/gi, () => ({ value: d('0.5'), unit: 'multiple' }));
  take(/\btwice\s+(?:as|the)\b/gi, () => ({ value: d(2), unit: 'multiple' }));
  take(new RegExp(String.raw`\b(${NUM})\s+times\s+(?:as|the)\b`, 'gi'), (m) => ({ value: numberValue(m[1]!), unit: 'multiple' }));
  // "Three times higher" is read as 3x and as 4x by different people: no value.
  take(new RegExp(String.raw`\b(${NUM})\s+times\s+(?:higher|more|larger|greater|bigger|lower|smaller|less|fewer|over)\b`, 'gi'), () => ({ value: null, unit: 'multiple' }));
  take(new RegExp(String.raw`\b(?:(?:decreased|declined|fell|dropped|reduced|cut|down)\s+(?:by\s+)?)(${NUM})[- ]?fold\b`, 'gi'), () => ({ value: null, unit: 'multiple' }));
  take(new RegExp(String.raw`\b(${NUM})[- ]?fold\b`, 'gi'), (m) => ({ value: numberValue(m[1]!), unit: 'multiple' }));
  take(/\b(?:two|three|four|five|ten|hundred)fold\b/gi, (m) => ({ value: numberValue(m[0].toLowerCase().replace('fold', '')), unit: 'multiple' }));
  take(/\b(\d+(?:\.\d+)?)\s?[x×](?![\w])/gi, (m) => ({ value: d(m[1]!), unit: 'multiple' }));
  take(/\btwice\b/gi, () => ({ value: d(2), unit: 'bare' }));
  take(/\bthrice\b/gi, () => ({ value: d(3), unit: 'bare' }));
  // "one and a half", "two and three quarters"
  take(new RegExp(String.raw`\b(${NUM})\s+and\s+(a|one|three)\s+(half|quarter|quarters)\b`, 'gi'), (m) => {
    const whole = numberValue(m[1]!);
    const part = m[3]!.toLowerCase() === 'half' ? '0.5' : m[2]!.toLowerCase() === 'three' ? '0.75' : '0.25';
    return { value: whole === null ? null : whole.plus(part), unit: 'bare' };
  });
  // "a third", "three quarters", "one half"
  take(new RegExp(String.raw`\b(a|an|one|two|three|four|five|seven|nine)[\s-]+(${FRACTION})\b`, 'gi'), (m) => {
    const each = FRACTIONS[m[2]!.toLowerCase()];
    const count = m[1]!.toLowerCase().startsWith('a') ? 1 : numberValue(m[1]!)?.toNumber() ?? null;
    return { value: each === null || each === undefined || count === null ? null : d(each).times(count), unit: 'proportion' };
  });
  take(/\bhalf\b/gi, () => ({ value: d('0.5'), unit: 'proportion' }));
  take(new RegExp(String.raw`\bone\s+(?=${COUNTED}|${ONE_UNIT})`, 'gi'), () => ({ value: d(1), unit: 'bare' }));
  take(/\bzero\b/gi, () => ({ value: d(0), unit: 'bare' }));
  take(new RegExp(String.raw`\bno\s+(?=${COUNTED})`, 'gi'), () => ({ value: d(0), unit: 'bare' }));
  take(/\b\d+\s*[/⁄]\s*\d+\b/g, () => ({ value: null, unit: 'proportion' }));

  // 7. Everything else: the shared grammar (digits, number words, %, points, currency).
  const rest = extractClaims(scan, { periodLabels: [], entityNames: [], references: [] });
  for (const claim of rest.claims) {
    let unit: QuantityUnit;
    let end = claim.end;
    if (claim.kind === 'percentage') unit = 'percent';
    else if (claim.kind === 'points') unit = /percentage/i.test(claim.text) ? 'unknown' : 'points';
    else if (claim.kind === 'currency') unit = 'money';
    else {
      const after = unitAfter(text.slice(claim.end));
      unit = after?.unit ?? 'bare';
      if (after) end += after.length;
    }
    quantities.push({ text: text.slice(claim.start, end).trim(), start: claim.start, end, value: claim.value, unit, approximate: false });
    scan = blank(scan, claim.start, end);
  }

  // 8. Hedges around each figure.
  const hedged = quantities.map((q) => ({
    ...q,
    approximate: APPROX_BEFORE.test(text.slice(0, q.start)) || APPROX_AFTER.test(text.slice(q.end)),
  }));
  for (const q of hedged) words = blank(words, q.start, q.end);

  // 9. Clauses, over what is left once every figure and name is out ("one and a half" has no "and").
  const clauses: { start: number; end: number }[] = [];
  let from = 0;
  for (const m of scan.matchAll(CLAUSE_BREAK)) {
    const at = m.index ?? 0;
    clauses.push({ start: from, end: at });
    from = at + m[0].length;
  }
  clauses.push({ start: from, end: text.length });

  return {
    text,
    words,
    quantities: hedged.sort((a, b) => a.start - b.start),
    periods: periods.sort((a, b) => a.start - b.start),
    names: names.sort((a, b) => a.start - b.start),
    unresolved,
    clauses,
  };
}
