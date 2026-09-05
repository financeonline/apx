/**
 * Number transforms (IMPORT_ENGINE.md §6.4 "Numbers" and "Negative styles").
 *
 * Every amount leaves this file as a STRING (ADR-006). Nothing here calls `parseFloat` or `Number`
 * on a figure: `1.234,56` and `1,234.56` are the same amount written two ways, and the only safe
 * route from either to storage is a normalised decimal literal handed to `@/core/money`.
 *
 * The separators are detected per column, not per value, because a single value is often ambiguous
 * ("1,234" is either one thousand two hundred and thirty-four, or 1.234) while a column almost
 * never is.
 */

import { toMoneyString } from '@/core/money';

export interface NumberFormat {
  readonly decimalSeparator: '.' | ',';
  readonly thousandsSeparator: '.' | ',' | ' ' | '';
}

/** §6.4 lists five spellings of a negative; all of them normalise to a signed decimal string. */
export type NegativeStyle =
  | 'leading_minus'      // -123.45
  | 'parentheses'        // (123.45)
  | 'trailing_minus'     // 123.45-
  | 'cr_dr_suffix'       // 123.45 CR / 123.45 DR
  | 'cr_dr_column';      // a separate CR/DR column

/**
 * Symbol → ISO code. `$` is genuinely ambiguous between USD, CAD, AUD and others; it is reported as
 * USD because that is the convention, and `IMP-CUR-007` compares whatever is reported against
 * `organizations.base_currency` — so a mis-read symbol surfaces as an error for a human rather than
 * as a silently converted figure.
 */
const SYMBOL_CURRENCY: Readonly<Record<string, string>> = {
  '£': 'GBP', '€': 'EUR', '$': 'USD', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₽': 'RUB',
  '₪': 'ILS', '₦': 'NGN', '₺': 'TRY', '฿': 'THB', 'د.إ': 'AED',
};

const SYMBOLS = Object.keys(SYMBOL_CURRENCY).filter((s) => s.length === 1).join('');
const SYMBOL_PATTERN = new RegExp(`[${SYMBOLS}]`, 'gu');
const CODE_PATTERN = /(?:^|\s)([A-Z]{3})(?=\s|$|[\d(.-])|(?<=[\d).])\s?([A-Z]{3})(?:\s|$)/u;

/** NFKC plus the space and dash normalisations the claim grammar uses (`AI_ARCHITECTURE.md` §7.9). */
function normalize(cell: string): string {
  return cell
    .normalize('NFKC')
    .replace(/[\u00a0\u2007\u2009\u200a\u202f]/gu, ' ')
    .replace(/[\u2212\u2013\u2014]/gu, '-')
    .trim();
}

export interface CurrencyStripResult {
  readonly text: string;
  readonly currency: string | null;
}

/** Remove currency symbols and codes, reporting what was removed (§6.4, `IMP-CUR-007`). */
export function stripCurrency(cell: string): CurrencyStripResult {
  const text = normalize(cell);
  let currency: string | null = null;

  const symbol = text.match(SYMBOL_PATTERN);
  if (symbol !== null && symbol.length > 0) currency = SYMBOL_CURRENCY[symbol[0] as string] ?? null;

  let withoutSymbols = text.replace(SYMBOL_PATTERN, ' ');

  const code = CODE_PATTERN.exec(withoutSymbols);
  if (code !== null) {
    const found = code[1] ?? code[2] ?? null;
    // CR and DR are the negative-style markers of §6.4, not currencies.
    if (found !== null && found !== 'CR' && found !== 'DR') {
      currency = currency ?? found;
      withoutSymbols = withoutSymbols.replace(found, ' ');
    }
  }

  return { text: withoutSymbols.replace(/\s+/gu, ' ').trim(), currency };
}

const CR_DR_SUFFIX = /(?:^|\s)(CR|DR)(?:\s|$)/iu;
const TRAILING_MINUS = /-\s*$/u;
const PARENTHESISED = /^\((.*)\)$/u;

/** A separate CR/DR column: `CR` credits the account (money in), `DR` debits it (money out). */
export function creditDebitSign(marker: string | null | undefined): -1 | 1 | null {
  const token = (marker ?? '').trim().toUpperCase();
  if (token === 'CR' || token === 'C' || token === 'CREDIT') return 1;
  if (token === 'DR' || token === 'D' || token === 'DEBIT') return -1;
  return null;
}

export interface AmountParseOptions {
  readonly format?: NumberFormat;
  /** The value of a separate CR/DR column for this row, when the file has one (§6.4). */
  readonly creditDebitMarker?: string | null;
}

