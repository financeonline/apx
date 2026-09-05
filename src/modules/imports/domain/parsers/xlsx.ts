/**
 * XLSX parser (IMPORT_ENGINE.md §5.2, ADR-033).
 *
 * Pure: bytes in, `ParsedTable` out. No I/O, no clock, no database.
 *
 * The governing rule is SOW §23 — nothing a customer uploaded is silently discarded. Every
 * non-empty source row becomes a `ParsedRow`, including the preamble above the header (marked
 * `nonTabular`, recorded later as `IMP-ROW-005`) and rows the workbook hides (`hidden`,
 * `IMP-ROW-003`). `rows.length` therefore equals the number of non-empty rows in the chosen sheet,
 * which is the row-count invariant asserted in `TEST_STRATEGY.md §5.2`.
 *
 * Two deliberate properties, both of which quietly move money when they are wrong:
 *
 *  1. **Cached values only, no formula evaluation.** A formula cell is read as its stored result.
 *     MOTION never recomputes a customer's spreadsheet; a workbook that says `=A1*2` with a cached
 *     `90000` imports 90000, because that is the figure the customer signed off.
 *  2. **Merged cells inherit for labels, never for amounts.** Excel stores a merged range's value
 *     in the top-left cell only. Copying that value down an amount column would duplicate money —
 *     silently, and in the customer's favour or against it at random. So the value is copied down
 *     only where the column is a label (description, account, reference…), and the remaining cells
 *     of the range stay `null`.
 *
 * NOTE ON THE READER (§5.2 says "streaming"). `exceljs@4.4.0`'s `stream.xlsx.WorkbookReader`
 * discards exactly the two things §5.2 requires in the same sentence: it ignores `<mergeCell>`
 * (`worksheet-reader.js` has an empty `case 'mergeCell'`) and never reads a row's `hidden`
 * attribute, because both arrive in the sheet XML after `<sheetData>`. Correct merged-cell and
 * hidden-row handling is a data-integrity requirement; "streaming" is a memory budget. This parser
 * therefore uses the full workbook reader, which preserves both, and keeps the normative half of
 * the sentence — cached values only, no formulas evaluated — exactly.
 */

import type { ParsedRow, ParsedTable, ParseWarning, TargetField } from '../pipeline-types';
import { Decimal } from '@/core/money';

/*
 * `exceljs@4.4.0` is CommonJS with `module.exports = ExcelJS`. Node's ESM loader cannot see its
 * named exports and hands the whole module over as `default`; Vite's interop spreads them onto the
 * namespace instead. Accepting both shapes keeps the parser working under `tsx`, under Next's
 * bundler and under vitest, rather than depending on one loader's interop rules.
 */
import * as exceljsNamespace from 'exceljs';

const ExcelJS =
  (exceljsNamespace as unknown as { default?: typeof exceljsNamespace }).default ?? exceljsNamespace;

// ---------------------------------------------------------------------------------------------
// The injected synonym matcher
// ---------------------------------------------------------------------------------------------

/**
 * Does this cell read as a column header (§6.2)?
 *
 * Injected so this parser stays pure and so `mapping/synonyms.ts` remains the single place the
 * synonym table lives; `isKnownHeader` satisfies it directly, and the CSV parser takes the same
 * primitive under the same name. The parser passes the RAW cell text: normalisation (lower-case,
 * strip punctuation, collapse spaces) belongs to the matcher, which owns the table the normalised
 * form has to agree with.
 */
export type HeaderCellMatcher = (rawCell: string) => boolean;

/**
 * Which target field a header names, for the merged-cell rule only (§5.2).
 *
 * `suggestColumns([cell])[0]?.target ?? null` satisfies it. It is OPTIONAL, and its absence means
 * no column inherits a merged value at all — which is the safe direction. A merged description that
 * fails to copy down leaves a blank cell the reviewer can see; a merged AMOUNT that copies down
 * duplicates money silently. The parser will not guess which kind of column it is looking at.
 */
export type HeaderTargetMatcher = (rawCell: string) => TargetField | null;

