/**
 * CSV delimiter sniffing and record counting (IMPORT_ENGINE.md §4, `IMP-FILE-006` and
 * `IMP-FILE-004`).
 *
 * The scan is quote-aware, which is the whole point: `"Smith, John",100.00` has two fields under a
 * comma delimiter, not three, and a sniffer that counts raw commas would reject a perfectly good
 * file — or, worse, pick `;` for a comma-separated export because the comma looked inconsistent.
 * A record may also span several physical lines when a quoted description contains a newline, so a
 * "line" here means an RFC 4180 record throughout.
 *
 * This counts; it does not materialise cells. The parser that does that is
 * `imports/domain/parsers/csv.ts`, and the two are deliberately separate: validation must be able
 * to reject a 25 MB file without first building 50,000 arrays of strings out of it.
 */

export type CsvDelimiter = ',' | ';' | '\t' | '|';

/** §4, in the order the document lists them; that order also breaks sniffing ties. */
export const CSV_DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t', '|'];

/** §4: "Sniff … over first 20 lines". */
export const SNIFF_RECORDS = 20;
/** §4: "require consistent field count in ≥ 90% of lines". */
export const MIN_CONSISTENCY = 0.9;

export interface SniffedDelimiter {
  readonly ok: true;
  readonly delimiter: CsvDelimiter;
  /** The modal field count, i.e. how many columns the file appears to have. */
  readonly fieldCount: number;
  /** Share of sniffed records that had exactly `fieldCount` fields, 0–1. */
  readonly consistency: number;
}

export interface UnsniffableDelimiter {
  readonly ok: false;
  readonly detail: string;
}

/**
 * Walks records under one candidate delimiter, reporting the field count of each non-empty record.
 * Return `false` from `onRecord` to stop early.
 *
 * "Non-empty" is judged on the source text, not on the parsed cells: a line of `,,,` is a real line
 * of a real file and is counted, while a blank or whitespace-only line is not a line the user gave
 * us and must not become a row (§5.1's count invariant is over NON-EMPTY source lines).
 */
export function scanRecords(
  text: string,
  delimiter: string,
  onRecord: (fieldCount: number) => boolean,
): void {
  let fields = 1;
  let inQuotes = false;
  let hasContent = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') i += 1;
        else inQuotes = false;
      }
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      hasContent = true;
      continue;
    }
    if (ch === delimiter) {
      fields += 1;
      hasContent = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i += 1;
      if (hasContent && !onRecord(fields)) return;
      fields = 1;
      hasContent = false;
      continue;
    }
    if (ch.charCodeAt(0) > 32) hasContent = true;
  }
  // An unterminated final record still counts; files without a trailing newline are ordinary.
  if (hasContent) onRecord(fields);
}

/** Number of non-empty RFC 4180 records, stopping once `limit` is exceeded. */
export function countRecords(text: string, delimiter: string, limit: number): number {
  let count = 0;
  scanRecords(text, delimiter, () => {
    count += 1;
    return count <= limit;
  });
  return count;
}

function fieldCountsOf(text: string, delimiter: string): number[] {
  const counts: number[] = [];
  scanRecords(text, delimiter, (fieldCount) => {
    counts.push(fieldCount);
    return counts.length < SNIFF_RECORDS;
  });
  return counts;
}

/** The most common field count, ties going to the wider table. */
function modalCount(counts: readonly number[]): number {
  const tally = new Map<number, number>();
  for (const count of counts) tally.set(count, (tally.get(count) ?? 0) + 1);
  let value = 0;
  let best = 0;
  for (const [candidate, occurrences] of tally) {
    if (occurrences > best || (occurrences === best && candidate > value)) {
      value = candidate;
      best = occurrences;
    }
  }
  return value;
}

/**
 * Picks the delimiter of a CSV, or explains why none of the four fits.
 *
 * A candidate qualifies when its modal field count is at least 2 and at least 90% of the sniffed
 * records **at or below the first record with that count** share it (§4).
 *
 * Two parts of that need saying out loud:
 *
 *   - *At least 2 fields.* A file with no delimiter at all is perfectly "consistent" at one field
 *     per line under every candidate, and §4 admits `text/plain` only "with delimiter structure".
 *     Such a file is reported as `IMP-FILE-006` rather than imported as one nameless column.
 *   - *At or below the first modal record.* §4 asks for consistency "in ≥ 90% of lines" of the first
 *     20, while §5.1 explicitly supports a preamble above the header — and four title lines above a
 *     table is already 20% of a 20-line window, so the two rules read literally cannot both hold
 *     (fixture 22 is exactly this file). The preamble is not part of the table and says nothing
 *     about its delimiter, so consistency is measured from where the table starts. This is the one
 *     place this module resolves an ambiguity rather than following the text; see the note in the
 *     handover.
 *
 * Among qualifying candidates the widest table wins — a `;`-separated European export whose amounts
 * read `1.234,56` contains commas too, and the `;` reading is the one with more columns.
 */
export function sniffDelimiter(text: string): SniffedDelimiter | UnsniffableDelimiter {
  let best: SniffedDelimiter | null = null;

  for (const delimiter of CSV_DELIMITERS) {
    const counts = fieldCountsOf(text, delimiter);
    if (counts.length === 0) {
      return { ok: false, detail: 'The file contains no non-empty lines.' };
    }
    const structured = counts.filter((count) => count >= 2);
    if (structured.length === 0) continue;

    const value = modalCount(structured);
    const tail = counts.slice(counts.indexOf(value));
    const share = tail.filter((count) => count === value).length / tail.length;
    if (share < MIN_CONSISTENCY) continue;

    if (best === null || value > best.fieldCount) {
      best = { ok: true, delimiter, fieldCount: value, consistency: share };
    }
  }

  if (best === null) {
    return {
      ok: false,
      detail:
        'None of the delimiters APX reads (comma, semicolon, tab, pipe) gives a consistent ' +
        'number of columns across the first 20 lines.',
    };
  }
  return best;
}
