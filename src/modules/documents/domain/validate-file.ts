/**
 * File validation — IMPORT_ENGINE.md §4, every row of the table, in the fixed order of
 * SECURITY_MODEL.md §8.
 *
 * This runs before storage and before any parser sees a byte. It is the boundary between "a file
 * somebody uploaded" and "a document MOTION will read", and it decides that question from the
 * BYTES, never from the extension or the browser's Content-Type: fixture 14 (`fake_csv.pdf`) is a
 * genuine PDF wearing a `.csv` name, and a validator that believed the name would hand a binary to
 * the CSV parser.
 *
 * Nothing here throws and nothing here is discarded. A refusal comes back as `ok: false` with the
 * findings that caused it, because §2 step 4 stores the file anyway — `status = 'quarantined'` with
 * `scan_result` populated — so the reviewer can see what they uploaded and why it was refused, and
 * the platform can see it under `/platform/jobs`. A file that vanished with a toast would be
 * exactly the silent discard SOW §23 forbids.
 *
 * `sanitiseFilename` is imported from the Storage signer rather than restated here. The rule (one
 * path segment, `[A-Za-z0-9._-]`, 120 characters, no traversal) is a security boundary, and a
 * second copy of a security boundary is a second copy to get wrong. See the note in the report:
 * the function is pure and would sit better in `core/storage/filenames.ts` with the signer
 * re-exporting it, which is a change to a file outside this task's scope.
 */
import { sanitiseFilename } from '@/core/storage/signer';

/*
 * The shared pipeline contract. `imports/index.ts` does not re-export the Phase 5 types yet, so
 * this is a relative import rather than a barrel import; `motion/no-deep-module-import` would
 * (correctly) reject `@/modules/imports/domain/pipeline-types`. Type-only, erased at build.
 */
import type {
  FileScanFinding,
  FileValidationResult,
} from '../../imports/domain/pipeline-types';

import { type CsvDelimiter, countRecords, sniffDelimiter } from './delimiter';
import { MAX_PDF_PAGES, probePdf } from './pdf-probe';
import { decodeCsvBytes } from './text-encoding';
import { readZipDirectory } from './zip';

/** §2 step 2 and §4: 25 MB per file. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** §2 step 2 and §4: 50,000 data rows per file. */
export const MAX_DATA_ROWS = 50_000;
/** §4: an XLSX must contain both of these to be a workbook at all. */
const REQUIRED_XLSX_ENTRIES = ['[Content_Types].xml', 'xl/workbook.xml'] as const;
/** SECURITY_MODEL.md §8 step 3: zip-bomb ceilings. */
const MAX_XLSX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const MAX_XLSX_COMPRESSION_RATIO = 100;

/** The three shapes MOTION reads (§4). */
export type FileKind = 'csv' | 'xlsx' | 'pdf';

export interface FileToValidate {
  readonly filename: string;
  /** The browser's Content-Type. Recorded and cross-checked, never trusted on its own (§4). */
  readonly declaredMimeType?: string;
  readonly bytes: Uint8Array;
}

export interface DocumentValidation extends FileValidationResult {
  /** One path segment, safe to append to `{organization_id}/{document_id}/` (§2 step 5). */
  readonly sanitisedFilename: string;
  /** What the magic bytes say the file is; `null` when nothing recognised it. */
  readonly detectedKind: FileKind | null;
  /**
   * The decoded CSV text, so the parser does not decode 25 MB a second time — and, more to the
   * point, so it cannot decode it under a *different* encoding than the one recorded in
   * `transforms.encoding` (§4).
   */
  readonly text?: string;
  /** Non-empty CSV records found, header included. Undefined for XLSX and PDF. */
  readonly recordCount?: number;
}

function finding(code: string, message: string, detail?: string): FileScanFinding {
  return detail === undefined ? { code, message } : { code, message, detail };
}

/**
 * Every refusal quarantines. §2 step 4 stores a file that fails validation with
 * `status = 'quarantined'`, and §4 names the flag explicitly for the malware row; the two agree if
 * quarantine simply means "stored, never parsed", which is what it means here.
 */
function refuse(
  sanitisedFilename: string,
  detectedKind: FileKind | null,
  findings: readonly FileScanFinding[],
): DocumentValidation {
  return { ok: false, findings, quarantine: true, sanitisedFilename, detectedKind };
}

