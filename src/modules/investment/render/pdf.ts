import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { PDF_INK, PDF_MUTED, pdfDrawable } from '@/modules/reporting';
import type { InvestmentReport } from '../domain/types';
import { PRINT, RISK_CHART_INDEX, channels, printChart } from './palette';
import {
  presentInvestmentReport, type LineChart, type PackBlock, type PackTable, type PresentedChart, type PresentedPackSection,
  type RiskChart, type SplitChart,
} from './present';

/**
 * The Investment Pack as a PDF (ADR-171): the same content, in the same order, as the Word file —
 * both draw `presentInvestmentReport` — on the product's PDF page (`reporting/domain/pdf-kit.ts`,
 * reused through the reporting barrel exactly as the Marketing report's PDF does, ADR-170): A4, 56pt
 * margins, Helvetica, the composed reports' ink and muted text, and their character cleaning so a
 * curly quote or an en dash cannot stop a render half way.
 *
 * The writer is the Marketing report's (tables with an orange header row that repeats on a new page,
 * the coral section headings, notices on a tinted ground, the running "APX — Finance in motion" and
 * "Page n of m") — restated, because that module keeps its writer private — plus what the pack needs:
 * the cover's two headline tiles, the numbered options, the priorities, and the CHARTS, drawn as
 * vectors with pdf-lib:
 *   - the two five-year scenario charts as LINE charts: a money axis from zero with its gridlines, a
 *     line per scenario in its chart colour and its own dash pattern, a dot at each year, and the
 *     scenario's name at the line's end (never told apart by colour alone, UX_ARCHITECTURE.md §11);
 *   - the surplus split as one stacked BAR across the column, with a key that names each part and its
 *     amount;
 *   - the relative risk positioning as a grid of the six levels with each option's dot in its column.
 *
 * Pure: a report in, bytes out. No database, no clock, no network.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const WIDTH = A4.width - MARGIN * 2;
/** Room above and below the column for the running header and the page number. */
const TOP = A4.height - MARGIN - 6;
const BOTTOM = MARGIN + 8;

const colour = (hex: string): RGB => { const c = channels(hex); return rgb(c.r, c.g, c.b); };
const ACCENT = colour(PRINT.accent);
const ORANGE = colour(PRINT.orange);
const ON_ACCENT = colour(PRINT.onAccent);
const RULE = colour(PRINT.rule);
const TINT = colour(PRINT.tint);
const ZEBRA = colour(PRINT.zebra);
const TRACK = colour(PRINT.track);
const chartColour = (index: number): RGB => colour(printChart(index));

/** Each series' dash pattern, as the page's (`CHART_DASH`): solid, dashed, dotted. */
const DASHES: readonly (number[] | undefined)[] = [undefined, [6, 3], [2, 3], [9, 3, 2, 3]];

/** What the standard fonts can draw: pdf-kit's cleaning, after the document's own bullet and arrow. */
function clean(text: string): string {
  return pdfDrawable(text.replace(/\s*•\s*/g, '  |  ').replace(/→/g, '->'));
}

interface Fonts { readonly body: PDFFont; readonly bold: PDFFont; readonly italic: PDFFont }

interface Word { readonly text: string; readonly font: PDFFont; readonly color: RGB }

/** A run of text in one font and colour, for paragraphs that mix a bold lead with plain text. */
interface Segment { readonly text: string; readonly font: PDFFont; readonly color?: RGB }

class InvestmentPdf {
  private page!: PDFPage;
  private y = TOP;

  private constructor(private readonly doc: PDFDocument, private readonly fonts: Fonts) {
    this.newPage();
  }

  static async create(title: string): Promise<InvestmentPdf> {
    const doc = await PDFDocument.create();
    doc.setTitle(clean(title));
    doc.setProducer('APX');
    doc.setCreator('APX');
    return new InvestmentPdf(doc, {
      body: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
      italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    });
  }

  get body(): PDFFont { return this.fonts.body; }
  get bold(): PDFFont { return this.fonts.bold; }
  get italic(): PDFFont { return this.fonts.italic; }

