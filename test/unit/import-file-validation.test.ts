import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { MAX_DATA_ROWS, MAX_FILE_BYTES, validateFile } from '@/modules/documents';

/**
 * File validation — IMPORT_ENGINE.md §4, one describe block per row of the table.
 *
 * The fixtures that are bytes-on-disk (`fixtures/imports/*`) are the ones whose bytes are the point:
 * a Windows-1252 export cannot be written as a UTF-8 source string, and a PDF renamed `.csv` only
 * means anything as a real PDF. Everything oversized or repetitive — 26 MB, 50,001 rows, a macro
 * workbook, a 201-page PDF — is generated here rather than committed, so the repository stays small
 * and the intent of each file is visible in the test that builds it.
 */

const FIXTURES = path.resolve(process.cwd(), 'fixtures/imports');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURES, name)));
}

function expected(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf-8')) as Record<string, unknown>;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function codesOf(findings: readonly { code: string }[]): string[] {
  return findings.map((f) => f.code);
}

// -------------------------------------------------------------------------------------------
// A minimal ZIP writer, so the XLSX cases are real containers rather than hand-waved buffers.
// Store-only (method 0): the validator reads the central directory and never inflates.
// -------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipInput {
  readonly name: string;
  readonly content?: string;
  /** Lets a test declare an expansion the payload does not justify (zip bomb). */
  readonly declaredUncompressedSize?: number;
}

