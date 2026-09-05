/**
 * The CSV parser — IMPORT_ENGINE.md §5.1.
 *
 * Pure: decoded text in, `ParsedTable` out. No I/O, no clock, no synonyms table of its own.
 *
 * Two properties matter more than anything else here, and both are tested directly:
 *
 *   1. **No line is discarded.** `rows.length` equals the number of non-empty source records.
 *      Preamble lines above the header come back as rows with `nonTabular: true`, which the service
 *      layer records as `import_rows` with status `skipped` and issue `IMP-ROW-005`; a row whose
 *      field count disagrees with the header comes back too, padded, never dropped and never
 *      shifted. That is SOW §23 and it is the reason `count(import_rows)` can be shown to a
 *      reviewer as an account of their file.
 *   2. **No line is silently promoted to a header.** A header is only taken when at least three of
 *      its cells match the column synonyms (§6.2). Otherwise the best candidate is *proposed* with
 *      `headerConfirmationRequired: true` and the mapping step asks (finding F-B-18) — so
 *      `Account Name,Acme Ltd` cannot quietly become the column names of a ledger.
 *
 * ### The injected synonym matcher
 *
 * `imports/domain/mapping/synonyms.ts` is owned elsewhere and is deliberately not imported here;
 * this parser stays pure and testable by taking the matcher as a parameter. The service layer is
 * where the two meet:
 *
 * ```ts
 * parseCsv(validation.text, {
 *   delimiter: validation.delimiter,
 *   isHeaderCell: (cell) => matchesSynonym(cell),   // preferred
 * });
 * ```
 *
 * `isHeaderCell` receives the **raw** cell text exactly as it appears in the file and is expected to
 * apply the §6.2 normalisation itself — that normalisation belongs with the table it is matched
 * against. If it is easier to hand over the table instead, pass `headerSynonyms` as an iterable of
 * ALREADY-NORMALISED synonym strings and this module will normalise each cell with
 * `normaliseHeaderCell` (§6.2: lowercase, strip punctuation, collapse spaces) before looking it up.
 * `isHeaderCell` wins when both are given.
 */
import type { ParsedRow, ParsedTable, ParseWarning } from '../pipeline-types';

/** §5.1: "the first line in which ≥ 3 cells match the synonyms table". */
export const DEFAULT_MIN_HEADER_MATCHES = 3;

/**
 * How far into the file the weaker "non-numeric and unique" proposal will look. A real header sits
 * above the data; proposing line 300 of a headerless export as its column names would be worse than
 * admitting the file has no header, which is what happens instead.
 */
const HEADER_PROPOSAL_WINDOW = 20;

export interface CsvParseOptions {
  /** From `FileValidationResult.delimiter` (§4, `IMP-FILE-006`). Defaults to a comma. */
  readonly delimiter?: string;
  /** See the module comment. Receives the raw cell text; owns §6.2 normalisation. */
  readonly isHeaderCell?: (rawCell: string) => boolean;
  /** Alternative to `isHeaderCell`: already-normalised synonyms, matched after normalisation here. */
  readonly headerSynonyms?: Iterable<string>;
  readonly minHeaderMatches?: number;
}