  newPage(): void {
    this.page = this.doc.addPage([A4.width, A4.height]);
    this.y = TOP;
  }

  private ensure(height: number): void {
    if (this.y - height < BOTTOM) this.newPage();
  }

  /** Starts a new page unless `height` fits — never asking for more than a whole page. */
  keep(height: number): void {
    this.ensure(Math.min(height, TOP - BOTTOM));
  }

  gap(points: number): void {
    this.y -= points;
  }

  /** Words that fit `width`, a word longer than the line (a URL) broken where it must be. */
  private wrapWords(words: readonly Word[], size: number, width: number): Word[][] {
    const lines: Word[][] = [];
    let current: Word[] = [];
    let used = 0;
    for (const word of words) {
      let w = word;
      let wordWidth = w.font.widthOfTextAtSize(w.text, size);
      while (wordWidth > width && w.text.length > 1) {
        let cut = w.text.length - 1;
        while (cut > 1 && w.font.widthOfTextAtSize(w.text.slice(0, cut), size) > width) cut -= 1;
        if (current.length > 0) { lines.push(current); current = []; used = 0; }
        lines.push([{ ...w, text: w.text.slice(0, cut) }]);
        w = { ...w, text: w.text.slice(cut) };
        wordWidth = w.font.widthOfTextAtSize(w.text, size);
      }
      const space = current.length === 0 ? 0 : this.fonts.body.widthOfTextAtSize(' ', size);
      if (current.length > 0 && used + space + wordWidth > width) {
        lines.push(current);
        current = [];
        used = 0;
      }
      used += (current.length === 0 ? 0 : space) + wordWidth;
      current.push(w);
    }
    if (current.length > 0) lines.push(current);
    return lines.length === 0 ? [[]] : lines;
  }

  /** Segments laid out as wrapped lines of words. */
  layout(segments: readonly Segment[], size: number, width: number): Word[][] {
    const words = segments.flatMap((s) => clean(s.text).split(/\s+/).filter((t) => t.length > 0)
      .map((text) => ({ text, font: s.font, color: s.color ?? PDF_INK })));
    return this.wrapWords(words, size, width);
  }

  private lineWidth(line: readonly Word[], size: number): number {
    const space = this.fonts.body.widthOfTextAtSize(' ', size);
    return line.reduce((total, w, i) => total + w.font.widthOfTextAtSize(w.text, size) + (i === 0 ? 0 : space), 0);
  }

  private drawLine(line: readonly Word[], x: number, y: number, size: number, align: 'left' | 'right' | 'center' = 'left', width = WIDTH): void {
    const space = this.fonts.body.widthOfTextAtSize(' ', size);
    const used = this.lineWidth(line, size);
    let cursor = align === 'right' ? x + width - used : align === 'center' ? x + (width - used) / 2 : x;
    for (const word of line) {
      this.page.drawText(word.text, { x: cursor, y, size, font: word.font, color: word.color });
      cursor += word.font.widthOfTextAtSize(word.text, size) + space;
    }
  }

  /** One short label at a point, cleaned; returns its width. */
  private label(text: string, x: number, y: number, size: number, font: PDFFont, color: RGB, align: 'left' | 'right' | 'center' = 'left'): number {
    const value = clean(text);
    const width = font.widthOfTextAtSize(value, size);
    const at = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    this.page.drawText(value, { x: at, y, size, font, color });
    return width;
  }

  /** A wrapped paragraph of one or more segments. */
  rich(segments: readonly Segment[], options: { size?: number; indent?: number; after?: number } = {}): void {
    const size = options.size ?? 10;
    const indent = options.indent ?? 0;
    const leading = size + 4;
    for (const line of this.layout(segments, size, WIDTH - indent)) {
      this.ensure(leading);
      this.drawLine(line, MARGIN + indent, this.y - size, size);
      this.y -= leading;
    }
    this.y -= options.after ?? 4;
  }