/**
 * The targets whose columns may inherit a merged range's value (§5.2: "label columns
 * (description/account), never for amounts").
 *
 * This is an allow-list, not a deny-list. A column whose header matched no synonym inherits
 * nothing, so a new target field added to `TargetField` can never start duplicating money by
 * accident — it has to be added here on purpose.
 */
const LABEL_TARGETS: ReadonlySet<TargetField> = new Set<TargetField>([
  'account', 'code', 'description', 'reference', 'journal_ref',
  'counterparty', 'customer', 'supplier', 'type', 'invoice_number', 'status', 'currency',
]);

// ---------------------------------------------------------------------------------------------
// Excel date serials
// ---------------------------------------------------------------------------------------------

/**
 * Excel's 1900 system pretends 1900 was a leap year (serial 60 = "29 Feb 1900"), so the epoch a
 * serial counts from depends on which side of that phantom day it falls.
 *
 * Serials ≤ 60 count from 1899-12-31 (serial 1 = 1900-01-01); serials > 60 count from 1899-12-30,
 * which is what absorbs the extra day. Serial 60 itself denotes a date that does not exist and
 * resolves here to 1900-03-01 — MOTION cannot store 1900-02-29, and no financial export in scope
 * reaches back to it.
 */
const EPOCH_1900_AFTER_PHANTOM_MS = Date.UTC(1899, 11, 30);
const EPOCH_1900_BEFORE_PHANTOM_MS = Date.UTC(1899, 11, 31);
/** The 1904 system (the old Mac default): serial 0 = 1904-01-01, no phantom day. */
const EPOCH_1904_MS = Date.UTC(1904, 0, 1);

const MS_PER_DAY = 86_400_000;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function formatUtc(date: Date, withTime: boolean): string {
  const day =
    `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
  if (!withTime) return day;
  return `${day}T${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
}

/**
 * Convert an Excel date serial to an ISO string, honouring the workbook's 1904 flag (§5.2).
 *
 * The flag is a whole-workbook setting, and the two systems are 1,462 days apart: reading a 1904
 * workbook as a 1900 one moves every date by just over four years, which is exactly the kind of
 * error that survives review because the day and month still look right.
 *
 * A serial with a fractional part carries a time of day and is returned as a full ISO timestamp;
 * a whole serial returns `YYYY-MM-DD`.
 */
export function excelSerialToIso(serial: number, date1904: boolean): string {
  const whole = Math.floor(serial);
  const fraction = serial - whole;
  const epoch = date1904
    ? EPOCH_1904_MS
    : whole > 60
      ? EPOCH_1900_AFTER_PHANTOM_MS
      : EPOCH_1900_BEFORE_PHANTOM_MS;
  // Round the time part to the nearest second: Excel stores 09:30 as 0.39583333…, and truncating
  // that would print 09:29:59.
  const timeMs = Math.round(fraction * MS_PER_DAY / 1000) * 1000;
  return formatUtc(new Date(epoch + whole * MS_PER_DAY + timeMs), timeMs !== 0);
}

/**
 * Does this number format make the cell a date?
 *
 * Quoted literals and `[...]` sections (colours, conditions, locale ids) are removed first, because
 * `[$-409]` and `"December"` both contain characters that would otherwise look like date tokens.
 * What remains is a date format if it uses any of Excel's date/time placeholders.
 */
function isDateNumberFormat(numFmt: string | undefined): boolean {
  if (!numFmt) return false;
  const bare = numFmt.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(bare);
}

// ---------------------------------------------------------------------------------------------
// Cell reading
// ---------------------------------------------------------------------------------------------

/** exceljs types a cell value as a broad union; the reader narrows it here rather than trusting it. */
type CellValue = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Turn one cell into the text `raw_data` keeps.
 *
 * Numbers go through `Decimal` rather than `String(n)`: the configured constructor never emits
 * exponential notation, so a 20-digit reference number or a very small rate stays readable and
 * stays parseable by the money layer downstream (ADR-006).
 */
function cellText(value: CellValue, numFmt: string | undefined, date1904: boolean): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // A numeric cell carrying a date format is a serial. exceljs usually converts these itself;
    // this branch catches the custom formats its own detector does not recognise, so the 1904 flag
    // is honoured either way.
    if (isDateNumberFormat(numFmt)) return excelSerialToIso(value, date1904);
    return new Decimal(value).toString();
  }
  if (value instanceof Date) {
    const hasTime =
      value.getUTCHours() !== 0 || value.getUTCMinutes() !== 0 || value.getUTCSeconds() !== 0;
    return formatUtc(value, hasTime);
  }
  if (!isRecord(value)) return null;

  // A formula cell is `{ formula, result }`. The result is the value Excel last CACHED — it is
  // read, never recomputed (§5.2). A workbook saved without cached results yields null, which the
  // reviewer sees as a blank cell rather than as a number MOTION invented.
  if ('result' in value) return cellText(value.result, numFmt, date1904);
  if ('error' in value && typeof value.error === 'string') return value.error;
  if ('richText' in value && Array.isArray(value.richText)) {
    return value.richText
      .map((run) => (isRecord(run) && typeof run.text === 'string' ? run.text : ''))
      .join('');
  }
  if ('text' in value && typeof value.text === 'string') return value.text;
  return null;
}