// -----------------------------------------------------------------------------------------------
// Magic bytes
// -----------------------------------------------------------------------------------------------

type Container = 'zip' | 'pdf' | 'ole2' | 'image' | 'archive' | 'text';

const SIGNATURES: readonly { readonly container: Container; readonly bytes: readonly number[] }[] = [
  { container: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { container: 'zip', bytes: [0x50, 0x4b, 0x05, 0x06] },
  { container: 'zip', bytes: [0x50, 0x4b, 0x07, 0x08] },
  { container: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // OLE2 compound file: the BIFF `.xls` workbook, and also `.doc` and `.msg`.
  { container: 'ole2', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { container: 'image', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { container: 'image', bytes: [0xff, 0xd8, 0xff] },
  { container: 'image', bytes: [0x47, 0x49, 0x46, 0x38] },
  { container: 'archive', bytes: [0x1f, 0x8b] },
  { container: 'archive', bytes: [0x52, 0x61, 0x72, 0x21] },
  { container: 'archive', bytes: [0x37, 0x7a, 0xbc, 0xaf] },
];

function sniffContainer(bytes: Uint8Array): Container {
  for (const signature of SIGNATURES) {
    if (signature.bytes.every((byte, index) => bytes[index] === byte)) return signature.container;
  }
  // No known binary signature. Whether it really is text is settled by `IMP-FILE-005`, which is the
  // only check that can settle it: text has no magic bytes.
  return 'text';
}

const EXTENSION_KINDS: Readonly<Record<string, FileKind | 'xls'>> = {
  csv: 'csv',
  txt: 'csv',
  tsv: 'csv',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xls: 'xls',
  pdf: 'pdf',
};

const MIME_KINDS: Readonly<Record<string, FileKind | 'xls'>> = {
  'text/csv': 'csv',
  'text/plain': 'csv',
  'application/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/pdf': 'pdf',
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

const SAVE_AS_XLSX =
  'Open it in Excel and use File → Save As → Excel Workbook (.xlsx), then upload that.';

// -----------------------------------------------------------------------------------------------
// Per-kind checks
// -----------------------------------------------------------------------------------------------

/**
 * `IMP-FILE-004`. Exported because the row cap is enforced twice: here for CSV, where the records
 * can be counted without materialising them, and at parse for XLSX, where §2 step 2 says a file
 * over the cap "is rejected at parse".
 */
export function checkRowCap(dataRows: number): FileScanFinding | null {
  if (dataRows <= MAX_DATA_ROWS) return null;
  return finding(
    'IMP-FILE-004',
    `This file has ${dataRows.toLocaleString('en-GB')} rows; MOTION imports up to ` +
      `${MAX_DATA_ROWS.toLocaleString('en-GB')} in one file.`,
    'Split the export by period and upload one file per range.',
  );
}

function validateXlsx(bytes: Uint8Array): readonly FileScanFinding[] {
  const zip = readZipDirectory(bytes);
  if (!zip.ok) {
    return [finding('IMP-FILE-003', 'This workbook could not be opened.', zip.detail)];
  }

  const findings: FileScanFinding[] = [];
  const names = new Set(zip.entries.map((entry) => entry.name));

  const missing = REQUIRED_XLSX_ENTRIES.filter((required) => !names.has(required));
  if (missing.length > 0) {
    findings.push(
      finding(
        'IMP-FILE-003',
        'This file is a ZIP archive but not an Excel workbook.',
        `It is missing ${missing.join(' and ')}.`,
      ),
    );
  }

  if (names.has('xl/vbaProject.bin')) {
    findings.push(
      finding(
        'IMP-FILE-003',
        'This workbook contains macros, which MOTION does not open.',
        'Save it as a macro-free .xlsx (Excel Workbook, not Macro-Enabled Workbook) and upload that.',
      ),
    );
  }

  const externalLinks = zip.entries.filter((entry) => entry.name.startsWith('xl/externalLinks/'));
  if (externalLinks.length > 0) {
    // A workbook that pulls values out of another file would import figures MOTION never saw, and
    // the evidence trail would point at a document that does not contain them.
    findings.push(
      finding(
        'IMP-FILE-003',
        'This workbook links to other files, so its figures are not all in it.',
        'Copy the sheet you want to import into a new workbook with values only, and upload that.',
      ),
    );
  }

  const compressed = zip.entries.reduce((sum, entry) => sum + entry.compressedSize, 0);
  const uncompressed = zip.entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  const ratio = compressed === 0 ? 0 : uncompressed / compressed;
  if (uncompressed > MAX_XLSX_UNCOMPRESSED_BYTES || ratio > MAX_XLSX_COMPRESSION_RATIO) {
    findings.push(
      finding(
        'IMP-FILE-003',
        'This workbook expands to far more data than a spreadsheet should.',
        `It declares ${Math.round(uncompressed / (1024 * 1024))} MB uncompressed at a ratio of ` +
          `${Math.round(ratio)}:1 (SECURITY_MODEL.md §8 step 3).`,
      ),
    );
  }

  return findings;
}

function validatePdf(bytes: Uint8Array): {
  readonly findings: readonly FileScanFinding[];
  readonly pageCount?: number;
  readonly hasTextLayer?: boolean;
} {
  const probe = probePdf(bytes);
  if (probe.structureError !== undefined) {
    return { findings: [finding('IMP-FILE-007', 'This PDF could not be read.', probe.structureError)] };
  }

  const findings: FileScanFinding[] = [];
  if (probe.encrypted) {
    findings.push(
      finding(
        'IMP-FILE-007',
        'This PDF is password-protected, so MOTION cannot read it.',
        'Open it, save an unprotected copy, and upload that.',
      ),
    );
  }
  if (probe.pageCount > MAX_PDF_PAGES) {
    findings.push(
      finding(
        'IMP-FILE-007',
        `This PDF has ${probe.pageCount} pages; MOTION reads up to ${MAX_PDF_PAGES}.`,
        'Split it by statement period and upload one file per period.',
      ),
    );
  }
  if (probe.activeContent.length > 0) {
    // `IMP-FILE-008`: a bank statement has no reason to run anything when it opens.
    findings.push(
      finding(
        'IMP-FILE-008',
        'This PDF contains active content, so MOTION has quarantined it.',
        `Found: ${probe.activeContent.join(', ')}.`,
      ),
    );
  }

  return { findings, pageCount: probe.pageCount, hasTextLayer: probe.hasTextLayer };
}

interface CsvOutcome {
  readonly findings: readonly FileScanFinding[];
  readonly encoding?: DocumentValidation['encoding'];
  readonly delimiter?: CsvDelimiter;
  readonly text?: string;
  readonly recordCount?: number;
}

function validateCsv(bytes: Uint8Array): CsvOutcome {
  const decoded = decodeCsvBytes(bytes);
  if (!decoded.ok) {
    return {
      findings: [
        finding(
          'IMP-FILE-005',
          decoded.reason === 'nul_byte'
            ? 'This file contains characters that cannot appear in a CSV.'
            : 'This file is not text that MOTION can read.',
          decoded.detail,
        ),
      ],
    };
  }

  const sniffed = sniffDelimiter(decoded.text);
  if (!sniffed.ok) {
    return {
      findings: [
        finding(
          'IMP-FILE-006',
          'MOTION could not work out how this file separates its columns.',
          sniffed.detail,
        ),
      ],
      encoding: decoded.encoding,
      text: decoded.text,
    };
  }

  // One more than the cap so the count is enough to decide, without walking a hostile 25 MB of
  // newlines to the end. The header is the one record that is not a data row; preamble lines above
  // it (§5.1) are counted as data here, which errs towards rejecting slightly early rather than
  // accepting a file the parser would then have to refuse.
  const recordCount = countRecords(decoded.text, sniffed.delimiter, MAX_DATA_ROWS + 1);
  const dataRows = Math.max(0, recordCount - 1);
  const capFinding = checkRowCap(dataRows);

  return {
    findings: capFinding === null ? [] : [capFinding],
    encoding: decoded.encoding,
    delimiter: sniffed.delimiter,
    text: decoded.text,
    recordCount,
  };
}

// -----------------------------------------------------------------------------------------------
// The §4 pipeline
// -----------------------------------------------------------------------------------------------

/**
 * Validates one uploaded file against §4. Pure: same bytes, same answer, no I/O, no clock.
 *
 * Stages run in the order SECURITY_MODEL.md §8 fixes and the first failing stage stops the run, so
 * a 40 MB file is refused on size without anybody decoding it and a renamed PDF is refused on magic
 * bytes without anybody parsing it. Findings within a single stage are all reported together, so
 * `scan_result` shows the reviewer everything that was wrong with the file at that stage.
 */
export function validateFile(input: FileToValidate): DocumentValidation {
  const sanitisedFilename = sanitiseFilename(input.filename);
  const { bytes } = input;

  // Stage 1 — size (`IMP-FILE-002`).
  if (bytes.length > MAX_FILE_BYTES) {
    return refuse(sanitisedFilename, null, [
      finding(
        'IMP-FILE-002',
        `This file is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB; the limit is 25 MB.`,
        'Split the export by period and upload one file per range.',
      ),
    ]);
  }
  if (bytes.length === 0) {
    return refuse(sanitisedFilename, null, [
      finding('IMP-FILE-001', 'This file is empty.'),
    ]);
  }

  // Stage 2 — extension ↔ magic bytes (`IMP-FILE-001`).
  const declared =
    EXTENSION_KINDS[extensionOf(input.filename)] ??
    MIME_KINDS[(input.declaredMimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? ''] ??
    null;
  const container = sniffContainer(bytes);

  if (container === 'ole2' || declared === 'xls') {
    // The BIFF workbook. Refused by name and by magic bytes alike, because the advice is the same
    // either way and a `.xlsx` that is really a `.xls` fails inside the ZIP reader with a much worse
    // message than this one.
    return refuse(sanitisedFilename, null, [
      finding(
        'IMP-FILE-001',
        'This is an older Excel file (.xls), which MOTION does not read.',
        SAVE_AS_XLSX,
      ),
    ]);
  }
  if (declared === null) {
    return refuse(sanitisedFilename, null, [
      finding(
        'IMP-FILE-001',
        'MOTION reads CSV, Excel (.xlsx) and PDF files.',
        `"${input.filename}" is none of those.`,
      ),
    ]);
  }

  const expected: Container = declared === 'xlsx' ? 'zip' : declared === 'pdf' ? 'pdf' : 'text';
  if (container !== expected) {
    return refuse(sanitisedFilename, container === 'pdf' ? 'pdf' : null, [
      finding(
        'IMP-FILE-001',
        `"${input.filename}" is not a ${declared === 'csv' ? 'CSV' : declared.toUpperCase()} file.`,
        `Its contents are ${describeContainer(container)}, whatever the file is named.`,
      ),
    ]);
  }

  // Stage 3 — structure, per kind.
  if (declared === 'xlsx') {
    const findings = validateXlsx(bytes);
    return findings.length > 0
      ? refuse(sanitisedFilename, 'xlsx', findings)
      : { ok: true, findings: [], sanitisedFilename, detectedKind: 'xlsx' };
  }

  if (declared === 'pdf') {
    const { findings, pageCount, hasTextLayer } = validatePdf(bytes);
    if (findings.length > 0) {
      return {
        ...refuse(sanitisedFilename, 'pdf', findings),
        pageCount,
        hasTextLayer,
      };
    }
    // A PDF with no text layer is not a failure: §5.5 stores it as `unreadable` and asks for a CSV.
    return {
      ok: true,
      findings: [],
      sanitisedFilename,
      detectedKind: 'pdf',
      pageCount,
      hasTextLayer,
    };
  }

  const csv = validateCsv(bytes);
  if (csv.findings.length > 0) {
    return {
      ...refuse(sanitisedFilename, 'csv', csv.findings),
      encoding: csv.encoding,
      delimiter: csv.delimiter,
    };
  }
  return {
    ok: true,
    findings: [],
    sanitisedFilename,
    detectedKind: 'csv',
    encoding: csv.encoding,
    delimiter: csv.delimiter,
    text: csv.text,
    recordCount: csv.recordCount,
  };
}

function describeContainer(container: Container): string {
  switch (container) {
    case 'pdf':
      return 'a PDF';
    case 'zip':
      return 'a ZIP archive (an .xlsx workbook is one)';
    case 'ole2':
      return 'an older Microsoft Office file';
    case 'image':
      return 'an image';
    case 'archive':
      return 'a compressed archive';
    case 'text':
      return 'plain text';
  }
}