function makeZip(inputs: readonly ZipInput[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const input of inputs) {
    const name = bytes(input.name);
    const data = bytes(input.content ?? '<x/>');
    const size = input.declaredUncompressedSize ?? data.length;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    entry.set(name, 46);

    parts.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }

  const directorySize = central.reduce((sum, entry) => sum + entry.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, inputs.length, true);
  ev.setUint16(10, inputs.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, eocd];
  const total = all.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const WORKBOOK_ENTRIES: readonly ZipInput[] = [
  { name: '[Content_Types].xml', content: '<Types/>' },
  { name: '_rels/.rels', content: '<Relationships/>' },
  { name: 'xl/workbook.xml', content: '<workbook><sheets><sheet name="Bank" sheetId="1"/></sheets></workbook>' },
  { name: 'xl/worksheets/sheet1.xml', content: '<worksheet/>' },
];

function xlsx(extra: readonly ZipInput[] = []): Uint8Array {
  return makeZip([...WORKBOOK_ENTRIES, ...extra]);
}

function csvOf(dataRows: number): Uint8Array {
  const lines = ['Date,Description,Amount,Balance'];
  for (let i = 1; i <= dataRows; i += 1) {
    lines.push(`2026-08-01,ROW ${i},-1.00,${(1000 - i).toFixed(2)}`);
  }
  return bytes(`${lines.join('\n')}\n`);
}

/** A PDF that is only as complete as the §4 probe needs: header, some objects, xref pointer, EOF. */
function pdf(body: string, options: { readonly pages?: number } = {}): Uint8Array {
  const pages = Array.from(
    { length: options.pages ?? 0 },
    (_unused, i) => `${i + 10} 0 obj<</Type/Page/Parent 2 0 R>>endobj`,
  ).join('\n');
  return bytes(`%PDF-1.7\n${body}\n${pages}\ntrailer<</Size 9/Root 1 0 R>>\nstartxref\n9\n%%EOF\n`);
}

// -------------------------------------------------------------------------------------------

describe('IMP-FILE-002 — size', () => {
  it('accepts a file at the 25 MB limit and refuses one over it', () => {
    const overLimit = new Uint8Array(MAX_FILE_BYTES + 1).fill(0x41);
    const result = validateFile({ filename: 'oversize_26mb.csv', bytes: overLimit });

    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-002']);
    expect(result.findings[0]?.message).toContain('25 MB');
  });

  it('quarantines rather than discards, so the reviewer can see what was refused (§2 step 4)', () => {
    const result = validateFile({ filename: 'huge.csv', bytes: new Uint8Array(MAX_FILE_BYTES + 1) });
    expect(result.quarantine).toBe(true);
    expect(result.findings).toHaveLength(1);
  });

  it('refuses an empty file before trying to read it as anything', () => {
    const result = validateFile({ filename: 'empty.csv', bytes: new Uint8Array(0) });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-001']);
  });
});

describe('IMP-FILE-001 — extension against magic bytes', () => {
  it('catches a PDF uploaded as a CSV (fixture 14) and accepts the same bytes as a PDF', () => {
    const spec = expected('fake_csv.expected.json');
    expect(spec['catalogue']).toBe(14);
    const pdfBytes = fixture('fake_csv.pdf');

    const lying = validateFile({
      filename: 'august-statement.csv',
      declaredMimeType: 'text/csv',
      bytes: pdfBytes,
    });
    expect(lying.ok).toBe(false);
    expect(codesOf(lying.findings)).toEqual(['IMP-FILE-001']);
    expect(lying.findings[0]?.detail).toContain('PDF');

    const honest = validateFile({
      filename: 'august-statement.pdf',
      declaredMimeType: 'application/pdf',
      bytes: pdfBytes,
    });
    expect(honest.ok).toBe(true);
    expect(honest.pageCount).toBe(1);
    expect(honest.hasTextLayer).toBe(true);
  });

  it('rejects a BIFF .xls with the advice to save as .xlsx', () => {
    const biff = new Uint8Array(2048);
    biff.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);

    for (const filename of ['ledger.xls', 'ledger.xlsx']) {
      const result = validateFile({ filename, bytes: biff });
      expect(result.ok).toBe(false);
      expect(codesOf(result.findings)).toEqual(['IMP-FILE-001']);
      expect(result.findings[0]?.detail).toContain('.xlsx');
    }
  });

  it('does not trust the declared content type', () => {
    const result = validateFile({
      filename: 'workbook.xlsx',
      declaredMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: bytes('Date,Description,Amount\n2026-01-01,A,1.00\n'),
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-001']);
  });

  it('refuses a file type MOTION does not read at all', () => {
    // A PNG is a receipt photo since ADR-150 (receipt-reading.test.ts); a GIF is still nothing MOTION reads.
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
    const result = validateFile({ filename: 'scan.gif', bytes: gif });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-001']);
  });

  it('sanitises the stored filename with the signer rule and keeps one path segment', () => {
    const result = validateFile({
      filename: '../../etc/Statement Août 2026!.csv',
      bytes: fixture('bank_ambiguous_dates.csv'),
    });
    expect(result.sanitisedFilename).toBe('etc_Statement_Ao_t_2026_.csv');
    expect(result.sanitisedFilename).not.toContain('/');
  });
});

describe('IMP-FILE-003 — XLSX structure', () => {
  it('accepts a well-formed workbook', () => {
    const result = validateFile({ filename: 'tb_march.xlsx', bytes: xlsx() });
    expect(result.ok).toBe(true);
    expect(result.detectedKind).toBe('xlsx');
  });

  it('rejects a ZIP that is not a workbook', () => {
    const notAWorkbook = makeZip([{ name: 'readme.txt', content: 'hello' }]);
    const result = validateFile({ filename: 'notes.xlsx', bytes: notAWorkbook });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-003']);
    expect(result.findings[0]?.detail).toContain('xl/workbook.xml');
  });

  it('rejects a macro workbook (fixture 14, macro.xlsm)', () => {
    const macro = xlsx([{ name: 'xl/vbaProject.bin', content: 'MZ binary' }]);
    const result = validateFile({ filename: 'macro.xlsm', bytes: macro });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-003']);
    expect(result.findings[0]?.message).toContain('macros');
    expect(result.quarantine).toBe(true);
  });

  it('rejects a workbook whose figures live in another file', () => {
    const linked = xlsx([{ name: 'xl/externalLinks/externalLink1.xml', content: '<externalLink/>' }]);
    const result = validateFile({ filename: 'linked.xlsx', bytes: linked });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-003']);
    expect(result.findings[0]?.message).toContain('links to other files');
  });

  it('rejects a zip bomb by its declared expansion (SECURITY_MODEL.md §8 step 3)', () => {
    const bomb = xlsx([
      { name: 'xl/worksheets/sheet2.xml', content: 'a', declaredUncompressedSize: 400 * 1024 * 1024 },
    ]);
    const result = validateFile({ filename: 'bomb.xlsx', bytes: bomb });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-003']);
    expect(result.findings[0]?.detail).toContain('uncompressed');
  });

  it('reports every structural problem at once so scan_result is complete', () => {
    const bad = makeZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'xl/vbaProject.bin', content: 'MZ' },
    ]);
    const result = validateFile({ filename: 'bad.xlsx', bytes: bad });
    expect(result.findings).toHaveLength(2);
    expect(new Set(codesOf(result.findings))).toEqual(new Set(['IMP-FILE-003']));
  });
});

describe('IMP-FILE-004 — row cap', () => {
  it('accepts 50,000 data rows and refuses 50,001 (fixture 14, rows_50001.csv)', () => {
    const atCap = validateFile({ filename: 'rows_50000.csv', bytes: csvOf(MAX_DATA_ROWS) });
    expect(atCap.ok).toBe(true);
    expect(atCap.recordCount).toBe(MAX_DATA_ROWS + 1);

    const overCap = validateFile({ filename: 'rows_50001.csv', bytes: csvOf(MAX_DATA_ROWS + 1) });
    expect(overCap.ok).toBe(false);
    expect(codesOf(overCap.findings)).toEqual(['IMP-FILE-004']);
    expect(overCap.findings[0]?.detail).toContain('Split the export');
  });
});