  text(value: string, options: { size?: number; font?: PDFFont; color?: RGB; indent?: number; after?: number } = {}): void {
    this.rich([{ text: value, font: options.font ?? this.fonts.body, color: options.color }], options);
  }

  /** A horizontal rule across the column. */
  rule(color: RGB, thickness: number, after = 8): void {
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: A4.width - MARGIN, y: this.y }, thickness, color });
    this.y -= after;
  }

  bullet(segments: readonly Segment[]): void {
    const size = 10;
    const lines = this.layout(segments, size, WIDTH - 14);
    lines.forEach((line, i) => {
      this.ensure(size + 4);
      if (i === 0) this.page.drawCircle({ x: MARGIN + 4, y: this.y - size + 3.2, size: 1.8, color: ACCENT });
      this.drawLine(line, MARGIN + 14, this.y - size, size);
      this.y -= size + 4;
    });
    this.y -= 2;
  }

  /** A shaded notice with a coloured bar at its left edge; no title for the disclaimer ("Important: …"). */
  notice(title: string | null, body: string, bar: RGB): void {
    const size = 8.5;
    const leading = size + 3.5;
    const lines = this.layout(title === null
      ? [{ text: body, font: this.fonts.body }]
      : [{ text: `${title}.`, font: this.fonts.bold }, { text: body, font: this.fonts.italic }], size, WIDTH - 20);
    const height = lines.length * leading + 12;
    this.ensure(height + 6);
    this.page.drawRectangle({ x: MARGIN, y: this.y - height, width: WIDTH, height, color: TINT });
    this.page.drawRectangle({ x: MARGIN, y: this.y - height, width: 3, height, color: bar });
    let y = this.y - 6 - size;
    for (const line of lines) {
      this.drawLine(line, MARGIN + 12, y, size);
      y -= leading;
    }
    this.y -= height + 10;
  }

  /** The cover's two headline tiles, side by side. */
  tiles(items: readonly { label: string; figure: string; text: string }[]): void {
    const gutter = 12;
    const width = (WIDTH - gutter * (items.length - 1)) / items.length;
    const pad = 12;
    const textLines = items.map((h) => this.layout([{ text: h.text, font: this.fonts.body, color: PDF_MUTED }], 9, width - pad * 2));
    const height = pad * 2 + 10 + 30 + Math.max(...textLines.map((l) => l.length)) * 12;
    this.ensure(height + 8);
    items.forEach((h, i) => {
      const x = MARGIN + i * (width + gutter);
      const bar = i === 0 ? ACCENT : ORANGE;
      this.page.drawRectangle({ x, y: this.y - height, width, height, color: TINT });
      this.page.drawRectangle({ x, y: this.y - 3, width, height: 3, color: bar });
      this.label(h.label, x + pad, this.y - pad - 8, 8, this.fonts.bold, bar);
      this.label(h.figure, x + pad, this.y - pad - 10 - 26, 24, this.fonts.bold, PDF_INK);
      let y = this.y - pad - 10 - 30 - 10;
      for (const line of textLines[i] ?? []) {
        this.drawLine(line, x + pad, y, 9);
        y -= 12;
      }
    });
    this.y -= height + 12;
  }

  private measureTable(t: PackTable) {
    const size = 8.5;
    const leading = size + 3;
    const pad = 5;
    const widths = t.widths.map((w) => (WIDTH * w) / 100);
    const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const cellLines = (text: string, detail: string | null, font: PDFFont, color: RGB, width: number): Word[][] => [
      ...text.split('\n').flatMap((part) => this.layout([{ text: part, font, color }], size, width - pad * 2)),
      ...(detail === null ? [] : this.layout([{ text: detail, font: this.fonts.body, color: PDF_MUTED }], size, width - pad * 2)),
    ];
    const heightOf = (cells: readonly Word[][][]): number => Math.max(...cells.map((lines) => lines.length)) * leading + pad * 2;
    const header = t.columns.map((column, i) => cellLines(column, null, this.fonts.bold, ON_ACCENT, widths[i] ?? 0));
    const rows = t.rows.map((row, r) => {
      const total = t.total && r === t.rows.length - 1;
      return row.map((c, i) => cellLines(c.text, c.detail, i === 0 || total ? this.fonts.bold : this.fonts.body, PDF_INK, widths[i] ?? 0));
    });
    const whole = heightOf(header) + rows.reduce((total, cells) => total + heightOf(cells), 0);
    // A table that fits on a page is kept whole; a longer one keeps its header with its first row.
    const start = whole <= TOP - BOTTOM ? whole : heightOf(header) + (rows[0] ? heightOf(rows[0]) : 0);
    return { size, leading, pad, widths, xs, header, rows, heightOf, start };
  }

  /** The height a table needs on the page before it may begin. */
  tableStart(t: PackTable): number {
    return this.measureTable(t).start;
  }

  table(t: PackTable): void {
    const { size, leading, pad, widths, xs, header, rows, heightOf, start } = this.measureTable(t);

    const drawRow = (cells: readonly Word[][][], fill: RGB | null, emphasis = false): void => {
      const height = heightOf(cells);
      if (fill !== null) this.page.drawRectangle({ x: MARGIN, y: this.y - height, width: WIDTH, height, color: fill });
      if (emphasis) this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: A4.width - MARGIN, y: this.y }, thickness: 1.2, color: ACCENT });
      cells.forEach((lines, i) => {
        let y = this.y - pad - size + 1;
        for (const line of lines) {
          this.drawLine(line, (xs[i] ?? MARGIN) + pad, y, size, t.numeric[i] ? 'right' : 'left', (widths[i] ?? 0) - pad * 2);
          y -= leading;
        }
      });
      this.y -= height;
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: A4.width - MARGIN, y: this.y }, thickness: 0.5, color: RULE });
    };

    this.ensure(start);
    drawRow(header, ORANGE);
    rows.forEach((cells, r) => {
      if (this.y - heightOf(cells) < BOTTOM) {
        this.newPage();
        drawRow(header, ORANGE);
      }
      const total = t.total && r === rows.length - 1;
      drawRow(cells, total ? TINT : r % 2 === 1 ? ZEBRA : null, total);
    });
    this.y -= 12;
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Charts                                                                                          */
  /* ---------------------------------------------------------------------------------------------- */

  /** The height each chart takes, its title included, so it is never split across a page. */
  chartHeight(c: PresentedChart, titled = true): number {
    const title = titled ? 18 : 0;
    if (c.type === 'lines') return title + 200;
    if (c.type === 'split') return title + 30 + c.slices.length * 14 + 6;
    return title + 22 + c.points.length * 18 + 6;
  }

  private chartTitle(title: string): void {
    this.label(title, MARGIN, this.y - 10, 10, this.fonts.bold, ACCENT);
    this.y -= 18;
  }

  lines(c: LineChart, titled: boolean): void {
    this.keep(this.chartHeight(c, titled));
    if (titled) this.chartTitle(c.title);
    const left = MARGIN + 64;
    const right = MARGIN + WIDTH - 78;
    const top = this.y - 8;
    const bottom = this.y - 172;
    const span = c.max > 0 ? c.max : 1;
    const yOf = (value: number) => bottom + (value / span) * (top - bottom);
    const xOf = (index: number) => (c.categories.length <= 1 ? (left + right) / 2 : left + ((right - left) * index) / (c.categories.length - 1));

    for (const tick of c.ticks) {
      const y = yOf(tick.value);
      this.page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: tick.value === 0 ? 0.8 : 0.4, color: tick.value === 0 ? PDF_MUTED : RULE });
      this.label(tick.label, left - 6, y - 2.5, 7, this.fonts.body, PDF_MUTED, 'right');
    }
    c.categories.forEach((category, i) => this.label(category, xOf(i), bottom - 12, 7.5, this.fonts.body, PDF_MUTED, 'center'));

    // The end labels, moved apart where two lines finish close together.
    const ends: { index: number; y: number }[] = [];
    c.series.forEach((s, index) => {
      const stroke = chartColour(index);
      const points = s.values.map((v, i) => (v === null ? null : { x: xOf(i), y: yOf(v) }));
      points.forEach((point, i) => {
        const next = points[i + 1];
        if (point !== null && next !== null && next !== undefined) {
          this.page.drawLine({ start: point, end: next, thickness: 1.6, color: stroke, dashArray: DASHES[index % DASHES.length] });
        }
      });
      points.forEach((point) => { if (point !== null) this.page.drawCircle({ x: point.x, y: point.y, size: 2, color: stroke }); });
      const last = [...points].reverse().find((point) => point !== null);
      if (last) ends.push({ index, y: last.y });
    });
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i += 1) {
      const below = ends[i - 1];
      const here = ends[i];
      if (below && here && here.y - below.y < 10) here.y = below.y + 10;
    }
    for (const end of ends) {
      const s = c.series[end.index];
      if (s) this.label(s.label, right + 6, end.y - 2.5, 7.5, this.fonts.bold, chartColour(end.index));
    }
    this.y = bottom - 28;
  }

  split(c: SplitChart, titled: boolean): void {
    this.keep(this.chartHeight(c, titled));
    if (titled) this.chartTitle(c.title);
    const height = 16;
    const top = this.y - 4;
    this.page.drawRectangle({ x: MARGIN, y: top - height, width: WIDTH, height, color: TRACK });
    c.slices.forEach((s, i) => {
      const x = MARGIN + (WIDTH * Math.min(100, s.start)) / 100;
      const width = (WIDTH * Math.min(s.percent, Math.max(0, 100 - s.start))) / 100;
      if (width > 0) this.page.drawRectangle({ x, y: top - height, width, height, color: chartColour(i) });
      if (width > 26) this.label(s.share, x + width / 2, top - height + 5, 7.5, this.fonts.bold, ON_ACCENT, 'center');
    });
    let y = top - height - 14;
    c.slices.forEach((s, i) => {
      this.page.drawRectangle({ x: MARGIN, y: y - 1, width: 7, height: 7, color: chartColour(i) });
      this.label(s.label, MARGIN + 12, y, 8.5, this.fonts.body, PDF_INK);
      this.label(`${s.amount} (${s.share})`, MARGIN + 200, y, 8.5, this.fonts.bold, PDF_INK, 'right');
      y -= 14;
    });
    this.y = y - 6;
  }

  risk(c: RiskChart, titled: boolean): void {
    this.keep(this.chartHeight(c, titled));
    if (titled) this.chartTitle(c.title);
    const first = WIDTH * 0.36;
    const column = (WIDTH - first) / c.levels.length;
    const centre = (level: number) => MARGIN + first + column * level + column / 2;
    let y = this.y - 4;
    // The scale: lower on the left, very high on the right, under a rule that runs the same way.
    this.page.drawRectangle({ x: MARGIN, y: y - 16, width: WIDTH, height: 16, color: ORANGE });
    this.label('Option', MARGIN + 5, y - 11, 7.5, this.fonts.bold, ON_ACCENT);
    c.levels.forEach((level, i) => this.label(level.label, centre(i), y - 11, 7, this.fonts.bold, ON_ACCENT, 'center'));
    y -= 16;
    c.points.forEach((p, r) => {
      if (r % 2 === 1) this.page.drawRectangle({ x: MARGIN, y: y - 18, width: WIDTH, height: 18, color: ZEBRA });
      for (let i = 0; i < c.levels.length; i += 1) this.page.drawCircle({ x: centre(i), y: y - 9, size: 1, color: RULE });
      const numberWidth = this.label(p.number, MARGIN + 5, y - 12, 8, this.fonts.bold, ACCENT);
      const name = this.layout([{ text: p.label, font: this.fonts.body }], 8, first - numberWidth - 16)[0] ?? [];
      this.drawLine(name, MARGIN + 5 + numberWidth + 6, y - 12, 8);
      this.page.drawCircle({ x: centre(p.level), y: y - 9, size: 4.5, color: chartColour(RISK_CHART_INDEX[p.risk]) });
      y -= 18;
    });
    this.page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.width - MARGIN, y }, thickness: 0.5, color: RULE });
    this.y = y - 8;
  }

  /** A chart, under its own title unless the heading above it already says the same. */
  chart(c: PresentedChart, titled = true): void {
    if (c.type === 'lines') this.lines(c, titled);
    else if (c.type === 'split') this.split(c, titled);
    else this.risk(c, titled);
  }

  /** The running header and "Page n of m", once every page exists. */
  finish(): void {
    const pages = this.doc.getPages();
    pages.forEach((page, i) => {
      const size = 8;
      const brand = 'APX';
      const rest = clean(' — Finance in motion');
      const restWidth = this.fonts.body.widthOfTextAtSize(rest, size);
      const brandWidth = this.fonts.bold.widthOfTextAtSize(brand, size);
      const x = A4.width - MARGIN - restWidth - brandWidth;
      page.drawText(brand, { x, y: A4.height - MARGIN + 18, size, font: this.fonts.bold, color: ACCENT });
      page.drawText(rest, { x: x + brandWidth, y: A4.height - MARGIN + 18, size, font: this.fonts.body, color: PDF_MUTED });
      const label = `Page ${i + 1} of ${pages.length}`;
      const width = this.fonts.body.widthOfTextAtSize(label, size);
      page.drawText(label, { x: (A4.width - width) / 2, y: MARGIN - 24, size, font: this.fonts.body, color: PDF_MUTED });
    });
  }

  async save(): Promise<Uint8Array> {
    this.finish();
    return this.doc.save();
  }
}

