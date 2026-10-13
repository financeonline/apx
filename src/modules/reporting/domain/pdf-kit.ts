import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * A small A4 writer for the composed reports (Phase 17), in the monthly report's style
 * (`pdf.ts`): Helvetica, one column, figures right-aligned. Unlike the monthly page it WRAPS: a
 * brief carries alerts' own sentences, which are longer than a line.
 *
 * Pure: no database, no clock, no network.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const WIDTH = A4.width - MARGIN * 2;
export const INK = rgb(0.086, 0.129, 0.118);
export const MUTED = rgb(0.361, 0.404, 0.388);
const RULE = rgb(0.894, 0.878, 0.839);

/** Strips what a PDF's standard fonts cannot draw, rather than throwing mid-render. */
export function drawable(text: string): string {
  return text
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/−/g, '-')
    .replace(/…/g, '...')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E£€]/g, '');
}

export class PdfWriter {
  private page!: PDFPage;
  private y = 0;

  private constructor(private readonly doc: PDFDocument, private readonly body: PDFFont, private readonly bold: PDFFont) {
    this.newPage();
  }

  static async create(title: string): Promise<PdfWriter> {
    const doc = await PDFDocument.create();
    doc.setTitle(drawable(title));
    doc.setProducer('APX');
    doc.setCreator('APX');
    return new PdfWriter(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  }

  private newPage(): void {
    this.page = this.doc.addPage([A4.width, A4.height]);
    this.y = A4.height - MARGIN;
  }

  private ensure(height: number): void {
    if (this.y - height < MARGIN) this.newPage();
  }

  private wrap(text: string, size: number, font: PDFFont, width: number): string[] {
    const words = drawable(text).split(/\s+/).filter((word) => word.length > 0);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= width || current === '') {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current !== '') lines.push(current);
    return lines.length === 0 ? [''] : lines;
  }

  /** A paragraph, wrapped to the column. */
  text(value: string, options: { size?: number; bold?: boolean; muted?: boolean; after?: number; indent?: number } = {}): void {
    const size = options.size ?? 10.5;
    const font = options.bold ? this.bold : this.body;
    const indent = options.indent ?? 0;
    const leading = size + 4;
    for (const line of this.wrap(value, size, font, WIDTH - indent)) {
      this.ensure(leading);
      this.page.drawText(line, {
        x: MARGIN + indent, y: this.y, size, font, color: options.muted ? MUTED : INK,
      });
      this.y -= leading;
    }
    this.y -= options.after ?? 2;
  }

  heading(value: string): void {
    this.ensure(40);
    this.y -= 6;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y + 12 }, end: { x: A4.width - MARGIN, y: this.y + 12 },
      thickness: 0.5, color: RULE,
    });
    this.y -= 4;
    this.text(value, { size: 13, bold: true, after: 6 });
  }

  /** A label and a right-aligned figure, with an optional muted note beneath. */
  figure(label: string, value: string, note?: string | null): void {
    this.ensure(20);
    const shown = drawable(value);
    const valueWidth = this.bold.widthOfTextAtSize(shown, 11);
    const labelLines = this.wrap(label, 10.5, this.body, WIDTH - valueWidth - 16);
    this.page.drawText(shown, { x: A4.width - MARGIN - valueWidth, y: this.y, size: 11, font: this.bold, color: INK });
    for (const line of labelLines) {
      this.ensure(15);
      this.page.drawText(line, { x: MARGIN, y: this.y, size: 10.5, font: this.body, color: INK });
      this.y -= 15;
    }
    if (note !== undefined && note !== null && note !== '') this.text(note, { size: 8.5, muted: true, after: 4 });
    else this.y -= 2;
  }

  /** A bulleted item: a bold first line and an optional wrapped description. */
  item(title: string, detail?: string | null, meta?: string | null): void {
    this.text(`- ${title}`, { size: 10.5, bold: true, after: 0 });
    if (detail) this.text(detail, { size: 9.5, muted: true, indent: 9, after: 0 });
    if (meta) this.text(meta, { size: 8.5, muted: true, indent: 9, after: 0 });
    this.y -= 4;
  }

  gap(points: number): void {
    this.y -= points;
  }

  async save(): Promise<Uint8Array> {
    return this.doc.save();
  }
}
