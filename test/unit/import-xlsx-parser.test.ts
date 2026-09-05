/**
 * XLSX parser (IMPORT_ENGINE.md §5.2, ADR-033).
 *
 * The two properties worth losing sleep over are asserted first and most often:
 *
 *  • the row-count invariant — `rows.length` equals the number of non-empty source rows, so a
 *    reviewer counting lines in Excel and rows in MOTION finds the same number (SOW §23,
 *    TEST_STRATEGY.md §5.2);
 *  • merged-cell inheritance — a merged label is copied down, a merged AMOUNT never is. The
 *    second half is what stops a three-row merged range from importing the same £4,000 three
 *    times.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as exceljsNamespace from 'exceljs';
/*
 * Relative imports: `@/modules/imports` does not re-export the Phase 5 parsers or the mapping
 * module yet, and `motion/no-deep-module-import` (correctly) refuses the `@/` deep path.
 */
import {
  excelSerialToIso,
  parseXlsx,
  type XlsxParseOptions,
} from '../../src/modules/imports/domain/parsers/xlsx';
import { isKnownHeader, suggestColumns } from '../../src/modules/imports/domain/mapping/synonyms';
import type { ParsedTable } from '../../src/modules/imports/domain/pipeline-types';

const ExcelJS =
  (exceljsNamespace as unknown as { default?: typeof exceljsNamespace }).default ?? exceljsNamespace;

const FIXTURES = join(process.cwd(), 'fixtures', 'imports');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

function expected(name: string): { readonly expect: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), 'utf8'));
}

/**
 * The real §6.2 synonym table, wired in the way the pipeline will wire it.
 *
 * The parser takes both of these as parameters so it can stay pure and so `synonyms.ts` stays the
 * one place the table lives. Using the real functions here — rather than a stub table — is what
 * proves the injected contract actually fits what the mapping module exports.
 */
const SYNONYM_OPTIONS = {
  isHeaderCell: isKnownHeader,
  headerTarget: (cell: string) => suggestColumns([cell])[0]?.target ?? null,
} satisfies Pick<XlsxParseOptions, 'isHeaderCell' | 'headerTarget'>;

async function parse(bytes: Uint8Array, sheet?: string): Promise<ParsedTable> {
  return parseXlsx(
    bytes,
    sheet === undefined ? SYNONYM_OPTIONS : { ...SYNONYM_OPTIONS, sheet },
  );
}