/** `heading`: the title the blocks sit under, so a chart of the same name is not titled twice. */
function blocks(pdf: InvestmentPdf, list: readonly PackBlock[], heading: string | null = null): void {
  for (const block of list) {
    switch (block.kind) {
      case 'paragraph':
        pdf.rich([...(block.lead === null ? [] : [{ text: block.lead, font: pdf.bold }]), { text: block.text, font: pdf.body }], { after: 7 });
        break;
      case 'bullets':
        for (const item of block.items) pdf.bullet([{ text: item, font: pdf.body }]);
        pdf.gap(5);
        break;
      case 'table':
        pdf.table(block.table);
        break;
      case 'note':
        pdf.text(block.text, { size: 8.5, font: pdf.italic, color: PDF_MUTED, after: 7 });
        break;
      case 'notice':
        pdf.notice(block.title, block.text, block.tone === 'warn' ? ORANGE : ACCENT);
        break;
      case 'chart':
        pdf.chart(block.chart, block.chart.title !== heading);
        break;
      case 'options':
        for (const o of block.items) {
          pdf.keep(58);
          pdf.gap(4);
          pdf.rich([{ text: o.number, font: pdf.bold, color: ACCENT }, { text: o.name, font: pdf.bold }], { size: 11, after: 2 });
          pdf.rich([
            { text: 'RISK PROFILE |', font: pdf.bold, color: ORANGE },
            { text: o.riskLabel, font: pdf.bold },
            { text: o.description, font: pdf.body },
          ], { indent: 20, size: 9.5, after: 2 });
          if (o.reference !== null) pdf.rich([{ text: 'Reference:', font: pdf.body, color: PDF_MUTED }, { text: o.reference, font: pdf.body, color: ACCENT }], { indent: 20, size: 8.5, after: 4 });
        }
        pdf.gap(4);
        break;
      case 'priorities':
        for (const p of block.items) {
          pdf.keep(40);
          pdf.gap(3);
          pdf.rich([{ text: p.label, font: pdf.bold, color: ACCENT }, { text: `- ${p.title}`, font: pdf.bold }], { size: 10.5, after: 2 });
          pdf.text(p.text, { indent: 18, after: 5 });
        }
        break;
      case 'links':
        for (const item of block.items) {
          pdf.bullet(item.url === null
            ? [{ text: item.label, font: pdf.body }]
            : item.label === item.url
              ? [{ text: item.url, font: pdf.body, color: ACCENT }]
              : [{ text: `${item.label}:`, font: pdf.body }, { text: item.url, font: pdf.body, color: ACCENT }]);
        }
        pdf.gap(5);
        break;
    }
  }
}

