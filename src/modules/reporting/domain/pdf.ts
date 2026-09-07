import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ReportViewModel } from './types';

/**
 * The Monthly Management Report as a PDF (ADR-024; plan Phase 13 slice 2).
 *
 * Pure: a view model in, bytes out. No database, no clock, no network — so the same report always
 * renders the same document, and the job that stores it can be tested without one.
 *
 * `pdf-lib` rather than a headless browser. A browser would give richer layout and would also mean
 * shipping Chromium into the job runtime for one A4 page of figures the product already formats;
 * the PDF is a record of numbers, not a second design system.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const INK = rgb(0.086, 0.129, 0.118);
const MUTED = rgb(0.361, 0.404, 0.388);
const RULE = rgb(0.894, 0.878, 0.839);

interface Cursor { page: PDFPage; y: number }

interface Fonts { body: PDFFont; bold: PDFFont }

/** Strips what a PDF's standard fonts cannot draw, rather than throwing mid-render. */
function drawable(text: string): string {
  return text.normalize('NFKD').replace(/[^\x20-\x7E£€]/g, '');
}

function line(
  cursor: Cursor, doc: PDFDocument, fonts: Fonts,
  text: string, options: { size?: number; bold?: boolean; colour?: typeof INK; gap?: number } = {},
): void {
  const size = options.size ?? 11;
  const gap = options.gap ?? size + 6;
  if (cursor.y - gap < MARGIN) {
    cursor.page = doc.addPage([A4.width, A4.height]);
    cursor.y = A4.height - MARGIN;
  }
  cursor.page.drawText(drawable(text), {
    x: MARGIN,
    y: cursor.y,
    size,
    font: options.bold ? fonts.bold : fonts.body,
    color: options.colour ?? INK,
  });
  cursor.y -= gap;
}

function rule(cursor: Cursor): void {
  cursor.page.drawLine({
    start: { x: MARGIN, y: cursor.y + 6 },
    end: { x: A4.width - MARGIN, y: cursor.y + 6 },
    thickness: 0.5,
    color: RULE,
  });
  cursor.y -= 10;
}

/** A figure and its label on one row, the figure right-aligned as an accountant expects. */
function figure(
  cursor: Cursor, doc: PDFDocument, fonts: Fonts, label: string, value: string, note?: string,
): void {
  if (cursor.y - 20 < MARGIN) {
    cursor.page = doc.addPage([A4.width, A4.height]);
    cursor.y = A4.height - MARGIN;
  }
  cursor.page.drawText(drawable(label), {
    x: MARGIN, y: cursor.y, size: 11, font: fonts.body, color: INK,
  });
  const text = drawable(value);
  const width = fonts.bold.widthOfTextAtSize(text, 12);
  cursor.page.drawText(text, {
    x: A4.width - MARGIN - width, y: cursor.y - 1, size: 12, font: fonts.bold, color: INK,
  });
  cursor.y -= 16;
  if (note !== undefined && note !== '') {
    cursor.page.drawText(drawable(note), {
      x: MARGIN, y: cursor.y, size: 9, font: fonts.body, color: MUTED,
    });
    cursor.y -= 13;
  }
}

export async function renderReportPdf(report: ReportViewModel): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    body: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  doc.setTitle(`Monthly Management Report — ${report.organisationName} — ${report.period.label}`);
  doc.setProducer('MOTION');
  doc.setCreator('MOTION');

  const page = doc.addPage([A4.width, A4.height]);
  const cursor: Cursor = { page, y: A4.height - MARGIN };

  line(cursor, doc, fonts, report.organisationName, { size: 18, bold: true, gap: 24 });
  line(cursor, doc, fonts, `Monthly Management Report — ${report.period.label}`,
    { size: 12, colour: MUTED, gap: 20 });
  rule(cursor);

  line(cursor, doc, fonts, report.summary, { size: 12, gap: 20 });
  line(cursor, doc, fonts, report.basisLine, { size: 9, colour: MUTED, gap: 22 });

  line(cursor, doc, fonts, 'The headline numbers', { size: 13, bold: true, gap: 20 });
  for (const card of report.cards) {
    figure(cursor, doc, fonts, card.label, card.value, card.change?.text ?? undefined);
  }
  cursor.y -= 8;

  if (report.health !== null && report.health.score !== null) {
    rule(cursor);
    line(cursor, doc, fonts, 'Business health', { size: 13, bold: true, gap: 20 });
    figure(cursor, doc, fonts, 'Score out of 100', String(report.health.score),
      `Based on ${report.health.dimensionsUsed} of ${report.health.dimensionsTotal} areas`);
    cursor.y -= 8;
  }

  if (report.alerts.length > 0) {
    rule(cursor);
    line(cursor, doc, fonts, 'What needs attention', { size: 13, bold: true, gap: 20 });
    for (const alert of report.alerts) {
      line(cursor, doc, fonts, alert.title, { size: 11, bold: true, gap: 15 });
      line(cursor, doc, fonts, alert.explanation, { size: 10, colour: MUTED, gap: 14 });
      if (alert.recommendedNextStep !== null) {
        line(cursor, doc, fonts, `Next step: ${alert.recommendedNextStep}`,
          { size: 10, colour: MUTED, gap: 16 });
      }
    }
    cursor.y -= 4;
  }

  if (report.openActions.length > 0) {
    rule(cursor);
    line(cursor, doc, fonts, 'What we are doing about it', { size: 13, bold: true, gap: 20 });
    for (const action of report.openActions) {
      line(cursor, doc, fonts, action.title, { size: 11, gap: 14 });
      line(cursor, doc, fonts,
        `${action.priority} · ${action.dueDate ?? 'no date set'}`,
        { size: 9, colour: MUTED, gap: 16 });
    }
  }

  /*
   * The provenance line. A printed page outlives the screen it came from, so it says which run
   * produced these figures — otherwise a report found in a drawer in six months cannot be tied back
   * to anything (EVIDENCE_MODEL.md §1).
   */
  cursor.y -= 6;
  rule(cursor);
  const asOf = report.asOf.finishedAt === null
    ? 'Figures as last calculated by MOTION.'
    : `Figures as calculated on ${report.asOf.finishedAt.slice(0, 10)}`
      + `${report.asOf.engineVersion === null ? '' : ` by engine ${report.asOf.engineVersion}`}.`;
  line(cursor, doc, fonts, asOf, { size: 9, colour: MUTED, gap: 12 });
  line(cursor, doc, fonts, `Produced ${report.generatedAt.slice(0, 10)} by MOTION.`,
    { size: 9, colour: MUTED, gap: 12 });

  return doc.save();
}
