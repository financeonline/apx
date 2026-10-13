import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, Header, HeightRule, LevelFormat, LineRuleType, Packer,
  PageNumber, Paragraph, ShadingType, Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlignTable, WidthType,
} from 'docx';
import type { InvestmentReport } from '../domain/types';
import { PRINT, RISK_CHART_INDEX, printChart } from './palette';
import {
  presentInvestmentReport, type LineChart, type PackBlock, type PackTable, type PresentedChart, type PresentedPackSection,
  type RiskChart, type SplitChart,
} from './present';

/**
 * The Investment Pack as a Word document (ADR-171), laid out as the client's own example: the cover
 * with "INVESTMENT PACK | <month>", the strategic objective and the two headline tiles, then
 * "01 | Converting growth into surplus capital" and the other sections, tables with a coloured header
 * row, the options with their risk profiles, the committee's priorities, the reference links and the
 * important notice. A printed document is light — white paper, dark text — with the APX coral and
 * orange as its accents (`palette.ts`); "APX — Finance in motion" heads every page and the page
 * number foots it, as the Marketing report's Word file (ADR-170).
 *
 * The charts are DRAWN, not pictured. `docx` can embed an image, but a chart image would have to be
 * rasterised on the server (no canvas here, and a PNG of a chart is unreadable to a screen reader and
 * cannot be edited). So each chart is built from Word's own tables, which every Word, LibreOffice and
 * Pages opens the same way:
 *   - the surplus split and the two five-year scenario charts are horizontal BAR charts: a shaded
 *     cell as long as the bar's share of the bar area, a pale track for the rest, the figure printed
 *     at its end, and a colour key for the scenarios — the growth and profit charts grouped by year,
 *     a bar per scenario (`barChart` says why each bar is a table of its own);
 *   - the relative risk positioning is a grid of the six risk levels with each option's dot in its
 *     level's column, its number and name on the left.
 * Every bar carries its figure in words, so the chart is its own text equivalent.
 *
 * Every word comes from `presentInvestmentReport`, the same layout the page and the PDF draw, so the
 * three say the same thing in the same order. Pure: a report in, bytes out.
 */

const FONT = 'Calibri';
/** Half-points: 10.5pt body, as the client's document. */
const BODY = 21;
const SMALL = 18;
const TINY = 16;
const BULLETS = 'apx-bullets';
/** A4 at 2 cm margins, in twips: the width a 100% table spans. */
const TEXT_WIDTH = 11906 - 2 * 1134;
/** A drawn bar's length is rounded to one fortieth of the bar area. */
const UNITS = 40;

interface RunOptions { bold?: boolean; italics?: boolean; color?: string; size?: number }

const run = (text: string, options: RunOptions = {}) =>
  new TextRun({ text, font: FONT, bold: options.bold, italics: options.italics, size: options.size ?? BODY, color: options.color ?? PRINT.ink });

const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE } as const;
const THIN = { style: BorderStyle.SINGLE, size: 4, color: PRINT.rule } as const;

/** A paragraph that adds no space of its own, for table cells. */
const tight = (children: (TextRun | ExternalHyperlink)[], alignment: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT) =>
  new Paragraph({ alignment, spacing: { before: 0, after: 0, line: 240 }, children });

