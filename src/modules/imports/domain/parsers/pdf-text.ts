/**
 * PDF text-layer deterministic parser (IMPORT_ENGINE.md §5.3, ADR-033, ADR-046.3, R2-C-11).
 *
 * Pure: bytes in, `ParsedTable` out. No I/O, no clock, no database.
 *
 * Rows this parser produces are `assurance_level = calculated`, never `verified`: positional
 * parsing is a heuristic over ink on a page, and a column boundary drawn 3 pt to the left changes
 * which figure is a payment. They are promoted to `verified` at commit only when `IMP-BAL-006`
 * passes with both statement balances captured and an unbroken `balance_after` chain (ADR-033);
 * that promotion is enforced elsewhere, not here.
 *
 * ── The balance-capture rule is a security control, not a convenience ────────────────────────
 *
 * `IMP-BAL-006` is the gate that stops a hallucinated or hostile statement from being committed,
 * and the only balances it trusts are the ones captured here or typed by a reviewer from the page
 * image (ADR-033, ADR-046.3). A document that could talk this parser into reading a balance off a
 * line the author controls would have defeated the gate. So:
 *
 *   • A candidate is ONLY a line that sits OUTSIDE the transaction grid — its date column is empty
 *     and it is not a continuation of the description above it. A line with a date in the date
 *     column is a TRANSACTION, whatever its words say: "CLOSING COSTS SOLICITOR £2,300.00" is a
 *     payment to a solicitor, not a closing balance (fixture 24).
 *   • Opening is the FIRST matching candidate in document order and closing is the LAST, so a line
 *     inserted later in the document cannot displace the real opening balance, and a line inserted
 *     earlier cannot displace the real closing one.
 *
 * Nothing is discarded by tolerance (SOW §23). Every non-empty line on every page becomes a row:
 * transactions carry their cells, everything else is kept verbatim and marked `nonTabular`, which
 * the pipeline records as `IMP-ROW-005`.
 */

import type {
  ParsedRow,
  ParsedTable,
  ParseWarning,
  StatementMetadata,
} from '../pipeline-types';
import { Decimal, toMoneyString } from '@/core/money';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-expect-error -- pdf.js ships no types for its worker module; only `WorkerMessageHandler` is used.
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

/*
 * pdf.js on a server runs its "worker" in the same thread, and finds it by `import()`-ing
 * `pdf.worker.mjs` next to its own file. Bundled into a server chunk (Next/Turbopack), that file is
 * not there, and every PDF statement failed with "Setting up fake worker failed". pdf.js looks for
 * `globalThis.pdfjsWorker` first, so the worker is handed to it here and nothing is fetched at run time.
 */
const workerHost = globalThis as { pdfjsWorker?: unknown };
workerHost.pdfjsWorker ??= pdfjsWorker;

// ---------------------------------------------------------------------------------------------
// Tokenising (§5.3: per-page text with positional data; lines grouped by y within 2 pt)
// ---------------------------------------------------------------------------------------------

/** §5.3: "Group tokens into lines by y (tolerance 2 pt)." */
const LINE_Y_TOLERANCE_PT = 2;

export interface PdfToken {
  readonly text: string;
  /** PDF user space: x grows rightwards, y grows UPWARDS from the bottom of the page. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

export interface PdfLine {
  /** 1-based within the page, in reading order (top to bottom). Half of `page:{p};line:{l}` (§13). */
  readonly lineNumber: number;
  readonly y: number;
  readonly tokens: readonly PdfToken[];
  /** The tokens joined left to right — the verbatim text of the line. */
  readonly text: string;
}

export interface PdfPageTokens {
  readonly pageNumber: number;
  readonly lines: readonly PdfLine[];
  /** §5.4 `IMP-PDF-002`: lines whose leading tokens are a date, counted without any grammar. */
  readonly dateLineCount: number;
}

