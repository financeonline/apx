/**
 * CSV output (SECURITY_MODEL.md §8 step 4; RFC 4180).
 *
 * Two rules, both about the reader's spreadsheet rather than ours:
 *   1. a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a
 *      leading apostrophe, so a description a customer's bank sent as `=HYPERLINK(...)` opens as text
 *      and never runs (CSV injection);
 *   2. a cell containing a delimiter, a quote or a line break is quoted, with quotes doubled.
 *
 * The apostrophe is applied BEFORE quoting so it survives as the first character of the cell.
 */

const DANGEROUS_LEAD = /^[=+\-@\t\r]/;
/** A plain signed decimal. A spreadsheet reads it as a number; it cannot execute (ADR-086). */
const NUMERIC_LITERAL = /^[+-]?\d+(?:\.\d+)?$/;

export function defuseCell(value: string): string {
  if (NUMERIC_LITERAL.test(value)) return value;
  return DANGEROUS_LEAD.test(value) ? `'${value}` : value;
}

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = defuseCell(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: ReadonlyArray<string | number | null | undefined>): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}