function link(url: string, size = SMALL): ExternalHyperlink {
  return new ExternalHyperlink({
    link: url,
    children: [new TextRun({ text: url, font: FONT, size, color: PRINT.accent, underline: {} })],
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* Tables                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/** A cell's text: one paragraph per line, figures right-aligned, an optional quieter line beneath. */
function cellParagraphs(text: string, detail: string | null, options: { bold: boolean; numeric: boolean; header: boolean }): Paragraph[] {
  const alignment = options.numeric ? AlignmentType.RIGHT : AlignmentType.LEFT;
  const lines = text.split('\n').map((line) => new Paragraph({
    alignment,
    spacing: { before: 0, after: 0 },
    children: [run(line, { bold: options.bold || options.header, size: options.header ? SMALL : 19, color: options.header ? PRINT.onAccent : PRINT.ink })],
  }));
  if (detail !== null) {
    lines.push(new Paragraph({ alignment, spacing: { before: 20, after: 0 }, children: [run(detail, { size: TINY, color: PRINT.muted })] }));
  }
  return lines;
}

function table(t: PackTable): Table {
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
  const body = t.rows.map((row, r) => {
    const total = t.total && r === t.rows.length - 1;
    return new TableRow({
      cantSplit: true,
      children: row.map((c, i) => new TableCell({
        width: { size: widths[i] ?? 0, type: WidthType.DXA },
        shading: total ? { type: ShadingType.CLEAR, color: 'auto', fill: PRINT.tint }
          : r % 2 === 1 ? { type: ShadingType.CLEAR, color: 'auto', fill: PRINT.zebra } : undefined,
        borders: total ? { top: { style: BorderStyle.SINGLE, size: 12, color: PRINT.accent } } : undefined,
        margins,
        children: cellParagraphs(c.text, c.detail, { bold: i === 0 || total, numeric: t.numeric[i] ?? false, header: false }),
      })),
    });
  });
  return new Table({
    rows: [header, ...body],
    width: { size: TEXT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: { top: THIN, bottom: THIN, left: THIN, right: THIN, insideHorizontal: THIN, insideVertical: THIN },
  });
}

/** Space after a table, which Word otherwise butts against the next paragraph. */
const spacer = () => new Paragraph({ spacing: { before: 0, after: 120 }, children: [] });

/* ------------------------------------------------------------------------------------------------ */
/* Charts, drawn with tables                                                                         */
/* ------------------------------------------------------------------------------------------------ */

interface Bar { readonly fraction: number; readonly colour: string; readonly text: string }
interface BarGroup { readonly label: string; readonly bars: readonly Bar[] }

/**
 * A horizontal bar chart. Each group's name is a line of its own, and each bar is a one-row table of
 * its own — the bar's share of the bar area shaded in its colour, the rest a pale track, the figure
 * at its end — parted from the next by a hairline paragraph. One table per bar, rather than one grid
 * for the chart, keeps every bar exactly proportional whatever the viewer does with column widths:
 * Word lays out each table on its fixed widths, and a viewer that sizes columns by their content
 * (Apple's Quick Look) still meets a bar and a track holding non-breaking spaces in proportion to
 * their lengths, so the bar's length is right there too.
 */
function barChart(groups: readonly BarGroup[]): (Paragraph | Table)[] {
  const valueWidth = Math.round(TEXT_WIDTH * 0.22);
  const area = TEXT_WIDTH - valueWidth;
  const flush = { top: 0, bottom: 0, left: 0, right: 0 };
  const fill = (units: number) => tight([run('\u00A0'.repeat(units * 3), { size: TINY })]);
  const hairline = (keepNext: boolean) => new Paragraph({ keepNext, spacing: { before: 0, after: 0, line: 50, lineRule: LineRuleType.EXACT }, children: [] });

  return groups.flatMap((group, g): (Paragraph | Table)[] => [
    new Paragraph({ keepNext: true, spacing: { before: g === 0 ? 0 : 80, after: 30 }, children: [run(group.label, { bold: true, size: TINY })] }),
    ...group.bars.flatMap((bar, b) => {
      const share = Math.min(1, Math.max(0, bar.fraction));
      const filled = share > 0 ? Math.max(1, Math.round(share * UNITS)) : 0;
      const widths = [
        ...(filled > 0 ? [Math.round((area * filled) / UNITS)] : []),
        ...(filled < UNITS ? [area - Math.round((area * filled) / UNITS)] : []),
        valueWidth,
      ];
      const cells = [
        ...(filled > 0 ? [new TableCell({
          width: { size: widths[0] ?? 0, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: bar.colour },
          margins: flush,
          children: [fill(filled)],
        })] : []),
        ...(filled < UNITS ? [new TableCell({
          width: { size: widths[filled > 0 ? 1 : 0] ?? 0, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: PRINT.track },
          margins: flush,
          children: [fill(UNITS - filled)],
        })] : []),
        new TableCell({
          width: { size: valueWidth, type: WidthType.DXA },
          verticalAlign: VerticalAlignTable.CENTER,
          margins: { top: 0, bottom: 0, left: 100, right: 0 },
          children: [tight([run(bar.text, { size: TINY })])],
        }),
      ];
      const last = g === groups.length - 1 && b === group.bars.length - 1;
      return [
        new Table({
          rows: [new TableRow({ cantSplit: true, height: { value: 220, rule: HeightRule.EXACT }, children: cells })],
          width: { size: TEXT_WIDTH, type: WidthType.DXA },
          columnWidths: widths,
          layout: TableLayoutType.FIXED,
          borders: NO_BORDERS,
        }),
        // Keeps the tables apart (Word joins adjacent tables into one) and the group on one page.
        hairline(b < group.bars.length - 1 && !last),
      ];
    }),
  ]);
}

/** "■ 20% growth   ■ 35% growth   ■ 50% growth": the colour key, each name in words. */
function legend(items: readonly { label: string; colour: string }[]): Paragraph {
  return new Paragraph({
    keepNext: true,
    spacing: { before: 0, after: 80 },
    children: items.flatMap((item, i) => [
      ...(i === 0 ? [] : [run('     ', { size: TINY })]),
      run('■ ', { size: SMALL, color: item.colour }),
      run(item.label, { size: TINY, color: PRINT.muted }),
    ]),
  });
}

function linesChart(chart: LineChart): (Paragraph | Table)[] {
  const top = chart.max > 0 ? chart.max : 1;
  const groups = chart.categories.map((label, c): BarGroup => ({
    label,
    bars: chart.series.map((s, i) => ({
      fraction: (s.values[c] ?? 0) / top,
      colour: printChart(i),
      text: s.displays[c] ?? '',
    })),
  }));
  return [legend(chart.series.map((s, i) => ({ label: s.label, colour: printChart(i) }))), ...barChart(groups)];
}

function splitChart(chart: SplitChart): (Paragraph | Table)[] {
  return barChart(chart.slices.map((s, i) => ({
    label: s.label,
    bars: [{ fraction: s.percent / 100, colour: printChart(i), text: `${s.amount} (${s.share})` }],
  })));
}

function riskChart(chart: RiskChart): (Paragraph | Table)[] {
  const first = 34;
  const each = (100 - first) / chart.levels.length;
  const widths = [first, ...chart.levels.map(() => each)].map((w) => Math.round((TEXT_WIDTH * w) / 100));
  const margins = { top: 60, bottom: 60, left: 80, right: 80 };
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: ['Option', ...chart.levels.map((l) => l.label)].map((text, i) => new TableCell({
      width: { size: widths[i] ?? 0, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: PRINT.orange },
      verticalAlign: VerticalAlignTable.CENTER,
      margins,
      children: [tight([run(text, { bold: true, size: TINY, color: PRINT.onAccent })], i === 0 ? AlignmentType.LEFT : AlignmentType.CENTER)],
    })),
  });
  const body = chart.points.map((p, r) => new TableRow({
    cantSplit: true,
    children: [
      new TableCell({
        width: { size: widths[0] ?? 0, type: WidthType.DXA },
        margins,
        shading: r % 2 === 1 ? { type: ShadingType.CLEAR, color: 'auto', fill: PRINT.zebra } : undefined,
        children: [tight([run(`${p.number}  `, { bold: true, size: TINY, color: PRINT.accent }), run(p.label, { size: TINY })])],
      }),
      ...chart.levels.map((_, l) => new TableCell({
        width: { size: widths[l + 1] ?? 0, type: WidthType.DXA },
        margins,
        verticalAlign: VerticalAlignTable.CENTER,
        shading: r % 2 === 1 ? { type: ShadingType.CLEAR, color: 'auto', fill: PRINT.zebra } : undefined,
        children: [tight(l === p.level ? [run('●', { size: 24, color: printChart(RISK_CHART_INDEX[p.risk]) })] : [], AlignmentType.CENTER)],
      })),
    ],
  }));
  return [new Table({
    rows: [header, ...body],
    width: { size: TEXT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: { top: THIN, bottom: THIN, left: NONE, right: NONE, insideHorizontal: THIN, insideVertical: NONE },
  })];
}

/** A chart, under its own title unless the heading above it already says the same. */
function chart(c: PresentedChart, heading: string | null): (Paragraph | Table)[] {
  const title = c.title === heading ? [] : [new Paragraph({
    keepNext: true, spacing: { before: 120, after: 80 }, children: [run(c.title, { bold: true, size: 22, color: PRINT.accent })],
  })];
  const drawn = c.type === 'lines' ? linesChart(c) : c.type === 'split' ? splitChart(c) : riskChart(c);
  return [...title, ...drawn, spacer()];
}

/* ------------------------------------------------------------------------------------------------ */
/* Blocks and sections                                                                               */
/* ------------------------------------------------------------------------------------------------ */

/** A shaded paragraph with a coloured bar; no title for the disclaimer, which starts "Important:". */
function notice(title: string | null, text: string, bar: string): Paragraph {
  return new Paragraph({
    spacing: { before: 60, after: 180 },
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: PRINT.tint },
    border: { left: { style: BorderStyle.SINGLE, size: 24, color: bar, space: 8 } },
    indent: { left: 160 },
    children: [...(title === null ? [] : [run(`${title}. `, { bold: true, size: SMALL })]), run(text, { italics: title !== null, size: SMALL })],
  });
}

/** `heading`: the title the blocks sit under, so a chart of the same name is not titled twice. */
function blocks(list: readonly PackBlock[], heading: string | null = null): (Paragraph | Table)[] {
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
        return [notice(block.title, block.text, block.tone === 'warn' ? PRINT.orange : PRINT.accent)];
      case 'chart':
        return chart(block.chart, heading);
      case 'options':
        return block.items.flatMap((o) => [
          new Paragraph({
            keepNext: true,
            spacing: { before: 160, after: 40 },
            children: [run(o.number, { bold: true, size: 26, color: PRINT.accent }), run(`   ${o.name}`, { bold: true, size: 23 })],
          }),
          new Paragraph({
            keepNext: o.reference !== null,
            spacing: { after: o.reference === null ? 100 : 30 },
            indent: { left: 480 },
            children: [
              run('RISK PROFILE  |  ', { bold: true, size: TINY, color: PRINT.orange }),
              run(o.riskLabel, { bold: true, size: SMALL }),
              run(`     ${o.description}`),
            ],
          }),
          ...(o.reference === null ? [] : [new Paragraph({
            spacing: { after: 100 },
            indent: { left: 480 },
            children: [run('Reference: ', { size: SMALL, color: PRINT.muted }), link(o.reference)],
          })]),
        ]);
      case 'priorities':
        return block.items.flatMap((p) => [
          new Paragraph({
            keepNext: true,
            spacing: { before: 120, after: 40 },
            children: [run(p.label, { bold: true, color: PRINT.accent }), run(`  —  ${p.title}`, { bold: true })],
          }),
          new Paragraph({ spacing: { after: 100 }, indent: { left: 360 }, children: [run(p.text)] }),
        ]);
      case 'links':
        return block.items.map((item, i) => new Paragraph({
          numbering: { reference: BULLETS, level: 0 },
          spacing: { after: i === block.items.length - 1 ? 160 : 60 },
          children: item.url === null
            ? [run(item.label)]
            : item.label === item.url ? [link(item.url, BODY)] : [run(`${item.label}: `), link(item.url, BODY)],
        }));
    }
  });
}

