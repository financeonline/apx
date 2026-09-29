import { normalise } from '@/modules/ai';

/**
 * The rule for the adviser's own words (ADR-116). Pure.
 *
 * The model does not write figures. Every quantity in an answer is a FACT the server renders
 * (`briefing.ts`); what the model writes itself is prose, and prose is untrusted. This module does
 * not try to understand prose — ADR-115 tried, and every parser left another phrasing through
 * (audit F-1…F-4). It answers one question: does this text carry anything quantitative? If it does,
 * the text is not the source of that quantity, so the sentence is removed.
 *
 * "Quantitative" is drawn wide on purpose, because a false positive costs one removed sentence and
 * a false negative is a figure nobody vouches for:
 *   - any numeral in any script (`\p{N}`: 0-9, Arabic-Indic, fullwidth, ½, Ⅳ, superscripts), and
 *     Roman numerals written in letters;
 *   - number, ordinal (from "second"), fraction, multiplier and cardinality words — "twenty", "a
 *     dozen", "a couple", "a single", "both", "all", "none", "every", "no alerts", "half",
 *     "doubled", "twofold", "times";
 *   - percent and point words, and magnitude words that state a size without a figure ("sharply",
 *     "significantly", "most of");
 *   - any period ("August", "this month", "year to date", "Q3") — periods belong to facts;
 *   - letters outside the Latin script: MOTION answers in English, and a number word in another
 *     language is still a number.
 * Vague, non-numeric quantifiers stay allowed ("several actions are overdue", "some clients"), as
 * does "first" and "one of". Client names are the tenant's own text and are set aside before the
 * scan, whole and only when they contain a letter.
 */

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
  'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundreds?', 'thousands?', 'millions?', 'billions?', 'trillions?',
  'dozens?', 'score of', 'couple', 'pairs?', 'single', 'sole', 'lone', 'both', 'trio', 'handful', 'twice', 'thrice',
];
const ORDINAL_WORDS = [
  'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
  '\\w+teenth', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'hundredth', 'thousandth',
];
const FRACTION_MULTIPLIER_WORDS = [
  'halfs?', 'halves', 'halved', 'halving', 'quarters?', 'thirds',
  'double', 'doubled', 'doubles', 'doubling', 'triple', 'tripled', 'triples', 'tripling', 'treble', 'trebled',
  'quadruple', 'quadrupled', '\\w*fold', 'times', 'multiple of',
];
const PROPORTION_WORDS = [
  'per ?cent', 'percent', 'percentage', 'percentages', 'pp', 'bps', 'basis points?', 'points?', 'pts',
  'majority', 'minority', 'most of', 'bulk of', 'proportion', 'ratio',
];
const TOTALITY_WORDS = [
  'all', 'every', 'each', 'none', 'nothing', 'nobody', 'neither', 'no (?:\\w+ ){0,2}(?:alerts?|actions?|clients?|organi[sz]ations?|issues?|tasks?)',
];
const MAGNITUDE_WORDS = [
  'significantly', 'significant', 'materially', 'substantially', 'substantial', 'sharply', 'sharp', 'dramatically',
  'dramatic', 'considerably', 'considerable', 'markedly', 'massively', 'massive', 'hugely', 'huge', 'steeply', 'steep',
  'drastically', 'drastic', 'tenfold', 'exponentially',
];
const PERIOD_WORDS = [
  'january', 'february', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept?', 'oct', 'nov', 'dec',
  '(?:this|last|next|previous|prior|past|coming|current|same) (?:week|month|quarter|year|period|financial year|fiscal year)',
  'year to date', 'ytd', 'month on month', 'year on year', 'yoy', 'quarter', 'quarterly', 'fy', 'h[12]',
  'yesterday', 'today', 'tomorrow', 'fortnight',
];
// "March" and "May" are months only when capitalised; lower case they are a verb and a modal.
const CAPITALISED_MONTHS = /\b(?:March|May)\b/;

const IDIOMS = /\b(?:no one|one of|one another|one-off|(?:the|this|that|which) one|at all|all but|first of all|above all|after all)\b/gi;

function wordsRe(words: readonly string[]): RegExp {
  return new RegExp(`\\b(?:${words.join('|')})\\b`, 'gi');
}

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\p{N}/gu, 'a numeral'],
  [/[%‰]/g, 'a percent sign'],
  [/\b(?=[MDCLXVI]{2,}\b)M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})\b/g, 'a Roman numeral'],
  [wordsRe(NUMBER_WORDS), 'a number word'],
  [wordsRe(ORDINAL_WORDS), 'an ordinal'],
  [wordsRe(FRACTION_MULTIPLIER_WORDS), 'a fraction or multiplier'],
  [wordsRe(PROPORTION_WORDS), 'a proportion'],
  [wordsRe(TOTALITY_WORDS), 'a count of all or none'],
  [wordsRe(MAGNITUDE_WORDS), 'a magnitude'],
  [wordsRe(PERIOD_WORDS), 'a period'],
  [CAPITALISED_MONTHS, 'a period'],
  [/(?:(?!\p{Script=Latin})\p{L})+/gu, 'a word outside the Latin script'],
];

function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What in `text` is quantitative, as short reasons ("a number word: 'dozen'"). Empty when the text
 * is prose the adviser may write. `names` are client names, set aside whole before the scan.
 */
export function quantitativeContent(text: string, names: readonly string[] = []): string[] {
  let scan = normalise(text);
  for (const name of [...new Set(names)].filter((n) => /\p{L}/u.test(n)).sort((a, b) => b.length - a.length)) {
    scan = scan.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(normalise(name))}(?:'s|’s)?(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  }
  scan = scan.replace(IDIOMS, ' ');
  const found: string[] = [];
  for (const [re, what] of RULES) {
    for (const m of scan.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
      found.push(`${what}: '${m[0].trim()}'`);
    }
  }
  return found;
}