function isPopulated(text: string | null | undefined): text is string {
  return text !== null && text !== undefined && text.trim().length > 0;
}

// ---------------------------------------------------------------------------------------------
// Sheet selection (§5.2)
// ---------------------------------------------------------------------------------------------

interface SheetGrid {
  readonly name: string;
  /** `grid[rowIndex][colIndex]`, 0-based, dense, `null` where the cell is empty or a merge slave. */
  readonly grid: readonly (readonly (string | null)[])[];
  /** Source row numbers, 1-based, parallel to `grid`. */
  readonly rowNumbers: readonly number[];
  readonly hiddenRows: ReadonlySet<number>;
  /** Merge slaves keyed `row,col` (0-based) → the master's text. */
  readonly mergeMasterText: ReadonlyMap<string, string | null>;
  readonly populatedRows: number;
  readonly populatedColumns: number;
}

function key(row: number, col: number): string {
  return `${row},${col}`;
}

/**
 * Read one worksheet into a dense grid.
 *
 * Merge slaves are set to `null` here — exceljs reports a slave cell's value as the master's, which
 * is convenient for rendering and catastrophic for importing. What the master held is kept aside in
 * `mergeMasterText` so a label column can inherit it later, on purpose and column by column.
 */
function readSheet(
  worksheet: exceljsNamespace.Worksheet,
  date1904: boolean,
): SheetGrid {
  const lastRow = worksheet.rowCount;
  const lastCol = worksheet.columnCount;
  const grid: (string | null)[][] = [];
  const rowNumbers: number[] = [];
  const hiddenRows = new Set<number>();
  const mergeMasterText = new Map<string, string | null>();
  let populatedColumns = 0;

  for (let r = 1; r <= lastRow; r += 1) {
    const row = worksheet.getRow(r);
    const cells: (string | null)[] = [];
    let rowHasContent = false;

    for (let c = 1; c <= lastCol; c += 1) {
      const cell = row.getCell(c);
      const text = cellText(cell.value, cell.numFmt, date1904);
      const isSlave = cell.isMerged && cell.master.address !== cell.address;
      if (isSlave) {
        mergeMasterText.set(key(grid.length, c - 1), text);
        cells.push(null);
        continue;
      }
      cells.push(text);
      if (isPopulated(text)) {
        rowHasContent = true;
        if (c > populatedColumns) populatedColumns = c;
      }
    }

    // Empty rows are not source lines: there is nothing for a reviewer to account for, and Excel
    // manufactures them by the thousand below the last used cell.
    if (!rowHasContent) continue;
    grid.push(cells);
    rowNumbers.push(r);
    if (row.hidden) hiddenRows.add(r);
  }

  return {
    name: worksheet.name,
    grid,
    rowNumbers,
    hiddenRows,
    mergeMasterText,
    populatedRows: grid.length,
    populatedColumns,
  };
}