export interface ParsedAmount {
  /** A signed money string, or `null` when the cell is empty or unreadable (`IMP-AMT-002`). */
  readonly amount: string | null;
  readonly ok: boolean;
  readonly negativeStyle: NegativeStyle | null;
  readonly currency: string | null;
  /** True when the source carried more than two decimals and storage precision rounded it. */
  readonly rounded: boolean;
  readonly empty: boolean;
}

const DEFAULT_FORMAT: NumberFormat = { decimalSeparator: '.', thousandsSeparator: ',' };

const NUMERIC_LITERAL = /^\d+(?:\.\d+)?$/u;

/**
 * Parse one amount cell into a signed money string.
 *
 * The order below matters: currency marks come off first, then the CR/DR marker, then the
 * bracket/trailing-minus wrappers, and only what is left is treated as digits and separators.
 * "(£1,234.56 CR)" is a real cell and every layer of it has to be peeled in the right order.
 */
export function parseAmount(cell: string | null | undefined, options: AmountParseOptions = {}): ParsedAmount {
  const format = options.format ?? DEFAULT_FORMAT;
  const columnSign = creditDebitSign(options.creditDebitMarker);

  if (cell === null || cell === undefined || normalize(cell) === '') {
    return { amount: null, ok: true, negativeStyle: null, currency: null, rounded: false, empty: true };
  }

  const { text: withoutCurrency, currency } = stripCurrency(cell);
  let text = withoutCurrency;
  let negative = false;
  let style: NegativeStyle | null = columnSign === -1 ? 'cr_dr_column' : null;
  if (columnSign === -1) negative = true;

  const suffix = CR_DR_SUFFIX.exec(text);
  if (suffix !== null) {
    const marker = (suffix[1] as string).toUpperCase();
    text = text.replace(CR_DR_SUFFIX, ' ').trim();
    if (marker === 'DR') { negative = true; style = 'cr_dr_suffix'; }
    else { negative = false; style = style === 'cr_dr_column' ? style : null; }
  }

  const bracketed = PARENTHESISED.exec(text.trim());
  if (bracketed !== null) {
    text = (bracketed[1] as string).trim();
    negative = true;
    style = 'parentheses';
  }

  if (TRAILING_MINUS.test(text)) {
    text = text.replace(TRAILING_MINUS, '').trim();
    negative = true;
    style = style ?? 'trailing_minus';
    if (style !== 'parentheses' && style !== 'cr_dr_suffix' && style !== 'cr_dr_column') {
      style = 'trailing_minus';
    }
  }

  if (text.startsWith('-')) {
    text = text.slice(1).trim();
    negative = true;
    style = style ?? 'leading_minus';
  } else if (text.startsWith('+')) {
    text = text.slice(1).trim();
  }

  // Whitespace inside a number is always a thousands separator, whatever the column's declared
  // separator is: "1 234.56" is one number in every locale that writes it that way.
  let digits = text.replace(/\s+/gu, '');
  if (format.thousandsSeparator !== '' && format.thousandsSeparator !== ' ') {
    digits = digits.split(format.thousandsSeparator).join('');
  }
  if (format.decimalSeparator === ',') digits = digits.replace(/,/gu, '.');

  if (digits === '') {
    return { amount: null, ok: true, negativeStyle: null, currency, rounded: false, empty: true };
  }
  if (!NUMERIC_LITERAL.test(digits)) {
    return { amount: null, ok: false, negativeStyle: style, currency, rounded: false, empty: false };
  }

  const fraction = digits.split('.')[1] ?? '';
  const signed = negative ? `-${digits}` : digits;
  return {
    amount: toMoneyString(signed),
    ok: true,
    negativeStyle: negative ? style ?? 'leading_minus' : null,
    currency,
    rounded: fraction.length > 2,
    empty: false,
  };
}

export type SeparatorEvidence =
  | 'both_separators' | 'decimal_comma' | 'decimal_point' | 'comma_grouping' | 'point_grouping' | 'none';

export interface NumberColumnDetection extends NumberFormat {
  readonly evidence: SeparatorEvidence;
  readonly total: number;
  readonly parsed: number;
  readonly unparsed: number;
  readonly unparsedSamples: readonly string[];
  /** Every currency seen in the column; more than one is a problem for `IMP-CUR-007`. */
  readonly currencies: readonly string[];
  /** The single currency the column is in, or `null` when none or several were found. */
  readonly currency: string | null;
  readonly negativeStyles: readonly NegativeStyle[];
  readonly spaceThousands: boolean;
}

