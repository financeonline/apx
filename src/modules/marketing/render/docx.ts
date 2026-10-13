import {
  AlignmentType, BorderStyle, Document, Footer, Header, LevelFormat, Packer, PageNumber, Paragraph, ShadingType,
  Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlignTable, WidthType,
} from 'docx';
import type { MarketingReport } from '../domain/types';
import { PRINT } from './palette';
import { presentMarketingReport, type PresentedSection, type ReportBlock, type ReportTable } from './present';

/**
 * The Marketing report as a Word document (ADR-170), laid out as the client's own example: a cover
 * block, "SECTION 0X | Title" headings with numbered subheadings beneath, tables with a coloured
 * header row, bullets, the notes in italics. A printed document is light — white paper, dark text —
 * with the APX coral and orange as its accents (`palette.ts`). "APX — Finance in motion" heads every
 * page and the page number foots it.
 *
 * Every word comes from `presentMarketingReport`, the same layout the page and the PDF draw, so the
 * three say the same thing in the same order. `docx` builds the file in memory (pure JavaScript, no
 * Word, no template on disk).
 *
 * Pure: a report in, bytes out.
 */

const FONT = 'Calibri';
/** Half-points: 10.5pt body, as the client's document. */
const BODY = 21;
const SMALL = 18;
const BULLETS = 'apx-bullets';
/** A4 at 2 cm margins, in twips: the width a 100% table spans. */
const TEXT_WIDTH = 11906 - 2 * 1134;

const run = (text: string, options: { bold?: boolean; italics?: boolean; color?: string; size?: number } = {}) =>
  new TextRun({ text, font: FONT, bold: options.bold, italics: options.italics, size: options.size ?? BODY, color: options.color ?? PRINT.ink });

/** A cell's text: one paragraph per line, the first column bold, figures right-aligned. */
function cellParagraphs(text: string, detail: string | null, options: { bold: boolean; numeric: boolean; header: boolean }): Paragraph[] {
  const alignment = options.numeric ? AlignmentType.RIGHT : AlignmentType.LEFT;
  const lines = text.split('\n').map((line) => new Paragraph({
    alignment,
    spacing: { before: 0, after: 0 },
    children: [run(line, {
      bold: options.bold || options.header,
      size: options.header ? SMALL : 19,
      color: options.header ? PRINT.onAccent : PRINT.ink,
    })],
  }));
  if (detail !== null) {
    lines.push(new Paragraph({ alignment, spacing: { before: 20, after: 0 }, children: [run(detail, { size: SMALL, color: PRINT.muted })] }));
  }
  return lines;
}

function table(t: ReportTable): Table {
  const thin = { style: BorderStyle.SINGLE, size: 4, color: PRINT.rule };
  const widths = t.widths.map((w) => Math.round((TEXT_WIDTH * w) / 100));
  const margins = { top: 80, bottom: 80, left: 110, right: 110 };
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: t.columns.map((column, i) => new TableCell({
      width: { size: widths[i] ?? 0, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: PRINT.orange },
      verticalAlign: VerticalAlignTable.CENTER,
      margins,
      children: cellParagraphs(column, null, { bold: true, numeric: t.numeric[i] ?? false, header: true }),
    })),
  });
  const body = t.rows.map((row, r) => new TableRow({
    cantSplit: true,
    children: row.map((c, i) => new TableCell({
      width: { size: widths[i] ?? 0, type: WidthType.DXA },
      shading: r % 2 === 1 ? { type: ShadingType.CLEAR, color: 'auto', fill: PRINT.zebra } : undefined,
      margins,
      children: cellParagraphs(c.text, c.detail, { bold: i === 0, numeric: t.numeric[i] ?? false, header: false }),
    })),
  }));
  return new Table({
    rows: [header, ...body],
    width: { size: TEXT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: { top: thin, bottom: thin, left: thin, right: thin, insideHorizontal: thin, insideVertical: thin },
  });
}

/** Space after a table, which Word otherwise butts against the next paragraph. */
const spacer = () => new Paragraph({ spacing: { before: 0, after: 120 }, children: [] });