export interface PdfDocumentTokens {
  readonly pages: readonly PdfPageTokens[];
  /** False when no page produced a single non-blank token — a scanned PDF (§5.5). */
  readonly hasTextLayer: boolean;
}

/**
 * The date shapes §6.4 lists, as anchored patterns.
 *
 * `IMP-PDF-002` compares the number of date-bearing lines with the number of rows an AI extraction
 * produced, so this set has to be the same one the transform layer recognises — a narrower set here
 * would understate the line count and let a model drop rows unnoticed.
 */
const DATE_PATTERNS: readonly RegExp[] = [
  /^\d{4}-\d{2}-\d{2}$/,                               // ISO: 2026-03-14
  /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/,                 // day-first or month-first: 14/03/2026
  /^\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4}$/,            // 14 Mar 2026
  /^\d{1,2}\s+[A-Za-z]{3,9}\.?$/,                      // 14 Mar (year from the statement period)
];

function looksLikeDate(text: string): boolean {
  const trimmed = text.trim();
  return DATE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Does this line START with a date (§5.4: "a line whose first token, after positional grouping,
 * matches one of the §6.4 date patterns")?
 *
 * A PDF may emit `14 Mar 2026` as one text item or as three, depending on how the producer laid out
 * the glyph runs, so the leading one, two and three tokens are each tried. Reading only the literal
 * first item would count `2026-03-14` and miss `14 Mar 2026`, and `IMP-PDF-002` would then be
 * comparing an undercount against the model's row count — in the model's favour.
 */
function startsWithDate(line: PdfLine): boolean {
  for (let width = 1; width <= 3 && width <= line.tokens.length; width += 1) {
    const joined = line.tokens.slice(0, width).map((t) => t.text).join(' ');
    if (looksLikeDate(joined)) return true;
  }
  return false;
}

/**
 * Read every page's text layer and group it into lines.
 *
 * pdf.js synthesises whitespace-only items to represent the gaps between glyph runs; they carry no
 * source text (their reported height is 0) and are dropped. That is not discarding data — the gap
 * between two words is not a line a reviewer can be shown.
 */
export async function tokenisePdf(bytes: Uint8Array): Promise<PdfDocumentTokens> {
  const loadingTask = pdfjs.getDocument({
    // pdf.js TRANSFERS the buffer it is given and leaves the caller's `Uint8Array` detached, so a
    // second read of the same bytes would throw. A parser that quietly destroys its own input is
    // not pure, so it gets a copy.
    data: new Uint8Array(bytes),
    // The parser reads text; it never renders the document, so no canvas, no images and no system
    // font lookups. `verbosity: 0` keeps pdf.js's own warnings (missing standard font data, which
    // only matters for rendering) out of the import logs.
    useSystemFonts: false,
    verbosity: 0,
  });

  try {
    const pdf = await loadingTask.promise;
    const pages: PdfPageTokens[] = [];
    let hasTextLayer = false;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const tokens: PdfToken[] = [];

      for (const item of content.items) {
        if (!('str' in item)) continue;
        if (item.str.trim().length === 0) continue;
        const transform = item.transform;
        const x = transform[4];
        const y = transform[5];
        if (typeof x !== 'number' || typeof y !== 'number') continue;
        tokens.push({ text: item.str, x, y, width: item.width });
      }

      page.cleanup();
      if (tokens.length > 0) hasTextLayer = true;
      const lines = groupIntoLines(tokens);
      pages.push({
        pageNumber,
        lines,
        dateLineCount: lines.filter(startsWithDate).length,
      });
    }

    return { pages, hasTextLayer };
  } finally {
    await loadingTask.destroy();
  }
}

function groupIntoLines(tokens: readonly PdfToken[]): readonly PdfLine[] {
  // Top of the page first (y descends), then left to right.
  const ordered = [...tokens].sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines: PdfLine[] = [];
  let current: PdfToken[] = [];
  let baseline = Number.NaN;

  const flush = (): void => {
    if (current.length === 0) return;
    const sorted = [...current].sort((a, b) => a.x - b.x);
    const first = sorted[0];
    if (first === undefined) return;
    lines.push({
      lineNumber: lines.length + 1,
      y: first.y,
      tokens: sorted,
      text: sorted.map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim(),
    });
    current = [];
  };

  for (const token of ordered) {
    if (current.length === 0 || Math.abs(token.y - baseline) <= LINE_Y_TOLERANCE_PT) {
      if (current.length === 0) baseline = token.y;
      current.push(token);
      continue;
    }
    flush();
    baseline = token.y;
    current.push(token);
  }
  flush();
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Money tokens (§6.4 negative styles)
// ---------------------------------------------------------------------------------------------

const PLAIN_NUMBER = /^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^\d+(?:\.\d{1,2})?$/;

/**
 * Read one token as money, or return null.
 *
 * A bare integer is deliberately NOT money: a statement is full of years, page numbers and sort
 * codes, and treating `2026` as a balance is how "Statement for 2026" becomes an opening balance of
 * £2,026. A money token must carry a decimal point, a thousands separator or a currency symbol.
 *
 * `DR` means overdrawn on a UK statement and `CR` means in credit, so `DR` is the negative one;
 * `(123.45)`, `123.45-` and `-123.45` are the other three negative styles §6.4 lists.
 */
export function parseMoneyToken(raw: string): string | null {
  let body = raw.trim();
  if (body.length === 0) return null;

  let negative = false;
  if (body.startsWith('(') && body.endsWith(')')) {
    negative = true;
    body = body.slice(1, -1).trim();
  }
  const suffix = /\s*(CR|DR)$/i.exec(body);
  if (suffix?.[1] !== undefined) {
    if (suffix[1].toUpperCase() === 'DR') negative = true;
    body = body.slice(0, suffix.index).trim();
  }
  if (body.endsWith('-')) {
    negative = true;
    body = body.slice(0, -1).trim();
  }
  if (body.startsWith('-')) {
    negative = true;
    body = body.slice(1).trim();
  } else if (body.startsWith('+')) {
    body = body.slice(1).trim();
  }

  const hadCurrency = /^[£$€]/.test(body);
  if (hadCurrency) body = body.slice(1).trim();
  if (!PLAIN_NUMBER.test(body)) return null;
  if (!hadCurrency && !body.includes('.') && !body.includes(',')) return null;

  const value = new Decimal(body.replace(/,/g, ''));
  return toMoneyString(negative ? value.negated() : value);
}

// ---------------------------------------------------------------------------------------------
// The column grid: grammars G1, G2, G3 (§5.3)
// ---------------------------------------------------------------------------------------------

type ColumnRole = 'date' | 'type' | 'description' | 'paid_out' | 'paid_in' | 'amount' | 'balance';

const ROLE_PATTERNS: readonly (readonly [ColumnRole, RegExp])[] = [
  ['date', /^(?:(?:transaction|posting|value|entry)\s+)?date$/],
  ['type', /^type$/],
  ['description', /^(?:description|details|narrative|particulars|payee|transaction description)$/],
  ['paid_out', /^(?:paid out|money out|withdrawals?|withdrawn|debits?)$/],
  ['paid_in', /^(?:paid in|money in|deposits?|credits?)$/],
  ['amount', /^(?:amount|value)$/],
  ['balance', /^(?:balance|running balance)$/],
];

/** The three known layouts (§5.3). G3 is G1 with a `TYPE` column between date and description. */
const GRAMMARS: readonly { readonly name: string; readonly roles: readonly ColumnRole[] }[] = [
  { name: 'G1', roles: ['date', 'description', 'paid_out', 'paid_in', 'balance'] },
  { name: 'G2', roles: ['date', 'description', 'amount', 'balance'] },
  { name: 'G3', roles: ['date', 'type', 'description', 'paid_out', 'paid_in', 'balance'] },
];

function normaliseLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

interface ColumnSpan {
  readonly role: ColumnRole;
  readonly label: string;
  readonly start: number;
  readonly end: number;
}

interface ColumnGrid {
  readonly grammar: string;
  readonly spans: readonly ColumnSpan[];
  /** x values separating column i from column i+1; `spans.length - 1` of them. */
  readonly boundaries: readonly number[];
}

/**
 * Read a line as a header row, or return null.
 *
 * Header labels are matched with a sliding window of up to three tokens, because "PAID OUT" may
 * arrive as one item or as two depending on the producer. Tokens that match nothing are skipped —
 * a header line often carries a currency note or a page number alongside the labels — but the
 * sequence of roles that DID match has to equal one of the three grammars exactly, so a body line
 * cannot become a header by accident.
 */
function readHeader(line: PdfLine): ColumnGrid | null {
  const spans: ColumnSpan[] = [];
  let i = 0;
  while (i < line.tokens.length) {
    let matched = false;
    for (let width = Math.min(3, line.tokens.length - i); width >= 1; width -= 1) {
      const window = line.tokens.slice(i, i + width);
      const first = window[0];
      const last = window[window.length - 1];
      if (first === undefined || last === undefined) continue;
      const label = normaliseLabel(window.map((t) => t.text).join(' '));
      const role = ROLE_PATTERNS.find(([, pattern]) => pattern.test(label))?.[0];
      if (role === undefined) continue;
      spans.push({
        role,
        label: window.map((t) => t.text).join(' '),
        start: first.x,
        end: last.x + last.width,
      });
      i += width;
      matched = true;
      break;
    }
    if (!matched) i += 1;
  }

  const roles = spans.map((s) => s.role);
  const grammar = GRAMMARS.find(
    (g) => g.roles.length === roles.length && g.roles.every((role, index) => roles[index] === role),
  );
  if (grammar === undefined) return null;

  // Column boundaries sit halfway between the end of one header label and the start of the next.
  // Money columns are right-aligned under a left-aligned label, so anchoring on the label's start
  // alone would push every amount into the column to its left.
  const boundaries: number[] = [];
  for (let s = 0; s < spans.length - 1; s += 1) {
    const left = spans[s];
    const right = spans[s + 1];
    if (left === undefined || right === undefined) continue;
    boundaries.push((left.end + right.start) / 2);
  }
  return { grammar: grammar.name, spans, boundaries };
}

/** Which column a token belongs to, decided on its midpoint. */
function columnOf(token: PdfToken, grid: ColumnGrid): number {
  const midpoint = token.x + token.width / 2;
  for (let i = 0; i < grid.boundaries.length; i += 1) {
    const boundary = grid.boundaries[i];
    if (boundary !== undefined && midpoint <= boundary) return i;
  }
  return grid.spans.length - 1;
}

function cellsFor(line: PdfLine, grid: ColumnGrid): (string | null)[] {
  const buckets: string[][] = grid.spans.map(() => []);
  for (const token of line.tokens) {
    buckets[columnOf(token, grid)]?.push(token.text);
  }
  return buckets.map((parts) => (parts.length === 0 ? null : parts.join(' ')));
}

// ---------------------------------------------------------------------------------------------
// Statement metadata (§5.3)
// ---------------------------------------------------------------------------------------------

/** ADR-046.3: opening is the FIRST match among candidates, in document order. */
const OPENING_PATTERN = /(opening|start(ing)? balance|balance brought forward|b\/f)/i;
/** ADR-046.3: closing is the LAST match among candidates, in document order. */
const CLOSING_PATTERN = /(closing|end(ing)? balance|balance carried forward|c\/f)/i;

const BROUGHT_FORWARD_PATTERN = /(brought forward|b\/f)/i;
const CARRIED_FORWARD_PATTERN = /(carried forward|c\/f)/i;

/** §5.3, verbatim. */
const PERIOD_PATTERN = /(\d{1,2}\s\w+\s\d{4})\s*(to|-|–)\s*(\d{1,2}\s\w+\s\d{4})/;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** `1 March 2026` → `2026-03-01`. Returns null when the month word is not a month. */
function toIsoDate(text: string): string | null {
  const parts = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(text.trim());
  if (parts === null) return null;
  const [, day, monthWord, year] = parts;
  if (day === undefined || monthWord === undefined || year === undefined) return null;
  const month = MONTHS[monthWord.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  return `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * The money a balance line states.
 *
 * Preference runs right to left across the grid — the balance column, then the amount column, then
 * the last money token anywhere on the line — because a footer sometimes prints its figure inside
 * the description block rather than under `BALANCE`.
 */
function balanceValueOf(line: PdfLine, grid: ColumnGrid): string | null {
  const cells = cellsFor(line, grid);
  const preferred: ColumnRole[] = ['balance', 'amount'];
  for (const role of preferred) {
    const index = grid.spans.findIndex((span) => span.role === role);
    if (index < 0) continue;
    const cell = cells[index];
    if (cell === null || cell === undefined) continue;
    const money = parseMoneyToken(cell);
    if (money !== null) return money;
  }
  for (let i = line.tokens.length - 1; i >= 0; i -= 1) {
    const token = line.tokens[i];
    if (token === undefined) continue;
    const money = parseMoneyToken(token.text);
    if (money !== null) return money;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------------------------

/** §5.3: below this share of matching lines the deterministic parser yields nothing. */
const GRAMMAR_MATCH_THRESHOLD = 0.8;

export type PdfTextParseFailure =
  /** No page has a text layer — §5.5, `source_documents.status = 'unreadable'`. */
  | 'no_text_layer'
  /** No line on any page is a G1/G2/G3 header. */
  | 'no_grammar_match'
  /** A grammar was found but fewer than 80% of the first transaction page's lines matched it. */
  | 'below_match_threshold';

export type PdfTextParseResult =
  | { readonly ok: true; readonly table: ParsedTable }
  | {
      readonly ok: false;
      readonly reason: PdfTextParseFailure;
      /**
       * Still populated on failure. `IMP-PDF-002` runs on the AI path — which only exists BECAUSE
       * this parse failed — and compares its `dateLineCounts` with the model's row counts, so the
       * count must not depend on the parse that did not happen (ADR-033).
       */
      readonly statement: StatementMetadata;
      readonly warnings: readonly ParseWarning[];
    };

/**
 * Parse a text-layer PDF bank statement (§5.3).
 *
 * `sourceRef` is `page:{p};line:{l}` (§13), which the evidence drawer resolves to a highlighted
 * line on the page image.
 */
export async function parsePdfText(bytes: Uint8Array): Promise<PdfTextParseResult> {
  const document = await tokenisePdf(bytes);
  const dateLineCounts: Record<number, number> = {};
  for (const page of document.pages) dateLineCounts[page.pageNumber] = page.dateLineCount;

  if (!document.hasTextLayer) {
    return { ok: false, reason: 'no_text_layer', statement: { dateLineCounts }, warnings: [] };
  }

  // The first header line anywhere in the document defines the grid for the whole statement.
  let grid: ColumnGrid | null = null;
  let headerPage = 0;
  let headerLine = 0;
  for (const page of document.pages) {
    for (const line of page.lines) {
      const candidate = readHeader(line);
      if (candidate === null) continue;
      grid = candidate;
      headerPage = page.pageNumber;
      headerLine = line.lineNumber;
      break;
    }
    if (grid !== null) break;
  }

  if (grid === null) {
    return { ok: false, reason: 'no_grammar_match', statement: { dateLineCounts }, warnings: [] };
  }

  const dateColumn = grid.spans.findIndex((span) => span.role === 'date');
  const descriptionColumn = grid.spans.findIndex((span) => span.role === 'description');

  interface Classified {
    readonly page: number;
    readonly line: PdfLine;
    readonly kind: 'header' | 'transaction' | 'continuation' | 'other';
  }
  const classified: Classified[] = [];

  for (const page of document.pages) {
    let sawTransaction = false;
    for (const line of page.lines) {
      const isHeader = readHeader(line) !== null;
      if (isHeader) {
        classified.push({ page: page.pageNumber, line, kind: 'header' });
        continue;
      }
      const cells = cellsFor(line, grid);
      const dateCell = dateColumn >= 0 ? cells[dateColumn] ?? null : null;

      if (dateCell !== null && looksLikeDate(dateCell)) {
        sawTransaction = true;
        classified.push({ page: page.pageNumber, line, kind: 'transaction' });
        continue;
      }

      // A continuation is a line with NO date and text only in the description column, following a
      // transaction on the same page. Every other date-less line sits outside the grid.
      const onlyDescription =
        descriptionColumn >= 0 &&
        cells.every((cell, index) => cell === null || index === descriptionColumn);
      if (dateCell === null && onlyDescription && sawTransaction) {
        classified.push({ page: page.pageNumber, line, kind: 'continuation' });
        continue;
      }

      classified.push({ page: page.pageNumber, line, kind: 'other' });
    }
  }

  // §5.3: below 80% of the FIRST transaction page's lines matching the grammar, give up cleanly and
  // let the batch fall through to §5.4 rather than publishing a table nobody can trust.
  const firstPageLines = classified.filter((entry) => entry.page === headerPage);
  const matched = firstPageLines.filter((entry) => entry.kind !== 'other').length;
  const ratio = firstPageLines.length === 0 ? 0 : matched / firstPageLines.length;
  if (ratio < GRAMMAR_MATCH_THRESHOLD) {
    return {
      ok: false,
      reason: 'below_match_threshold',
      statement: { dateLineCounts },
      warnings: [],
    };
  }

  // ── Balance capture ─────────────────────────────────────────────────────────────────────────
  // Candidates are the `other` lines and nothing else: a transaction line is never a candidate,
  // however its description reads, and a continuation belongs to the transaction above it.
  const pageBalances: Record<number, { broughtForward?: string; carriedForward?: string }> = {};
  let openingBalance: string | undefined;
  let closingBalance: string | undefined;

  for (const entry of classified) {
    if (entry.kind !== 'other') continue;
    const text = entry.line.text;
    const money = balanceValueOf(entry.line, grid);
    if (money === null) continue;

    if (openingBalance === undefined && OPENING_PATTERN.test(text)) openingBalance = money;
    if (CLOSING_PATTERN.test(text)) closingBalance = money;

    const perPage = pageBalances[entry.page] ?? {};
    if (BROUGHT_FORWARD_PATTERN.test(text) && perPage.broughtForward === undefined) {
      perPage.broughtForward = money;
    }
    if (CARRIED_FORWARD_PATTERN.test(text)) perPage.carriedForward = money;
    pageBalances[entry.page] = perPage;
  }

  const warnings: ParseWarning[] = [];

  // Continuity: page N's carried forward must be page N+1's brought forward (§5.3, `IMP-BAL-006`).
  const pageNumbers = document.pages.map((page) => page.pageNumber);
  for (let i = 0; i < pageNumbers.length - 1; i += 1) {
    const from = pageNumbers[i];
    const to = pageNumbers[i + 1];
    if (from === undefined || to === undefined) continue;
    const carried = pageBalances[from]?.carriedForward;
    const brought = pageBalances[to]?.broughtForward;
    if (carried === undefined || brought === undefined) continue;
    if (new Decimal(carried).minus(brought).abs().greaterThan('0.01')) {
      warnings.push({
        code: 'IMP-BAL-006',
        message:
          `The running balance breaks between page ${from} and page ${to}: page ${from} carries ` +
          `forward ${carried} but page ${to} brings forward ${brought}.`,
      });
    }
  }

  // §5.3: a statement whose balances could not be captured is unreconciled, and the warning is
  // inherited into cash `data_quality` — the reviewer can still type the printed figures in.
  if (openingBalance === undefined || closingBalance === undefined) {
    warnings.push({
      code: 'IMP-BAL-007',
      message:
        'The opening and closing balances printed on this statement could not be read. ' +
        'Type them into the batch header to reconcile it.',
    });
  }

  // Statement period (§5.3).
  let periodStart: string | undefined;
  let periodEnd: string | undefined;
  for (const page of document.pages) {
    const match = PERIOD_PATTERN.exec(page.lines.map((line) => line.text).join('\n'));
    if (match?.[1] === undefined || match[3] === undefined) continue;
    const from = toIsoDate(match[1]);
    const to = toIsoDate(match[3]);
    if (from === null || to === null) continue;
    periodStart = from;
    periodEnd = to;
    break;
  }

  // ── Rows ────────────────────────────────────────────────────────────────────────────────────
  const rows: ParsedRow[] = [];
  let headerRow: number | undefined;
  let lastTransactionIndex = -1;

  for (const entry of classified) {
    const sourceRef = `page:${entry.page};line:${entry.line.lineNumber}`;
    const rowNumber = rows.length + 1;
    const isDefiningHeader =
      entry.kind === 'header' && entry.page === headerPage && entry.line.lineNumber === headerLine;

    if (entry.kind === 'transaction') {
      rows.push({ rowNumber, sourceRef, cells: cellsFor(entry.line, grid) });
      lastTransactionIndex = rows.length - 1;
      continue;
    }

    if (isDefiningHeader) {
      headerRow = rowNumber;
      rows.push({ rowNumber, sourceRef, cells: cellsFor(entry.line, grid) });
      continue;
    }

    if (entry.kind === 'continuation' && lastTransactionIndex >= 0 && descriptionColumn >= 0) {
      // §5.3: a wrapped description is appended to the transaction above it. The line is ALSO kept
      // as its own row — ADR-033 requires every non-empty source line to become a row, and a
      // reviewer counting lines against `import_rows` must find them equal. The duplicated text
      // imports nothing: this row is `nonTabular` and will be skipped as `IMP-ROW-005`.
      const previous = rows[lastTransactionIndex];
      if (previous !== undefined) {
        const cells = [...previous.cells];
        const existing = cells[descriptionColumn];
        cells[descriptionColumn] =
          existing === null || existing === undefined
            ? entry.line.text
            : `${existing} ${entry.line.text}`;
        rows[lastTransactionIndex] = { ...previous, cells };
      }
    }

    // Everything else — page furniture, repeated headers, footers, marketing text and the
    // continuation copy above — is kept verbatim in the first cell so the reviewer sees exactly
    // what was on the page (`IMP-ROW-005`).
    const cells: (string | null)[] = grid.spans.map(() => null);
    cells[0] = entry.line.text;
    rows.push({ rowNumber, sourceRef, cells, nonTabular: true });
  }

  const statement: StatementMetadata = {
    ...(openingBalance === undefined ? {} : { openingBalance }),
    ...(closingBalance === undefined ? {} : { closingBalance }),
    ...(periodStart === undefined ? {} : { periodStart }),
    ...(periodEnd === undefined ? {} : { periodEnd }),
    pageBalances,
    dateLineCounts,
  };

  return {
    ok: true,
    table: {
      sheet: `page:${headerPage}`,
      ...(headerRow === undefined ? {} : { headerRow }),
      columns: grid.spans.map((span) => span.label),
      rows,
      statement,
      warnings,
    },
  };
}