/** The height a subheading takes, with its space above and below. */
const SUBHEADING = 27;

/** What must fit under a heading for it not to sit alone at the foot of a page. */
function firstHeight(pdf: InvestmentPdf, list: readonly PackBlock[], heading: string): number {
  const height = (block: PackBlock | undefined): number => {
    if (block?.kind === 'table') return pdf.tableStart(block.table);
    if (block?.kind === 'chart') return pdf.chartHeight(block.chart, block.chart.title !== heading);
    return 48;
  };
  // A short lead-in paragraph keeps the table or chart it introduces with it.
  const [first, second] = list;
  return first?.kind === 'paragraph' && (second?.kind === 'table' || second?.kind === 'chart') ? 40 + height(second) : height(first);
}

/** The height a section heading takes, with its rule and the space around it. */
const HEADING = 44;

function section(pdf: InvestmentPdf, s: PresentedPackSection): void {
  if (s.newPage) pdf.newPage();
  else {
    // A heading never sits alone at the foot of a page: it keeps the start of what follows.
    pdf.keep(HEADING + firstHeight(pdf, s.blocks, s.title));
    pdf.gap(14);
  }
  pdf.rich(s.label === null
    ? [{ text: s.title, font: pdf.bold, color: ACCENT }]
    : [{ text: s.label, font: pdf.bold, color: ACCENT }, { text: '|', font: pdf.body, color: PDF_MUTED }, { text: s.title, font: pdf.bold }],
  { size: 15, after: 2 });
  pdf.rule(ACCENT, 1.2, 12);
  blocks(pdf, s.blocks, s.title);
  for (const sub of s.subsections) {
    pdf.keep(SUBHEADING + firstHeight(pdf, sub.blocks, sub.title));
    pdf.gap(6);
    pdf.rich([{ text: sub.title, font: pdf.bold }], { size: 11.5, after: 5 });
    blocks(pdf, sub.blocks, sub.title);
  }
}

