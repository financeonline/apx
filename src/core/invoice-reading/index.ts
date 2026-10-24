import { Decimal, add, compare, abs, subtract, toMoneyString } from '@/core/money';

/**
 * Reads an invoice's fields out of its text (ADR-175).
 *
 * The text comes from the browser: a PDF's own text layer, or Tesseract's OCR of a photo or scan.
 * Nothing here is trusted. Every field is a PROPOSAL that fills the form the reviewer checks and
 * corrects before anything is uploaded — the rules below only save typing. A field the rules cannot
 * find is left empty rather than guessed, and every value worked out from others says so in `notes`.
 *
 * Pure and dependency-free (apart from money arithmetic) so it runs in the browser and in unit tests.
 */

export type InvoiceReadingSide = 'sales' | 'purchase';

export interface InvoiceReading {
  readonly invoiceNumber: string | null;
  /** The customer on a sales invoice, the supplier on a purchase invoice. */
  readonly counterparty: string | null;
  /** ISO dates, `YYYY-MM-DD`. */
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  /** Money strings with two decimals, positive. */
  readonly subtotal: string | null;
  readonly taxAmount: string | null;
  readonly total: string | null;
  readonly currency: string | null;
  /** Plain sentences telling the reviewer what to look at. */
  readonly notes: readonly string[];
}

export interface ReadInvoiceOptions {
  readonly side: InvoiceReadingSide;
  /** The company's own name, so it is never proposed as its own customer or supplier. */
  readonly ownName?: string;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d > last ? null : `${y}-${pad(m)}-${pad(d)}`;
}

const MONTH_WORD = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_PATTERNS: ReadonlyArray<{ re: RegExp; read: (m: RegExpExecArray) => string | null }> = [
  { re: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/, read: (m) => isoDate(+m[1]!, +m[2]!, +m[3]!) },
  // UK order: day first. A US-style 03/25/2026 fails the month check and is left for the reviewer.
  { re: /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/, read: (m) => isoDate(+m[3]!, +m[2]!, +m[1]!) },
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s.-]+(?:of\\s+)?${MONTH_WORD}\\.?,?[\\s.-]+(\\d{4}|\\d{2})\\b`, 'i'),
    read: (m) => isoDate(+m[3]!, MONTHS[m[2]!.slice(0, m[2]!.toLowerCase().startsWith('sept') ? 4 : 3).toLowerCase()]!, +m[1]!),
  },
  {
    re: new RegExp(`\\b${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'),
    read: (m) => isoDate(+m[3]!, MONTHS[m[1]!.slice(0, m[1]!.toLowerCase().startsWith('sept') ? 4 : 3).toLowerCase()]!, +m[2]!),
  },
];

/** The first real date in a piece of text, as ISO. */
export function findDate(text: string): string | null {
  let best: { at: number; iso: string } | null = null;
  for (const { re, read } of DATE_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const iso = read(m);
    if (iso !== null && (best === null || m.index < best.at)) best = { at: m.index, iso };
  }
  return best?.iso ?? null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Money amounts on a line: two decimals, thousands commas allowed, a percentage never counts. */
export function findAmounts(line: string): Decimal[] {
  const out: Decimal[] = [];
  const re = /(?<![\d.,])([-−]?)\(?\s*(?:[£€$]|GBP|EUR|USD)?\s*(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\)?(?![\d%])(?!\s*%)/g;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    out.push(new Decimal(`${m[2]!.replace(/,/g, '')}.${m[3]}`));
  }
  return out;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).map(clean).filter((l) => l.length > 0);
}

/** The amount a label line carries: the last amount on it, or the first on the next line when the label stands alone. */
function amountAfter(lines: readonly string[], i: number): Decimal | null {
  const own = findAmounts(lines[i]!);
  if (own.length > 0) return own[own.length - 1]!;
  const next = lines[i + 1];
  if (next !== undefined && lines[i]!.split(' ').length <= 4) return findAmounts(next)[0] ?? null;
  return null;
}

const SUBTOTAL = /\b(sub[\s-]?total|net\s+(?:total|amount|value)|total\s+net|(?:total|amount)\s+(?:ex|excl|excluding|before)\b|total\s+(?:ex|excl)\.?\s*vat|goods\s+total)\b|^net\b/i;
const VAT = /\b(vat|tax|gst)\b/i;
const VAT_NOT_AMOUNT = /\b(vat|tax)\s*(reg(istration)?|no\b|number|id\b|code)|\b(excl|excluding|ex|incl|including|inc)\.?\s*(vat|tax)\b/i;
const TOTAL_TIERS: readonly RegExp[] = [
  /\b(amount|balance|total)\s+(due|payable|owing|to\s+pay)\b|\bplease\s+pay\b/i,
  /\b(grand|invoice|gross)\s+total\b|\btotal\s+(amount|gross|inc|incl|including)\b/i,
  /\btotal\b/i,
];