/** "01  |  Converting growth into surplus capital", over a coral rule. */
function section(s: PresentedPackSection): (Paragraph | Table)[] {
  const heading = new Paragraph({
    pageBreakBefore: s.newPage,
    keepNext: true,
    spacing: { before: s.newPage ? 0 : 320, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: PRINT.accent, space: 4 } },
    children: s.label === null
      ? [run(s.title, { bold: true, size: 30, color: PRINT.accent })]
      : [run(s.label, { bold: true, size: 30, color: PRINT.accent }), run('  |  ', { size: 30, color: PRINT.muted }), run(s.title, { bold: true, size: 30 })],
  });
  return [
    heading,
    ...blocks(s.blocks, s.title),
    ...s.subsections.flatMap((sub) => [
      new Paragraph({ keepNext: true, spacing: { before: 220, after: 100 }, children: [run(sub.title, { bold: true, size: 24 })] }),
      ...blocks(sub.blocks, sub.title),
    ]),
  ];
}

export async function renderInvestmentDocx(report: InvestmentReport): Promise<Uint8Array> {
  const p = presentInvestmentReport(report);
  const c = p.cover;

  const tileWidth = Math.floor(TEXT_WIDTH / 2);
  const tiles = new Table({
    width: { size: TEXT_WIDTH, type: WidthType.DXA },
    columnWidths: [tileWidth, TEXT_WIDTH - tileWidth],
    layout: TableLayoutType.FIXED,
    borders: { ...NO_BORDERS, insideVertical: { style: BorderStyle.SINGLE, size: 36, color: 'FFFFFF' } },
    rows: [new TableRow({
      cantSplit: true,
      children: c.headlines.map((h, i) => new TableCell({
        width: { size: i === 0 ? tileWidth : TEXT_WIDTH - tileWidth, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: PRINT.tint },
        borders: { top: { style: BorderStyle.SINGLE, size: 18, color: i === 0 ? PRINT.accent : PRINT.orange } },
        margins: { top: 160, bottom: 160, left: 200, right: 200 },
        children: [
          tight([run(h.label, { bold: true, size: TINY, color: i === 0 ? PRINT.accent : PRINT.orange })]),
          new Paragraph({ spacing: { before: 60, after: 20 }, children: [run(h.figure, { bold: true, size: 48 })] }),
          tight([run(h.text, { size: SMALL, color: PRINT.muted })]),
        ],
      })),
    })],
  });

  const coverBlock: (Paragraph | Table)[] = [
    new Paragraph({ spacing: { before: 400, after: 100 }, children: [run(c.dateLine, { bold: true, size: 24, color: PRINT.accent })] }),
    new Paragraph({ spacing: { after: 100 }, children: [run(c.organisationName, { bold: true, size: 44 })] }),
    new Paragraph({ spacing: { after: 200 }, children: [run(c.strapline, { bold: true, size: 20, color: PRINT.orange })] }),
    new Paragraph({ spacing: { after: 200 }, children: [run(`${c.objectiveLead} `, { bold: true }), run(c.objective)] }),
    tiles,
    new Paragraph({ spacing: { before: 160, after: 80 }, children: [run(c.basis, { size: SMALL, color: PRINT.muted })] }),
    notice(null, p.disclaimer.text, PRINT.orange),
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
      children: [new TextRun({ font: FONT, size: TINY, color: PRINT.muted, children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES] })],
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
        ...p.sections.flatMap(section),
        new Paragraph({
          keepNext: true,
          spacing: { before: 360, after: 120 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: PRINT.accent, space: 4 } },
          children: [run(p.disclaimer.title, { bold: true, size: 30, color: PRINT.accent })],
        }),
        notice(null, p.disclaimer.text, PRINT.accent),
        new Paragraph({ spacing: { before: 240 }, children: [run(p.provenance, { italics: true, size: TINY, color: PRINT.muted })] }),
      ],
    }],
  });

  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