describe('IMP-FILE-005 — CSV encoding', () => {
  it('reads a Windows-1252 export with £ and dashes in it (fixture 8)', () => {
    const spec = expected('bank_1252_semicolon.expected.json');
    const raw = fixture('bank_1252_semicolon.csv');
    // Proof the fixture really is 1252 and not UTF-8: strict UTF-8 must refuse these bytes.
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(raw)).toThrow();

    const result = validateFile({ filename: 'bank_1252_semicolon.csv', bytes: raw });
    expect(result.ok).toBe(true);
    expect(result.encoding).toBe((spec['validation'] as Record<string, unknown>)['encoding']);
    expect(result.text).toContain('£2.500,00');
    expect(result.text).toContain('Café Nero – London Bridge');
  });

  it('detects and strips a UTF-8 BOM', () => {
    const withBom = new Uint8Array([
      0xef, 0xbb, 0xbf,
      ...bytes('Date,Description,Amount\n2026-01-01,Tesco,-1.00\n'),
    ]);
    const result = validateFile({ filename: 'bom.csv', bytes: withBom });
    expect(result.ok).toBe(true);
    expect(result.encoding).toBe('utf-8');
    expect(result.text?.startsWith('Date,')).toBe(true);
  });

  it('detects a UTF-16 LE BOM', () => {
    const text = 'Date,Description,Amount\n2026-01-01,Tesco,-1.00\n';
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe], 0);
    for (let i = 0; i < text.length; i += 1) {
      utf16[2 + i * 2] = text.charCodeAt(i) & 0xff;
      utf16[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    const result = validateFile({ filename: 'utf16.csv', bytes: utf16 });
    expect(result.ok).toBe(true);
    expect(result.encoding).toBe('utf-16le');
    expect(result.text?.startsWith('Date,')).toBe(true);
  });

  it('rejects NUL bytes', () => {
    const withNul = new Uint8Array([...bytes('Date,Amount\n2026-01-01'), 0x00, ...bytes(',1.00\n')]);
    const result = validateFile({ filename: 'nul.csv', bytes: withNul });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-005']);
    expect(result.findings[0]?.detail).toContain('NUL');
  });

  it('rejects bytes that decode in neither UTF-8 nor Windows-1252', () => {
    // 0xC3 0x28 is invalid UTF-8; 0x81 is undefined in Windows-1252.
    const rubbish = new Uint8Array([...bytes('Date,Amount\n'), 0xc3, 0x28, 0x81, 0x0a]);
    const result = validateFile({ filename: 'binary.csv', bytes: rubbish });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-005']);
  });
});

describe('IMP-FILE-006 — CSV delimiter', () => {
  it('picks the semicolon over the comma when the amounts read 1.234,56 (fixture 8)', () => {
    const result = validateFile({
      filename: 'bank_1252_semicolon.csv',
      bytes: fixture('bank_1252_semicolon.csv'),
    });
    expect(result.delimiter).toBe(';');
  });

  it('picks the comma for an ordinary export, quoted delimiters and all (fixture 22)', () => {
    const result = validateFile({
      filename: 'csv-with-preamble.csv',
      bytes: fixture('csv-with-preamble.csv'),
    });
    expect(result.ok).toBe(true);
    expect(result.delimiter).toBe(',');
  });

  it('handles tab and pipe files', () => {
    const tabbed = 'Date\tDescription\tAmount\n2026-01-01\tTesco\t-1.00\n2026-01-02\tShell\t-2.00\n';
    expect(validateFile({ filename: 't.csv', bytes: bytes(tabbed) }).delimiter).toBe('\t');

    const piped = 'Date|Description|Amount\n2026-01-01|Tesco|-1.00\n2026-01-02|Shell|-2.00\n';
    expect(validateFile({ filename: 'p.csv', bytes: bytes(piped) }).delimiter).toBe('|');
  });

  it('refuses a text file with no delimiter structure at all', () => {
    const prose = 'Dear customer\nYour statement is attached\nThank you for banking with us\n';
    const result = validateFile({ filename: 'letter.csv', bytes: bytes(prose) });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-006']);
  });

  it('refuses a file whose column count keeps changing', () => {
    const ragged = 'a,b,c\nd,e\nf,g,h,i\nj\nk,l\nm,n,o,p,q\n';
    const result = validateFile({ filename: 'ragged.csv', bytes: bytes(ragged) });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-006']);
  });
});