/** Build a workbook in memory, so a one-off structural case does not need a committed binary. */
async function workbook(
  build: (wb: InstanceType<typeof ExcelJS.Workbook>) => void,
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------------------------

describe('parseXlsx — the catalogue fixtures (§17)', () => {
  const cases = [
    'tb_march.xlsx',
    'tb_march_off.xlsx',
    'pnl_multi_period.xlsx',
    'gl_unmapped_accounts.xlsx',
  ] as const;

  it.each(cases)('%s matches its expected.json', async (name) => {
    const table = await parse(fixture(name));
    const want = expected(name.replace(/\.xlsx$/, '')).expect;

    expect(table.sheet).toBe(want.sheet);
    expect(table.headerRow).toBe(want.headerRow);
    expect(table.columns).toEqual(want.columns);
    expect(table.rows).toHaveLength(want.rowCount as number);
    expect(table.rows.filter((row) => row.nonTabular === true)).toHaveLength(
      want.nonTabularRowCount as number,
    );
    expect(table.rows.filter((row) => row.hidden === true)).toHaveLength(
      want.hiddenRowCount as number,
    );
    expect(table.headerConfirmationRequired ?? false).toBe(want.headerConfirmationRequired);
    expect(table.availableSheets ?? null).toEqual(want.availableSheets);
    expect(table.warnings.map((warning) => warning.code)).toEqual(want.warningCodes);
  });

  it('numbers every row by its workbook row and not by its position (§13)', async () => {
    const table = await parse(fixture('tb_march.xlsx'));
    expect(table.rows[0]?.sourceRef).toBe('sheet:Trial Balance!row:1');
    expect(table.rows[3]?.sourceRef).toBe('sheet:Trial Balance!row:4');
    for (const row of table.rows) {
      expect(row.sourceRef).toBe(`sheet:${table.sheet}!row:${row.rowNumber}`);
    }
  });

  it('keeps the preamble as rows rather than dropping it (IMP-ROW-005)', async () => {
    const table = await parse(fixture('tb_march.xlsx'));
    const preamble = table.rows.filter((row) => row.nonTabular === true);
    expect(preamble.map((row) => row.cells[0])).toEqual([
      'Acme Trading Limited',
      'Trial Balance as at 31 March 2026',
      'All amounts in GBP',
    ]);
  });

  it('proposes rather than detects a header the synonyms cannot confirm (F-B-18)', async () => {
    // Only "Account" names a target on a 12-month P&L; three matches are required, so the row is
    // proposed and the mapping step has to ask.
    const table = await parse(fixture('pnl_multi_period.xlsx'));
    expect(table.headerConfirmationRequired).toBe(true);
    expect(table.columns[0]).toBe('Account');
    expect(table.columns).toHaveLength(13);
    expect(table.rows.map((row) => row.cells[0])).toContain('Total income');
    expect(table.rows.map((row) => row.cells[0])).toContain('Total expenses');
  });
});

describe('parseXlsx — the row-count invariant (SOW §23)', () => {
  it('produces one row per non-empty source row, and none for the blank ones', async () => {
    const bytes = await workbook((wb) => {
      const sheet = wb.addWorksheet('Data');
      sheet.addRow(['Preamble']);
      sheet.addRow([]);
      sheet.addRow(['Date', 'Description', 'Amount']);
      sheet.addRow(['2026-03-01', 'One', 10]);
      sheet.addRow([]);
      sheet.addRow(['2026-03-02', 'Two', 20]);
      sheet.addRow(['  ', null, null]); // whitespace only: not a source row
      sheet.addRow(['2026-03-03', 'Three', 30]);
    });

    const table = await parse(bytes);
    expect(table.rows).toHaveLength(5);
    expect(table.rows.map((row) => row.rowNumber)).toEqual([1, 3, 4, 6, 8]);
    expect(table.headerRow).toBe(2);
    expect(table.rows.filter((row) => row.nonTabular === true)).toHaveLength(1);
  });
});

describe('parseXlsx — merged cells (§5.2)', () => {
  /**
   * The fixture: `Description` and `Amount` are each merged down two rows. The description must be
   * copied into the second row; the amount must NOT be, or the £4,000 is imported twice.
   */
  async function mergedWorkbook(): Promise<Uint8Array> {
    return workbook((wb) => {
      const sheet = wb.addWorksheet('Merged');
      sheet.addRow(['Date', 'Account', 'Description', 'Amount']);
      sheet.addRow(['2026-03-01', 'Sales', 'Quarterly retainer', 4000]);
      sheet.addRow(['2026-03-02', null, null, null]);
      sheet.addRow(['2026-03-03', 'Rent', 'Office', 900]);
      sheet.mergeCells('B2:B3');
      sheet.mergeCells('C2:C3');
      sheet.mergeCells('D2:D3');
    });
  }

  it('copies a merged label down and leaves the merged amount null', async () => {
    const table = await parse(await mergedWorkbook());
    const [, first, second] = table.rows;

    expect(first?.cells).toEqual(['2026-03-01', 'Sales', 'Quarterly retainer', '4000']);
    // Label columns inherit…
    expect(second?.cells[1]).toBe('Sales');
    expect(second?.cells[2]).toBe('Quarterly retainer');
    // …the amount column never does.
    expect(second?.cells[3]).toBeNull();
  });

  it('never repeats money down a merged range', async () => {
    const table = await parse(await mergedWorkbook());
    const amounts = table.rows.slice(1).map((row) => row.cells[3]);
    expect(amounts.filter((amount) => amount === '4000')).toHaveLength(1);
  });

  it('does not inherit into a column whose header matched no synonym', async () => {
    const bytes = await workbook((wb) => {
      const sheet = wb.addWorksheet('Merged');
      sheet.addRow(['Date', 'Description', 'Amount', 'Widget count']);
      sheet.addRow(['2026-03-01', 'One', 10, 7]);
      sheet.addRow(['2026-03-02', 'Two', 20, null]);
      sheet.mergeCells('D2:D3');
    });
    const table = await parse(bytes);
    expect(table.rows[2]?.cells[3]).toBeNull();
  });
});

describe('parseXlsx — dates', () => {
  it('honours the 1900 epoch, including the phantom 29 February 1900', () => {
    expect(excelSerialToIso(1, false)).toBe('1900-01-01');
    expect(excelSerialToIso(59, false)).toBe('1900-02-28');
    // Serial 60 is Excel's date that never existed; it cannot be stored, so it resolves forward.
    expect(excelSerialToIso(60, false)).toBe('1900-03-01');
    expect(excelSerialToIso(61, false)).toBe('1900-03-01');
    expect(excelSerialToIso(45000, false)).toBe('2023-03-15');
  });

  it('honours the 1904 flag, which moves every date by 1,462 days', () => {
    expect(excelSerialToIso(0, true)).toBe('1904-01-01');
    expect(excelSerialToIso(45000, true)).toBe('2027-03-16');
    // The two systems are exactly 1,462 days apart. Reading one as the other shifts a whole
    // workbook by four years and a day, with the day and month still looking plausible.
    expect(excelSerialToIso(45000, true)).not.toBe(excelSerialToIso(45000, false));
    expect(excelSerialToIso(45000 - 1462, true)).toBe(excelSerialToIso(45000, false));
  });

  it('carries a time of day only when the serial has one', () => {
    expect(excelSerialToIso(45000.5, false)).toBe('2023-03-15T12:00:00');
    expect(excelSerialToIso(45000, false)).toBe('2023-03-15');
  });

  it('reads a 1904 workbook as 1904 dates', async () => {
    const bytes = await workbook((wb) => {
      wb.properties.date1904 = true;
      const sheet = wb.addWorksheet('Dates');
      sheet.addRow(['Date', 'Description', 'Amount']);
      const cell = sheet.addRow([null, 'Serial 45000', 10]).getCell(1);
      cell.value = 45000;
      cell.numFmt = 'yyyy-mm-dd';
    });
    const table = await parse(bytes);
    expect(table.rows[1]?.cells[0]).toBe('2027-03-16');
  });

  it('reads the same serial in a 1900 workbook four years earlier', async () => {
    const bytes = await workbook((wb) => {
      wb.properties.date1904 = false;
      const sheet = wb.addWorksheet('Dates');
      sheet.addRow(['Date', 'Description', 'Amount']);
      const cell = sheet.addRow([null, 'Serial 45000', 10]).getCell(1);
      cell.value = 45000;
      cell.numFmt = 'yyyy-mm-dd';
    });
    const table = await parse(bytes);
    expect(table.rows[1]?.cells[0]).toBe('2023-03-15');
  });
});

describe('parseXlsx — hidden rows (IMP-ROW-003)', () => {
  it('imports a hidden row, marks it, and warns', async () => {
    const bytes = await workbook((wb) => {
      const sheet = wb.addWorksheet('Bank');
      sheet.addRow(['Date', 'Description', 'Amount']);
      sheet.addRow(['2026-03-01', 'Visible', 10]);
      sheet.addRow(['2026-03-02', 'Hidden and material', 25000]);
      sheet.addRow(['2026-03-03', 'Visible', 30]);
      sheet.getRow(3).hidden = true;
    });

    const table = await parse(bytes);
    expect(table.rows).toHaveLength(4);
    const hidden = table.rows.filter((row) => row.hidden === true);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.cells[1]).toBe('Hidden and material');
    expect(table.warnings.map((warning) => warning.code)).toContain('IMP-ROW-003');
  });
});

