import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { PDF_INK, PDF_MUTED, pdfDrawable } from '@/modules/reporting';
import type { MarketingReport } from '../domain/types';
import { PRINT, channels } from './palette';
import { presentMarketingReport, type PresentedSection, type ReportBlock, type ReportTable } from './present';

/**
 * The Marketing report as a PDF (ADR-170): the same content, in the same order, as the Word file —
 * both draw `presentMarketingReport` — on the product's PDF page (`reporting/domain/pdf-kit.ts`):
 * A4, 56pt margins, Helvetica, the composed reports' ink and muted text, and their character
 * cleaning so a curly quote or an em dash cannot stop a render half way.
 *
 * What the composed reports' writer does not have, this one adds for the client's document shape:
 * tables with an orange header row that repeats on a new page, the coral "SECTION 0X" headings,
 * notices on a tinted ground, a running "APX — Finance in motion" header and "Page n of m".
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

/** What the standard fonts can draw: pdf-kit's cleaning, after the document's own bullet and arrow. */
function clean(text: string): string {
  return pdfDrawable(text.replace(/\s*•\s*/g, '  |  ').replace(/→/g, '->'));
}

interface Fonts { readonly body: PDFFont; readonly bold: PDFFont; readonly italic: PDFFont }

interface Word { readonly text: string; readonly font: PDFFont; readonly color: RGB }

/** A run of text in one font and colour, for paragraphs that mix a bold lead with plain text. */
interface Segment { readonly text: string; readonly font: PDFFont; readonly color?: RGB }

class MarketingPdf {
  private page!: PDFPage;
  private y = TOP;

  private constructor(private readonly doc: PDFDocument, private readonly fonts: Fonts) {
    this.newPage();
  }