const HAS_SPACE_GROUPING = /\d[\s\u00a0]\d{3}(?!\d)/u;
const COMMA_DECIMAL = /,\d{1,2}(?!\d)/u;
const POINT_DECIMAL = /\.\d{1,2}(?!\d)/u;
const COMMA_GROUPING = /\d{1,3}(?:,\d{3})+(?!\d)/u;
const POINT_GROUPING = /\d{1,3}(?:\.\d{3})+(?!\d)/u;

/**
 * Detect a column's decimal and thousands separators (§6.4).
 *
 * A value containing both separators settles it outright — whichever comes last is the decimal
 * point. Failing that the column is read as a whole: one "1.234,56" among a hundred "1.234" values
 * is enough to prove the comma is the decimal separator, and no single value could have proved it.
 */
export function detectNumberColumn(cells: readonly (string | null | undefined)[]): NumberColumnDetection {
  const present = cells
    .filter((cell): cell is string => cell !== null && cell !== undefined && normalize(cell) !== '')
    .map((cell) => cell);

  let bothCommaLast = 0;
  let bothPointLast = 0;
  let commaDecimal = 0;
  let pointDecimal = 0;
  let commaGrouping = 0;
  let pointGrouping = 0;
  let spaceThousands = false;
  const currencies = new Set<string>();

  for (const cell of present) {
    const { text, currency } = stripCurrency(cell);
    if (currency !== null) currencies.add(currency);
    const core = text.replace(/[()+-]|(?:^|\s)(?:CR|DR)(?:\s|$)/giu, ' ');
    if (HAS_SPACE_GROUPING.test(core)) spaceThousands = true;

    const lastComma = core.lastIndexOf(',');
    const lastPoint = core.lastIndexOf('.');
    if (lastComma >= 0 && lastPoint >= 0) {
      if (lastComma > lastPoint) bothCommaLast += 1; else bothPointLast += 1;
      continue;
    }
    if (lastComma >= 0) {
      if (COMMA_GROUPING.test(core)) commaGrouping += 1;
      else if (COMMA_DECIMAL.test(core)) commaDecimal += 1;
    } else if (lastPoint >= 0) {
      if (POINT_GROUPING.test(core)) pointGrouping += 1;
      else if (POINT_DECIMAL.test(core)) pointDecimal += 1;
    }
  }

  let decimalSeparator: '.' | ',';
  let evidence: SeparatorEvidence;
  if (bothCommaLast > 0 || bothPointLast > 0) {
    decimalSeparator = bothCommaLast > bothPointLast ? ',' : '.';
    evidence = 'both_separators';
  } else if (commaDecimal > 0 && commaDecimal >= pointDecimal) {
    decimalSeparator = ',';
    evidence = 'decimal_comma';
  } else if (pointDecimal > 0) {
    decimalSeparator = '.';
    evidence = 'decimal_point';
  } else if (commaGrouping > 0) {
    decimalSeparator = '.';
    evidence = 'comma_grouping';
  } else if (pointGrouping > 0) {
    decimalSeparator = ',';
    evidence = 'point_grouping';
  } else {
    // No separator anywhere ("1200", "-45"). The separators are then unused, and the default is
    // harmless rather than a guess with consequences — unlike the date ordering of §6.4, which is
    // why that one asks and this one does not.
    decimalSeparator = '.';
    evidence = 'none';
  }

  const thousandsSeparator: NumberFormat['thousandsSeparator'] = spaceThousands
    ? ' '
    : decimalSeparator === '.'
      ? (commaGrouping > 0 || bothPointLast > 0 ? ',' : '')
      : (pointGrouping > 0 || bothCommaLast > 0 ? '.' : '');

  const format: NumberFormat = { decimalSeparator, thousandsSeparator };
  let parsed = 0;
  let unparsed = 0;
  const unparsedSamples: string[] = [];
  const negativeStyles = new Set<NegativeStyle>();
  for (const cell of present) {
    const result = parseAmount(cell, { format });
    if (result.ok && result.amount !== null) {
      parsed += 1;
      if (result.negativeStyle !== null) negativeStyles.add(result.negativeStyle);
    } else if (!result.ok) {
      unparsed += 1;
      if (unparsedSamples.length < 5) unparsedSamples.push(cell);
    }
  }

  const currencyList = [...currencies].sort();
  return {
    ...format,
    evidence,
    total: present.length,
    parsed,
    unparsed,
    unparsedSamples,
    currencies: currencyList,
    currency: currencyList.length === 1 ? (currencyList[0] as string) : null,
    negativeStyles: [...negativeStyles],
    spaceThousands,
  };
}