function readTotals(lines: readonly string[]) {
  let subtotal: Decimal | null = null;
  let taxAmount: Decimal | null = null;
  let total: Decimal | null = null;
  let tier = TOTAL_TIERS.length;

  lines.forEach((line, i) => {
    if (SUBTOTAL.test(line)) {
      const v = amountAfter(lines, i);
      if (v !== null) subtotal = v;
      return;
    }
    if (VAT.test(line) && !VAT_NOT_AMOUNT.test(line) && !/\btotal\b/i.test(line.replace(/total\s+(vat|tax)/i, ''))) {
      const v = amountAfter(lines, i);
      if (v !== null) taxAmount = v;
      return;
    }
    const t = TOTAL_TIERS.findIndex((re) => re.test(line));
    if (t === -1 || t > tier) return;
    const v = amountAfter(lines, i);
    // The last line of the strongest kind wins: totals sit at the bottom, item columns above them.
    if (v !== null) { total = v; tier = t; }
  });
  return { subtotal: subtotal as Decimal | null, taxAmount: taxAmount as Decimal | null, total: total as Decimal | null };
}

const NUMBER_LABEL = /\b(?:invoice|inv|bill|document)\s*(?:no\.?|number|num|nr|#|ref(?:erence)?|id)\s*[:.#-]?\s*/i;
const NUMBER_VALUE = /^([A-Z0-9][A-Z0-9\-/_.]{0,30})/i;

function readInvoiceNumber(lines: readonly string[]): string | null {
  const ok = (v: string | undefined) => v !== undefined && /\d/.test(v) && findDate(v) === null ? v.replace(/[.\-/]+$/, '') : null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const label = NUMBER_LABEL.exec(line);
    if (label) {
      const rest = line.slice(label.index + label[0].length);
      const v = ok(NUMBER_VALUE.exec(rest)?.[1]) ?? (rest.trim() === '' ? ok(NUMBER_VALUE.exec(lines[i + 1] ?? '')?.[1]) : null);
      if (v !== null) return v;
    }
  }
  for (const line of lines) {
    const m = /\binvoice\s*[:#]?\s*([A-Z]{0,6}[-/]?\d[\w\-/]*)/i.exec(line);
    const v = ok(m?.[1]);
    if (v !== null) return v;
  }
  return null;
}

const DUE = /\b(due(\s+(date|by|on))?|payment\s+due|pay\s+by|payable\s+by)\b/i;
const ISSUE = /\b(invoice\s+date|issue\s+date|date\s+of\s+(issue|invoice)|tax\s*point|billing\s+date|dated|date)\b/i;

function readDates(lines: readonly string[]): { issueDate: string | null; dueDate: string | null; fromTerms: boolean } {
  let issueDate: string | null = null;
  let dueDate: string | null = null;
  const dateAt = (i: number) => findDate(lines[i]!) ?? (lines[i]!.split(' ').length <= 4 && lines[i + 1] ? findDate(lines[i + 1]!) : null);
  lines.forEach((line, i) => {
    if (dueDate === null && DUE.test(line)) dueDate = dateAt(i);
    else if (issueDate === null && ISSUE.test(line) && !DUE.test(line)) issueDate = dateAt(i);
  });
  if (issueDate === null) {
    for (const line of lines) {
      const d = findDate(line);
      if (d !== null && d !== dueDate) { issueDate = d; break; }
    }
  }
  let fromTerms = false;
  if (dueDate === null && issueDate !== null) {
    const terms = lines.map((l) => /\b(?:net|within|terms:?|payment\s+terms:?)\s*(\d{1,3})\s*days\b/i.exec(l)).find((m) => m);
    if (terms) { dueDate = addDays(issueDate, Number(terms[1])); fromTerms = true; }
  }
  return { issueDate, dueDate, fromTerms };
}

const COMPANY = /\b(ltd|limited|llp|plc|inc|llc|gmbh|co\.|company|group|services|trading|t\/a|partners|holdings|enterprises)\b/i;
const NOT_A_NAME = /\b(invoice|tax\s+invoice|statement|page\s+\d|date|vat|total|due|description|qty|quantity|amount|tel|phone|email|e-mail|www\.|http|account|sort\s+code|iban|bic|registered|company\s+(no|number|reg))\b|@|^\d/i;
const BILL_TO = /^(bill(?:ed)?\s+to|invoice\s+to|invoiced\s+to|sold\s+to|deliver(?:ed)?\s+to|customer|client|to)\b\s*:?\s*(.*)$/i;
const FROM = /^(from|supplier|seller|vendor|issued\s+by)\b\s*:?\s*(.*)$/i;

function labelledName(lines: readonly string[], re: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const rest = clean(m[2] ?? '').replace(/^[:\-–]\s*/, '');
    if (rest.length > 1 && !NOT_A_NAME.test(rest)) return rest;
    const next = lines[i + 1];
    if (next !== undefined && !NOT_A_NAME.test(next)) return next;
  }
  return null;
}