  static async create(title: string): Promise<MarketingPdf> {
    const doc = await PDFDocument.create();
    doc.setTitle(clean(title));
    doc.setProducer('APX');
    doc.setCreator('APX');
    return new MarketingPdf(doc, {
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
      // Break an over-long word into pieces that fit an empty line.
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

  private drawLine(line: readonly Word[], x: number, y: number, size: number, align: 'left' | 'right' = 'left', width = WIDTH): void {
    const space = this.fonts.body.widthOfTextAtSize(' ', size);
    const total = line.reduce((sum, w, i) => sum + w.font.widthOfTextAtSize(w.text, size) + (i === 0 ? 0 : space), 0);
    let cursor = align === 'right' ? x + width - total : x;
    for (const word of line) {
      this.page.drawText(word.text, { x: cursor, y, size, font: word.font, color: word.color });
      cursor += word.font.widthOfTextAtSize(word.text, size) + space;
    }
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

  bullet(value: string): void {
    const size = 10;
    const lines = this.layout([{ text: value, font: this.fonts.body }], size, WIDTH - 14);
    lines.forEach((line, i) => {
      this.ensure(size + 4);
      if (i === 0) this.page.drawCircle({ x: MARGIN + 4, y: this.y - size + 3.2, size: 1.8, color: ACCENT });
      this.drawLine(line, MARGIN + 14, this.y - size, size);
      this.y -= size + 4;
    });
    this.y -= 2;
  }

  /** A shaded notice with a coloured bar at its left edge. */
  notice(title: string, body: string, bar: RGB): void {
    const size = 8.5;
    const leading = size + 3.5;
    const lines = this.layout([{ text: `${title}.`, font: this.fonts.bold }, { text: body, font: this.fonts.italic }], size, WIDTH - 20);
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

  /** Starts a new page unless `height` fits — never asking for more than a whole page. */
  keep(height: number): void {
    this.ensure(Math.min(height, TOP - BOTTOM));
  }

  private measureTable(t: ReportTable) {
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
    const rows = t.rows.map((row) => row.map((c, i) => cellLines(c.text, c.detail, i === 0 ? this.fonts.bold : this.fonts.body, PDF_INK, widths[i] ?? 0)));
    const total = heightOf(header) + rows.reduce((sum, cells) => sum + heightOf(cells), 0);
    // A table that fits on a page is kept whole; a longer one keeps its header with its first row.
    const start = total <= TOP - BOTTOM ? total : heightOf(header) + (rows[0] ? heightOf(rows[0]) : 0);
    return { size, leading, pad, widths, xs, header, rows, heightOf, start };
  }

  /** The height a table needs on the page before it may begin. */
  tableStart(t: ReportTable): number {
    return this.measureTable(t).start;
  }

  table(t: ReportTable): void {
    const { size, leading, pad, widths, xs, header, rows, heightOf, start } = this.measureTable(t);

    const drawRow = (cells: readonly Word[][][], fill: RGB | null): void => {
      const height = heightOf(cells);
      if (fill !== null) this.page.drawRectangle({ x: MARGIN, y: this.y - height, width: WIDTH, height, color: fill });
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
      // A row that does not fit goes to a new page, under the header again.
      if (this.y - heightOf(cells) < BOTTOM) {
        this.newPage();
        drawRow(header, ORANGE);
      }
      drawRow(cells, r % 2 === 1 ? ZEBRA : null);
    });
    this.y -= 12;
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

function blocks(pdf: MarketingPdf, list: readonly ReportBlock[]): void {
  for (const block of list) {
    switch (block.kind) {
      case 'paragraph':
        pdf.rich([...(block.lead === null ? [] : [{ text: block.lead, font: pdf.bold }]), { text: block.text, font: pdf.body }], { after: 7 });
        break;
      case 'bullets':
        for (const item of block.items) pdf.bullet(item);
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
      case 'concepts':
        for (const c of block.items) {
          pdf.gap(3);
          pdf.rich([{ text: c.number, font: pdf.bold, color: ACCENT }, { text: `- ${c.title}`, font: pdf.bold }], { size: 10.5, after: 2 });
          pdf.rich([{ text: c.description, font: pdf.body }, ...(c.purpose === '' ? [] : [{ text: c.purpose, font: pdf.italic, color: PDF_MUTED }])], { indent: 18, after: 5 });
        }
        break;
      case 'split':
        pdf.rich([
          { text: block.lead, font: pdf.bold },
          { text: block.shares.map((s) => `${s.label} ${s.share}`).join('; ') + (block.note === null ? '' : `. ${block.note}`), font: pdf.body },
        ], { after: 8 });
        break;
    }
  }
}

/** The height a numbered subheading takes, with its space above and below. */
const SUBHEADING = 27;

function section(pdf: MarketingPdf, s: PresentedSection, first: boolean): void {
  if (s.label !== null && !first) pdf.newPage();
  else {
    pdf.keep(80);
    pdf.gap(14);
  }
  pdf.rich(s.label === null
    ? [{ text: s.title, font: pdf.bold, color: ACCENT }]
    : [{ text: s.label, font: pdf.bold, color: ACCENT }, { text: '|', font: pdf.body, color: PDF_MUTED }, { text: s.title, font: pdf.bold }],
  { size: 15, after: 2 });
  pdf.rule(ACCENT, 1.2, 12);
  blocks(pdf, s.blocks);
  for (const sub of s.subsections) {
    // A subheading never sits alone at the foot of a page: it keeps the start of what follows.
    const first = sub.blocks[0];
    pdf.keep(SUBHEADING + (first?.kind === 'table' ? pdf.tableStart(first.table) : 48));
    pdf.gap(6);
    pdf.rich([...(sub.number === null ? [] : [{ text: sub.number, font: pdf.bold, color: ORANGE }]), { text: sub.title, font: pdf.bold }], { size: 11.5, after: 5 });
    blocks(pdf, sub.blocks);
  }
}

export async function renderMarketingPdf(report: MarketingReport): Promise<Uint8Array> {
  const p = presentMarketingReport(report);
  const c = p.cover;
  const pdf = await MarketingPdf.create(p.documentTitle);

  pdf.gap(30);
  pdf.text(c.title, { size: 26, font: pdf.bold, color: ACCENT, after: 6 });
  pdf.text(c.organisationName, { size: 17, font: pdf.bold, after: 6 });
  pdf.text(c.strapline, { size: 9.5, font: pdf.bold, color: ORANGE, after: 3 });
  pdf.text(c.dateLine, { size: 10, color: PDF_MUTED, after: 3 });
  if (c.links.length > 0) pdf.text(c.links.map((link) => `${link.label}: ${link.url}`).join('  |  '), { size: 8.5, color: PDF_MUTED, after: 3 });
  pdf.text(`${p.authorship} Generated ${p.generatedOn}.`, { size: 8.5, font: pdf.italic, color: PDF_MUTED, after: 6 });
  pdf.rule(ORANGE, 1.5, 4);

  p.sections.forEach((s, i) => section(pdf, s, i === 0));

  pdf.gap(14);
  pdf.text(p.provenance, { size: 7.5, font: pdf.italic, color: PDF_MUTED });
  return pdf.save();
}