describe('parseXlsx — sheet selection (§5.2)', () => {
  it('uses the only non-empty sheet without asking', async () => {
    const bytes = await workbook((wb) => {
      const sheet = wb.addWorksheet('Bank');
      sheet.addRow(['Date', 'Description', 'Amount']);
      sheet.addRow(['2026-03-01', 'One', 10]);
      wb.addWorksheet('Notes');
    });
    const table = await parse(bytes);
    expect(table.sheet).toBe('Bank');
    expect(table.availableSheets).toBeUndefined();
  });

  it('reports every non-empty sheet when there is a choice, and defaults as documented', async () => {
    const bytes = await workbook((wb) => {
      // Two rows but only one column: not the documented default.
      const notes = wb.addWorksheet('Notes');
      notes.addRow(['Prepared by A Bookkeeper']);
      notes.addRow(['For internal use']);
      const bank = wb.addWorksheet('Bank');
      bank.addRow(['Date', 'Description', 'Amount']);
      bank.addRow(['2026-03-01', 'One', 10]);
    });
    const table = await parse(bytes);
    expect(table.availableSheets).toEqual(['Notes', 'Bank']);
    // The default is the first sheet with at least 2 rows and 3 columns.
    expect(table.sheet).toBe('Bank');
  });

  it('parses the sheet the reviewer chose', async () => {
    const bytes = await workbook((wb) => {
      const a = wb.addWorksheet('January');
      a.addRow(['Date', 'Description', 'Amount']);
      a.addRow(['2026-01-01', 'Jan', 10]);
      const b = wb.addWorksheet('February');
      b.addRow(['Date', 'Description', 'Amount']);
      b.addRow(['2026-02-01', 'Feb', 20]);
    });
    const table = await parse(bytes, 'February');
    expect(table.sheet).toBe('February');
    expect(table.rows[1]?.cells[1]).toBe('Feb');
  });
});

describe('parseXlsx — formulas (§5.2)', () => {
  it('reads the cached result and never evaluates the formula', async () => {
    const bytes = await workbook((wb) => {
      const sheet = wb.addWorksheet('Calc');
      sheet.addRow(['Date', 'Description', 'Amount']);
      const row = sheet.addRow(['2026-03-01', 'Doubled', null]);
      // The cached result disagrees with the formula on purpose: MOTION imports the figure the
      // customer's spreadsheet last showed them, not one it recomputed.
      row.getCell(3).value = { formula: '2*2', result: 4321 };
    });
    const table = await parse(bytes);
    expect(table.rows[1]?.cells[2]).toBe('4321');
  });
});