/**
 * A company name as it sits on its line. OCR joins text across columns, so "Acme Ltd   INVOICE" is
 * one line: a name with a legal suffix is cut just after the suffix.
 */
function companyName(line: string): string | null {
  const m = /^(.*?\b(?:ltd|limited|llp|plc|inc|llc|gmbh)\b\.?)/i.exec(line);
  const name = clean(m ? m[1]! : line);
  return COMPANY.test(name) && !NOT_A_NAME.test(name) && name.length <= 80 ? name : null;
}

function readCounterparty(lines: readonly string[], options: ReadInvoiceOptions): string | null {
  const own = options.ownName ? key(options.ownName) : '';
  const isOwn = (name: string) => own.length > 2 && (key(name).includes(own) || own.includes(key(name)));
  const billTo = labelledName(lines, BILL_TO);
  const from = labelledName(lines, FROM);
  const companies = lines.map(companyName).filter((n): n is string => n !== null);
  const isLabel = (l: string) => BILL_TO.test(l) || FROM.test(l);

  const pick = options.side === 'sales'
    ? [billTo, ...companies]
    : [from, ...companies.filter((c) => billTo === null || key(c) !== key(billTo)),
      // A supplier's name is usually the first words on its own invoice.
      ...lines.slice(0, 6).filter((l) => !NOT_A_NAME.test(l) && !isLabel(l) && /[a-z]{3}/i.test(l))];
  const name = pick.find((n): n is string => n !== null && n !== undefined && !isOwn(n));
  return name === undefined ? null : name.replace(/[,;]\s*$/, '').slice(0, 120);
}

function readCurrency(text: string): string | null {
  const counts: Array<[string, number]> = [
    ['GBP', (text.match(/£|\bGBP\b/g) ?? []).length],
    ['EUR', (text.match(/€|\bEUR\b/g) ?? []).length],
    ['USD', (text.match(/\$|\bUSD\b/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : null;
}

export function readInvoiceText(text: string, options: ReadInvoiceOptions): InvoiceReading {
  const lines = splitLines(text);
  const notes: string[] = [];
  let { subtotal, taxAmount, total } = readTotals(lines);

  if (total === null && subtotal !== null) {
    total = add(subtotal, taxAmount ?? 0);
    notes.push(taxAmount === null ? 'No total was found; the net amount is used as the total.' : 'No total was found; it is worked out as net plus VAT.');
  } else if (total !== null && subtotal === null && taxAmount !== null) {
    subtotal = subtract(total, taxAmount);
    notes.push('The net amount is worked out as the total minus VAT.');
  } else if (total !== null && subtotal !== null && taxAmount === null && compare(total, subtotal) > 0) {
    taxAmount = subtract(total, subtotal);
    notes.push('VAT is worked out as the total minus the net amount.');
  }
  if (total !== null && subtotal !== null && taxAmount !== null
    && compare(abs(subtract(add(subtotal, taxAmount), total)), new Decimal('0.01')) > 0) {
    notes.push('Net plus VAT does not equal the total. Check all three against the invoice.');
  }

  const { issueDate, dueDate, fromTerms } = readDates(lines);
  if (fromTerms) notes.push('The due date is worked out from the payment terms.');
  const reading: InvoiceReading = {
    invoiceNumber: readInvoiceNumber(lines),
    counterparty: readCounterparty(lines, options),
    issueDate,
    dueDate,
    subtotal: subtotal === null ? null : toMoneyString(subtotal),
    taxAmount: taxAmount === null ? null : toMoneyString(taxAmount),
    total: total === null ? null : toMoneyString(total),
    currency: readCurrency(text),
    notes,
  };
  const missing = [
    reading.invoiceNumber === null && 'invoice number',
    reading.counterparty === null && (options.side === 'sales' ? 'customer' : 'supplier'),
    reading.issueDate === null && 'invoice date',
    reading.total === null && 'total',
  ].filter((m): m is string => typeof m === 'string');
  if (missing.length > 0) notes.unshift(`Not found: ${missing.join(', ')}. Type ${missing.length === 1 ? 'it' : 'them'} in from the invoice.`);
  return reading;
}