/**
 * Pick the sheet to parse (§5.2).
 *
 * One non-empty sheet → use it and say nothing. Otherwise the mapping step must ask, so every
 * non-empty sheet name is reported in `availableSheets`, and the parse proceeds on the documented
 * default — the first sheet with at least 2 rows and 3 columns — so the reviewer has something to
 * look at while they choose.
 */
function selectSheet(
  sheets: readonly SheetGrid[],
  requested: string | undefined,
): { readonly chosen: SheetGrid; readonly availableSheets?: readonly string[] } {
  const nonEmpty = sheets.filter((s) => s.populatedRows > 0);
  if (nonEmpty.length === 0) {
    const first = sheets[0];
    if (first === undefined) {
      throw new Error('The workbook contains no sheets.');
    }
    return { chosen: first };
  }

  const requestedSheet =
    requested === undefined ? undefined : nonEmpty.find((s) => s.name === requested);
  const tabular = nonEmpty.find((s) => s.populatedRows >= 2 && s.populatedColumns >= 3);
  const fallback = nonEmpty[0];
  if (fallback === undefined) throw new Error('The workbook contains no sheets.');
  const chosen = requestedSheet ?? tabular ?? fallback;

  if (nonEmpty.length === 1) return { chosen };
  return { chosen, availableSheets: nonEmpty.map((s) => s.name) };
}

// ---------------------------------------------------------------------------------------------
// Header detection (§5.2, same rule as CSV §5.1)
// ---------------------------------------------------------------------------------------------

/** §5.2: "the first row in which ≥ 3 populated cells match the synonyms table". */
export const DEFAULT_MIN_HEADER_MATCHES = 3;

interface HeaderChoice {
  /** 0-based index into the grid, or `undefined` when the sheet is headerless. */
  readonly index: number | undefined;
  readonly confirmationRequired: boolean;
}

/**
 * Find the header row.
 *
 * Detected: the first row in which at least three populated cells name a known target (§6.2).
 * Proposed: failing that, the first row whose populated cells are all non-numeric and distinct —
 * offered to the reviewer with `headerConfirmationRequired`, so a preamble line such as
 * `Account Name | Acme Ltd` can never become the header behind their back (F-B-18).
 *
 * The proposal needs the same three populated cells the detection rule does. F-B-18's own example
 * is a two-cell preamble line, and proposing it would put exactly the wrong row in front of the
 * reviewer as the one to confirm. A twelve-column P&L whose month headings match no synonym
 * (`Jan 2026`, `Feb 2026`, …) is the case this branch exists for.
 */
function detectHeader(
  grid: readonly (readonly (string | null)[])[],
  isHeaderCell: HeaderCellMatcher,
  minMatches: number,
): HeaderChoice {
  for (let i = 0; i < grid.length; i += 1) {
    const row = grid[i];
    if (row === undefined) continue;
    let matches = 0;
    for (const cell of row) {
      if (isPopulated(cell) && isHeaderCell(cell)) matches += 1;
    }
    if (matches >= minMatches) return { index: i, confirmationRequired: false };
  }

  for (let i = 0; i < grid.length; i += 1) {
    const row = grid[i];
    if (row === undefined) continue;
    const populated = row.filter(isPopulated).map((text) => text.trim());
    if (populated.length < minMatches) continue;
    const allText = populated.every((text) => !/^[+-]?[\d.,\s]+$/.test(text));
    const allUnique = new Set(populated.map((t) => t.toLowerCase())).size === populated.length;
    if (allText && allUnique) return { index: i, confirmationRequired: true };
  }

  return { index: undefined, confirmationRequired: true };
}

// ---------------------------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------------------------

export interface XlsxParseOptions {
  /** §6.2 header test, injected — `isKnownHeader` from `mapping/synonyms.ts`. */
  readonly isHeaderCell: HeaderCellMatcher;
  /** §5.2 merged-label rule, injected. Absent means nothing inherits (see `HeaderTargetMatcher`). */
  readonly headerTarget?: HeaderTargetMatcher;
  /** The sheet the reviewer chose (`transforms.sheet`, §6.4). Ignored when the name is unknown. */
  readonly sheet?: string;
  readonly minHeaderMatches?: number;
}