/** §6.2 header normalisation: lowercase, strip punctuation, collapse spaces. */
export function normaliseHeaderCell(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// -----------------------------------------------------------------------------------------------
// RFC 4180 tokenisation
// -----------------------------------------------------------------------------------------------

interface CsvRecord {
  /** 1-based physical line of the file on which this record starts. */
  readonly line: number;
  readonly fields: readonly string[];
}

/**
 * Splits text into RFC 4180 records: `""` is a literal quote inside a quoted field, and a newline
 * inside a quoted field belongs to the field rather than ending the record.
 *
 * Blank and whitespace-only lines produce no record at all — they are not lines the user gave us,
 * and §5.1's count invariant is over NON-EMPTY source lines. Everything else does, including a line
 * of nothing but delimiters, which is a real (if empty) row of a real file.
 *
 * Records are numbered by the physical line they start on, so `csv:row:17` opens line 17 of the
 * document in the evidence drawer (§13). With a header on line 1 — the ordinary case — the header
 * is row 1, exactly as §13 says.
 */
function tokenise(text: string, delimiter: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  const fields: string[] = [];
  let field = '';
  let line = 1;
  let recordLine = 1;
  let inQuotes = false;
  let hasContent = false;

  const endRecord = (): void => {
    fields.push(field);
    if (hasContent) records.push({ line: recordLine, fields: [...fields] });
    fields.length = 0;
    field = '';
    hasContent = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);

    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }
      // A newline inside a quoted field is part of the value; the physical line still advances, so
      // the NEXT record is numbered correctly.
      field += ch;
      if (ch === '\n') line += 1;
      else if (ch === '\r' && text.charAt(i + 1) !== '\n') line += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      hasContent = true;
      continue;
    }
    if (ch === delimiter) {
      fields.push(field);
      field = '';
      hasContent = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i += 1;
      endRecord();
      line += 1;
      recordLine = line;
      continue;
    }
    field += ch;
    if (ch.charCodeAt(0) > 32) hasContent = true;
  }

  // A file whose last line has no terminator is ordinary, not malformed.
  if (hasContent || field.length > 0 || fields.length > 0) endRecord();
  return records;
}

// -----------------------------------------------------------------------------------------------
// Header detection (§5.1, F-B-18)
// -----------------------------------------------------------------------------------------------

/**
 * Whether a cell reads as a number: an amount, a count, a percentage, with or without a currency
 * symbol, thousands separators or accounting parentheses. Used only by the *proposal* rule, whose
 * whole job is to tell a label line apart from a data line.
 */
function looksNumeric(cell: string): boolean {
  const trimmed = cell.trim();
  if (trimmed === '') return false;
  if (!/\d/.test(trimmed)) return false;
  return /^[(+-]?\s*[£$€]?\s*[\d][\d.,\s]*\)?\s*%?$/.test(trimmed);
}

function matcherFor(options: CsvParseOptions): ((cell: string) => boolean) | null {
  if (options.isHeaderCell) return options.isHeaderCell;
  if (options.headerSynonyms) {
    const table = new Set(options.headerSynonyms);
    return (cell) => table.has(normaliseHeaderCell(cell));
  }
  return null;
}

interface HeaderChoice {
  /** Index into `records`, or -1 when the file has no header at all. */
  readonly index: number;
  readonly confirmationRequired: boolean;
}

function chooseHeader(records: readonly CsvRecord[], options: CsvParseOptions): HeaderChoice {
  const isHeaderCell = matcherFor(options);
  const minMatches = options.minHeaderMatches ?? DEFAULT_MIN_HEADER_MATCHES;

  if (isHeaderCell) {
    for (let index = 0; index < records.length; index += 1) {
      const cells = (records[index] as CsvRecord).fields;
      // Counted over DISTINCT normalised cells: a preamble line reading `Total,Total,Total` matches
      // one synonym three times and is not a header.
      const matched = new Set<string>();
      for (const cell of cells) {
        if (cell.trim() !== '' && isHeaderCell(cell)) matched.add(normaliseHeaderCell(cell));
      }
      if (matched.size >= minMatches) return { index, confirmationRequired: false };
    }
  }

  // Nothing matched the synonyms. Propose the first line that looks like labels rather than data —
  // every cell present, none of them a number, no repeats — and make the reviewer confirm it.
  const window = Math.min(records.length, HEADER_PROPOSAL_WINDOW);
  for (let index = 0; index < window; index += 1) {
    const cells = (records[index] as CsvRecord).fields;
    if (cells.length < 2) continue;
    if (cells.some((cell) => cell.trim() === '')) continue;
    if (cells.some(looksNumeric)) continue;
    const distinct = new Set(cells.map((cell) => cell.trim().toLowerCase()));
    if (distinct.size !== cells.length) continue;
    return { index, confirmationRequired: true };
  }

  return { index: -1, confirmationRequired: true };
}

// -----------------------------------------------------------------------------------------------
// Parse
// -----------------------------------------------------------------------------------------------