export async function renderInvestmentPdf(report: InvestmentReport): Promise<Uint8Array> {
  const p = presentInvestmentReport(report);
  const c = p.cover;
  const pdf = await InvestmentPdf.create(p.documentTitle);

  pdf.gap(24);
  pdf.text(c.dateLine, { size: 12, font: pdf.bold, color: ACCENT, after: 6 });
  pdf.text(c.organisationName, { size: 22, font: pdf.bold, after: 6 });
  pdf.text(c.strapline, { size: 9.5, font: pdf.bold, color: ORANGE, after: 10 });
  pdf.rich([{ text: c.objectiveLead, font: pdf.bold }, { text: c.objective, font: pdf.body }], { after: 12 });
  pdf.tiles(c.headlines);
  pdf.text(c.basis, { size: 8.5, color: PDF_MUTED, after: 8 });
  pdf.notice(null, p.disclaimer.text, ORANGE);
  pdf.text(`${p.authorship} Generated ${p.generatedOn}.`, { size: 8.5, font: pdf.italic, color: PDF_MUTED, after: 6 });
  pdf.rule(ORANGE, 1.5, 4);

  p.sections.forEach((s) => section(pdf, s));

  pdf.keep(90);
  pdf.gap(14);
  pdf.text(p.disclaimer.title, { size: 15, font: pdf.bold, color: ACCENT, after: 2 });
  pdf.rule(ACCENT, 1.2, 12);
  pdf.notice(null, p.disclaimer.text, ACCENT);
  pdf.gap(6);
  pdf.text(p.provenance, { size: 7.5, font: pdf.italic, color: PDF_MUTED });
  return pdf.save();
}