/**
 * Parse an XLSX workbook into a `ParsedTable` (§5.2).
 *
 * `sourceRef` is `sheet:{name}!row:{n}` with `n` the workbook's own row number (§13), not an index
 * into `rows` — so the evidence drawer opens the file at the line the reviewer is looking at even
 * when blank rows sit between the populated ones.
 */
export async function parseXlsx(
  bytes: Uint8Array,
  options: XlsxParseOptions,
): Promise<ParsedTable> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(toArrayBuffer(bytes));
  const date1904 = workbook.properties?.date1904 === true;

  const sheets = workbook.worksheets.map((worksheet) => readSheet(worksheet, date1904));
  const { chosen, availableSheets } = selectSheet(sheets, options.sheet);

  const header = detectHeader(
    chosen.grid,
    options.isHeaderCell,
    options.minHeaderMatches ?? DEFAULT_MIN_HEADER_MATCHES,
  );
  const headerCells = header.index === undefined ? undefined : chosen.grid[header.index];
  const columnCount = Math.max(chosen.populatedColumns, headerCells?.length ?? 0);

  const columns: string[] = [];
  for (let c = 0; c < columnCount; c += 1) {
    const raw = headerCells?.[c];
    columns.push(isPopulated(raw) ? raw.trim() : `col_${c + 1}`);
  }

  // Which columns may inherit a merged value. Only a column whose header names a label target
  // qualifies; every amount, balance and date column is left alone (§5.2).
  const headerTarget = options.headerTarget;
  const inheritable: boolean[] = columns.map((_name, c) => {
    if (header.index === undefined || headerTarget === undefined) return false;
    const raw = headerCells?.[c];
    if (!isPopulated(raw)) return false;
    const target = headerTarget(raw);
    return target !== null && LABEL_TARGETS.has(target);
  });

  const rows: ParsedRow[] = [];
  let hiddenCount = 0;

  for (let i = 0; i < chosen.grid.length; i += 1) {
    const source = chosen.grid[i];
    const rowNumber = chosen.rowNumbers[i];
    if (source === undefined || rowNumber === undefined) continue;

    const cells: (string | null)[] = [];
    for (let c = 0; c < columnCount; c += 1) {
      const own = source[c] ?? null;
      if (own !== null) {
        cells.push(own);
        continue;
      }
      // A merge slave inherits only where the column is a label. Everywhere else it stays null,
      // which is the whole point: an amount is never repeated down a merged range.
      const inherited = inheritable[c] === true ? chosen.mergeMasterText.get(key(i, c)) : undefined;
      cells.push(inherited ?? null);
    }

    const hidden = chosen.hiddenRows.has(rowNumber);
    if (hidden) hiddenCount += 1;

    // Everything above the header is page furniture, not data. It is kept as a row so the reviewer
    // can see what MOTION did with it (`IMP-ROW-005`), which is what makes the row count add up.
    const nonTabular = header.index !== undefined && i < header.index;

    rows.push({
      rowNumber,
      sourceRef: `sheet:${chosen.name}!row:${rowNumber}`,
      cells,
      ...(nonTabular ? { nonTabular: true } : {}),
      ...(hidden ? { hidden: true } : {}),
    });
  }

  const warnings: ParseWarning[] = [];
  if (hiddenCount > 0) {
    warnings.push({
      code: 'IMP-ROW-003',
      message:
        `${hiddenCount} hidden ${hiddenCount === 1 ? 'row was' : 'rows were'} imported from ` +
        `"${chosen.name}". Check that they belong in this import.`,
    });
  }

  return {
    sheet: chosen.name,
    ...(header.index === undefined ? {} : { headerRow: header.index + 1 }),
    columns,
    ...(header.confirmationRequired ? { headerConfirmationRequired: true } : {}),
    rows,
    warnings,
    ...(availableSheets === undefined ? {} : { availableSheets }),
  };
}

/**
 * exceljs reads from an `ArrayBuffer`. A `Uint8Array` may be a view onto a larger buffer (it is,
 * whenever it came from a Node `Buffer` pool), so the view's own window is copied out rather than
 * handing over whatever else shares the allocation.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
