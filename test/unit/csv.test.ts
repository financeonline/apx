import { describe, expect, it } from 'vitest';
import { csvCell, csvLine, defuseCell } from '@/core/csv';

/** CSV injection defence and RFC 4180 quoting (SECURITY_MODEL.md §8 step 4). */
describe('csv output', () => {
  it('defuses every dangerous leading character with an apostrophe', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      expect(defuseCell(`${lead}SUM(A1)`)).toBe(`'${lead}SUM(A1)`);
    }
    expect(defuseCell('TESCO STORES')).toBe('TESCO STORES');
  });
  it('keeps the apostrophe when the cell is also quoted', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
  });
  it('quotes delimiters and line breaks and doubles quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });
  it('writes null as an empty cell and ends a line with CRLF', () => {
    expect(csvLine(['2026-03-01', null, '-5.00'])).toBe('2026-03-01,,-5.00\r\n');
  });
  it('writes a plain signed number as a number, and defuses a minus that leads anything else', () => {
    // "-5.00" is a number to every spreadsheet and cannot execute; "-1+cmd|' /C calc'!A0" can.
    expect(csvCell('-5.00')).toBe('-5.00');
    expect(csvCell('+12')).toBe('+12');
    // Defused, and not quoted: it holds no comma, quote or line break.
    expect(csvCell("-1+cmd|' /C calc'!A0")).toBe("'-1+cmd|' /C calc'!A0");
    expect(csvCell('-abc')).toBe("'-abc");
  });
});