describe('IMP-FILE-007 — PDF', () => {
  it('reads page count and text layer from a real PDF (fixture 14)', () => {
    const result = validateFile({ filename: 'bank_text.pdf', bytes: fixture('fake_csv.pdf') });
    expect(result.ok).toBe(true);
    expect(result.pageCount).toBe(1);
    expect(result.hasTextLayer).toBe(true);
  });

  it('reports a PDF with no text layer as readable but text-free (§5.5 stores it, no batch)', () => {
    const scanned = pdf('1 0 obj<</Type/Page/Parent 2 0 R>>endobj\n4 0 obj<</Length 4>>stream\nq Q\nendstream endobj');
    const result = validateFile({ filename: 'bank_scanned.pdf', bytes: scanned });
    expect(result.ok).toBe(true);
    expect(result.hasTextLayer).toBe(false);
  });

  it('rejects an encrypted PDF', () => {
    const locked = bytes(
      '%PDF-1.7\n1 0 obj<</Type/Page>>endobj\ntrailer<</Size 9/Root 1 0 R/Encrypt 8 0 R>>\nstartxref\n9\n%%EOF\n',
    );
    const result = validateFile({ filename: 'encrypted.pdf', bytes: locked });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-007']);
    expect(result.findings[0]?.message).toContain('password-protected');
  });

  it('rejects a PDF over 200 pages', () => {
    const result = validateFile({ filename: 'annual.pdf', bytes: pdf('', { pages: 201 }) });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-007']);
    expect(result.findings[0]?.message).toContain('201 pages');
  });

  it('rejects a truncated PDF rather than reading half a statement', () => {
    const truncated = bytes('%PDF-1.7\n1 0 obj<</Type/Page>>endobj\n');
    const result = validateFile({ filename: 'cut.pdf', bytes: truncated });
    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['IMP-FILE-007']);
  });
});

describe('IMP-FILE-008 — active content', () => {
  it('quarantines a PDF that runs JavaScript when it opens', () => {
    const hostile = pdf(
      '1 0 obj<</Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert\\(1\\))>>>>endobj',
      { pages: 1 },
    );
    const result = validateFile({ filename: 'statement.pdf', bytes: hostile });
    expect(result.ok).toBe(false);
    expect(result.quarantine).toBe(true);
    expect(codesOf(result.findings)).toContain('IMP-FILE-008');
    expect(result.findings.find((f) => f.code === 'IMP-FILE-008')?.detail).toContain('/JavaScript');
  });

  it('quarantines a PDF with a launch action or an embedded file', () => {
    const launcher = pdf('1 0 obj<</A<</S/Launch/F(cmd.exe)>>>>endobj', { pages: 1 });
    expect(codesOf(validateFile({ filename: 'l.pdf', bytes: launcher }).findings)).toContain(
      'IMP-FILE-008',
    );

    const carrier = pdf('1 0 obj<</Names<</EmbeddedFiles 7 0 R>>>>endobj', { pages: 1 });
    expect(codesOf(validateFile({ filename: 'e.pdf', bytes: carrier }).findings)).toContain(
      'IMP-FILE-008',
    );
  });

  it('does not quarantine an ordinary statement that merely mentions nothing of the sort', () => {
    const result = validateFile({ filename: 'clean.pdf', bytes: fixture('fake_csv.pdf') });
    expect(codesOf(result.findings)).not.toContain('IMP-FILE-008');
  });
});

describe('the fixture catalogue (§17) agrees with the validator', () => {
  const cases: readonly { readonly name: string; readonly catalogue: number }[] = [
    { name: 'csv-with-preamble', catalogue: 22 },
    { name: 'bank_out_in_columns', catalogue: 6 },
    { name: 'bank_signed', catalogue: 6 },
    { name: 'bank_positive_out', catalogue: 6 },
    { name: 'bank_ambiguous_dates', catalogue: 7 },
    { name: 'bank_1252_semicolon', catalogue: 8 },
    { name: 'injection_descriptions', catalogue: 15 },
  ];

  for (const { name, catalogue } of cases) {
    it(`${name} (item ${catalogue}) validates exactly as its expected.json says`, () => {
      const spec = expected(`${name}.expected.json`);
      const validation = spec['validation'] as Record<string, unknown>;
      const result = validateFile({ filename: `${name}.csv`, bytes: fixture(`${name}.csv`) });

      expect(spec['catalogue']).toBe(catalogue);
      expect(result.ok).toBe(validation['ok']);
      expect(codesOf(result.findings)).toEqual(validation['codes']);
      expect(result.encoding).toBe(validation['encoding']);
      expect(result.delimiter).toBe(validation['delimiter']);
    });
  }
});