/**
 * Parses decoded CSV text into a `ParsedTable`.
 *
 * `cells` holds the file verbatim. Nothing is trimmed, unescaped beyond RFC 4180, re-encoded or
 * neutralised — a description reading `=cmd|'/c calc'!A1` or `Ignore previous instructions` is
 * stored as those characters and nothing else (fixture 15). Defusing spreadsheet formulas is an
 * *export* concern (SECURITY_MODEL.md §8 step 4), and a prompt-injection string is data: it is
 * never interpreted, so it does not need to be altered either. Altering it here would put a value
 * in `raw_data` that is not what the bank sent, and `raw_data` is what level-4 evidence highlighting
 * shows the reviewer.
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): ParsedTable {
  const delimiter = options.delimiter ?? ',';
  // Defensive: `validateFile` strips the BOM while decoding, but a caller with text from elsewhere
  // would otherwise get a first column whose name starts with U+FEFF, which matches no synonym.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records = tokenise(source, delimiter);
  const warnings: ParseWarning[] = [];

  if (records.length === 0) {
    return { columns: [], rows: [], warnings, headerConfirmationRequired: true };
  }

  const header = chooseHeader(records, options);
  const headerRecord = header.index === -1 ? null : (records[header.index] as CsvRecord);

  const width =
    headerRecord === null
      ? records.reduce((widest, record) => Math.max(widest, record.fields.length), 0)
      : headerRecord.fields.length;

  const columns: string[] =
    headerRecord === null
      ? Array.from({ length: width }, (_unused, index) => `col_${index + 1}`)
      : headerRecord.fields.map((cell, index) => (cell.trim() === '' ? `col_${index + 1}` : cell));

  let malformed = 0;
  const rows: ParsedRow[] = records.map((record, index) => {
    // Only lines ABOVE the header are non-tabular. The header itself stays in `rows` — it is a
    // non-empty source line and the count invariant is over all of them — and is identified by
    // `headerRow`, not by this flag.
    const nonTabular = header.index !== -1 && index < header.index;
    const cells: (string | null)[] = [...record.fields];

    if (!nonTabular) {
      if (cells.length !== width) malformed += 1;
      // Short rows are padded with `null` — "no cell here", which is not the same as the empty
      // string an empty cell in the file produces. Over-wide rows keep their surplus cells: mapping
      // is by column index, so the extras are inert, and dropping them would discard data the
      // customer uploaded. §5.1 says "padded/truncated"; padding is done, truncation is not,
      // because SOW §23 and the `IMP-ROW-001` contract ("kept, never dropped, never cell-shifted")
      // outrank it.
      while (cells.length < width) cells.push(null);
    }
    // A preamble line is not a row of the table, so it is neither padded to the table's width nor
    // counted as malformed: it is `IMP-ROW-005`, and it is shown to the reviewer as it was written.

    return {
      rowNumber: record.line,
      sourceRef: `csv:row:${record.line}`,
      cells,
      ...(nonTabular ? { nonTabular: true as const } : {}),
    };
  });

  if (header.index === -1) {
    warnings.push({
      code: 'F-B-18',
      message:
        'No line in this file looks like a header row, so MOTION has numbered the columns. ' +
        'Confirm the columns before importing.',
    });
  } else if (header.confirmationRequired) {
    warnings.push({
      code: 'F-B-18',
      message:
        `Line ${(headerRecord as CsvRecord).line} is MOTION's best guess at the header row, but ` +
        'none of its columns matched a known heading. Confirm it before importing.',
    });
  }

  const nonTabular = header.index === -1 ? 0 : header.index;
  if (nonTabular > 0) {
    warnings.push({
      code: 'IMP-ROW-005',
      message:
        `${nonTabular} line${nonTabular === 1 ? '' : 's'} above the header ` +
        `${nonTabular === 1 ? 'is' : 'are'} not part of the table and will be recorded as skipped.`,
    });
  }

  if (malformed > 0) {
    warnings.push({
      code: 'IMP-ROW-001',
      message:
        `${malformed} line${malformed === 1 ? '' : 's'} ${malformed === 1 ? 'does' : 'do'} not ` +
        `have ${width} columns. They are kept as they are for review.`,
    });
  }

  return {
    columns,
    rows,
    warnings,
    ...(header.index === -1 ? {} : { headerRow: header.index + 1 }),
    ...(header.confirmationRequired ? { headerConfirmationRequired: true as const } : {}),
  };
}