function blocks(list: readonly ReportBlock[]): (Paragraph | Table)[] {
  return list.flatMap((block): (Paragraph | Table)[] => {
    switch (block.kind) {
      case 'paragraph':
        return [new Paragraph({
          spacing: { after: 140 },
          children: [...(block.lead === null ? [] : [run(`${block.lead} `, { bold: true })]), run(block.text)],
        })];
      case 'bullets':
        return block.items.map((item, i) => new Paragraph({
          numbering: { reference: BULLETS, level: 0 },
          spacing: { after: i === block.items.length - 1 ? 160 : 60 },
          children: [run(item)],
        }));
      case 'table':
        return [table(block.table), spacer()];
      case 'note':
        return [new Paragraph({ spacing: { after: 140 }, children: [run(block.text, { italics: true, size: SMALL, color: PRINT.muted })] })];
      case 'notice':
        return [new Paragraph({
          spacing: { before: 60, after: 180 },
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: PRINT.tint },
          border: { left: { style: BorderStyle.SINGLE, size: 24, color: block.tone === 'warn' ? PRINT.orange : PRINT.accent, space: 8 } },
          indent: { left: 160 },
          children: [run(`${block.title}. `, { bold: true, size: SMALL }), run(block.text, { italics: true, size: SMALL })],
        })];
      case 'concepts':
        return block.items.flatMap((c) => [
          new Paragraph({
            keepNext: true,
            spacing: { before: 120, after: 40 },
            children: [run(c.number, { bold: true, color: PRINT.accent }), run(`  —  ${c.title}`, { bold: true })],
          }),
          new Paragraph({
            spacing: { after: 100 },
            indent: { left: 360 },
            children: [run(c.description), ...(c.purpose === '' ? [] : [run(` ${c.purpose}`, { italics: true, color: PRINT.muted })])],
          }),
        ]);
      case 'split':
        return [new Paragraph({
          spacing: { after: 160 },
          children: [
            run(`${block.lead} `, { bold: true }),
            run(block.shares.map((s) => `${s.label} ${s.share}`).join('; ')),
            ...(block.note === null ? [] : [run(`. ${block.note}`)]),
          ],
        })];
    }
  });
}

/** "SECTION 01  |  Competitor & sector profiling", over a coral rule; each section starts a page. */
function section(s: PresentedSection, first: boolean): (Paragraph | Table)[] {
  const heading = new Paragraph({
    pageBreakBefore: s.label !== null && !first,
    keepNext: true,
    spacing: { before: s.label === null ? 280 : 0, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: PRINT.accent, space: 4 } },
    children: s.label === null
      ? [run(s.title, { bold: true, size: 30, color: PRINT.accent })]
      : [run(s.label, { bold: true, size: 30, color: PRINT.accent }), run('  |  ', { size: 30, color: PRINT.muted }), run(s.title, { bold: true, size: 30 })],
  });
  return [
    heading,
    ...blocks(s.blocks),
    ...s.subsections.flatMap((sub) => [
      new Paragraph({
        keepNext: true,
        spacing: { before: 220, after: 100 },
        children: [
          ...(sub.number === null ? [] : [run(`${sub.number} `, { bold: true, size: 24, color: PRINT.orange })]),
          run(sub.title, { bold: true, size: 24 }),
        ],
      }),
      ...blocks(sub.blocks),
    ]),
  ];
}

export async function renderMarketingDocx(report: MarketingReport): Promise<Uint8Array> {
  const p = presentMarketingReport(report);
  const c = p.cover;

  const coverBlock = [
    new Paragraph({ spacing: { before: 600, after: 80 }, children: [run(c.title, { bold: true, size: 56, color: PRINT.accent })] }),
    new Paragraph({ spacing: { after: 120 }, children: [run(c.organisationName, { bold: true, size: 36 })] }),
    new Paragraph({ spacing: { after: 80 }, children: [run(c.strapline, { bold: true, size: 20, color: PRINT.orange })] }),
    new Paragraph({ spacing: { after: 60 }, children: [run(c.dateLine, { color: PRINT.muted })] }),
    ...(c.links.length === 0 ? [] : [new Paragraph({
      spacing: { after: 240 },
      children: c.links.flatMap((link, i) => [
        ...(i === 0 ? [] : [run('    |    ', { size: SMALL, color: PRINT.muted })]),
        run(`${link.label}: `, { size: SMALL, color: PRINT.muted }),
        run(link.url, { size: SMALL }),
      ]),
    })]),
    new Paragraph({
      spacing: { after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: PRINT.orange, space: 1 } },
      children: [run(`${p.authorship} Generated ${p.generatedOn}.`, { italics: true, size: SMALL, color: PRINT.muted })],
    }),
  ];

  const header = new Header({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [run('APX', { bold: true, size: SMALL, color: PRINT.accent }), run(' — Finance in motion', { size: SMALL, color: PRINT.muted })],
    })],
  });
  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ font: FONT, size: 16, color: PRINT.muted, children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES] }),
      ],
    })],
  });

  const doc = new Document({
    title: p.documentTitle,
    creator: 'APX',
    lastModifiedBy: 'APX',
    description: p.provenance,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: BODY, color: PRINT.ink },
          paragraph: { spacing: { after: 120, line: 276 } },
        },
      },
    },
    numbering: {
      config: [{
        reference: BULLETS,
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: '•',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 360, hanging: 260 } }, run: { color: PRINT.accent } },
        }],
      }],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134, header: 567, footer: 567 } } },
      headers: { default: header },
      footers: { default: footer },
      children: [
        ...coverBlock,
        ...p.sections.flatMap((s, i) => section(s, i === 0)),
        new Paragraph({ spacing: { before: 360 }, children: [run(p.provenance, { italics: true, size: 16, color: PRINT.muted })] }),
      ],
    }],
  });

  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
