import { PdfWriter } from './pdf-kit';
import type { SummaryEditionView } from './summary';

/**
 * The summary edition of the Monthly Management Report as a PDF (ADR-172 addendum).
 *
 * Pure: the composed view in, bytes out. It prints exactly the view's fields and nothing it could
 * reach for — the view has no alerts, actions, names or per-account lines to print (`summary.ts`).
 *
 * The cover says which edition this is, for whom, and what is left out, BEFORE the first figure: a
 * document that travels to a lender must not be mistaken for the whole report, and a reader who
 * wants the rest is told it exists rather than left to assume there is nothing more.
 */
export async function renderSummaryPdf(view: SummaryEditionView): Promise<Uint8Array> {
  const pdf = await PdfWriter.create(`${view.title} - ${view.organisationName} - ${view.period.label}`);

  pdf.text(view.organisationName, { size: 18, bold: true, after: 4 });
  pdf.text(`${view.title} - ${view.period.label}`, { size: 12, muted: true, after: 8 });
  pdf.text(view.notice, { size: 11, bold: true, after: 4 });
  pdf.text(view.leftOut, { size: 9, muted: true, after: 8 });

  pdf.text(view.summary, { size: 12, after: 4 });
  pdf.text(view.basisLine, { size: 9, muted: true, after: 6 });

  pdf.heading('The headline numbers');
  if (view.figures.length === 0) pdf.text('No headline figure is available for this month.', { muted: true });
  for (const figure of view.figures) {
    const notes = [
      figure.secondary === null ? null : `${figure.secondary.label}: ${figure.secondary.value}`,
      figure.change,
      // "—" is already the value of a figure that is not available; the badge would say it twice.
      figure.status === null || figure.status === '—' ? null : figure.status,
    ].filter((note): note is string => note !== null && note !== '');
    pdf.figure(figure.label, figure.value, notes.length === 0 ? null : notes.join('; '));
  }

  pdf.heading('Business Health Score');
  const health = view.health;
  if (health === null || health.score === null) {
    pdf.text(health === null
      ? 'No Business Health Score is available for this month.'
      : `Not enough of the business could be scored this month (${health.dimensionsUsed} of ${health.dimensionsTotal} areas).`,
    { muted: true });
  } else {
    pdf.figure('Score out of 100', String(health.score), [
      health.band,
      `Based on ${health.dimensionsUsed} of ${health.dimensionsTotal} areas`,
      health.changeText,
    ].filter((part): part is string => part !== null).join('; '));
  }
  if (health !== null) {
    for (const area of health.areas) {
      pdf.figure(area.label, area.score === null ? 'not scored' : String(area.score), area.note);
      for (const line of area.helped) pdf.text(`+ ${line}`, { size: 9, muted: true, indent: 9, after: 0 });
      for (const line of area.heldBack) pdf.text(`- ${line}`, { size: 9, muted: true, indent: 9, after: 0 });
      if (area.helped.length + area.heldBack.length > 0) pdf.gap(4);
    }
    pdf.gap(4);
    pdf.text(health.disclaimer, { size: 8.5, muted: true });
  }

  /*
   * Provenance, as the full report prints it: a page that outlives the screen it came from says
   * which run produced its figures (EVIDENCE_MODEL.md §1).
   */
  pdf.gap(8);
  const asOf = view.asOf.finishedAt === null
    ? 'Figures as last calculated by APX.'
    : `Figures as calculated on ${view.asOf.finishedAt.slice(0, 10)}`
      + `${view.asOf.engineVersion === null ? '' : ` by engine ${view.asOf.engineVersion}`}.`;
  pdf.text(asOf, { size: 8.5, muted: true, after: 0 });
  pdf.text(`Produced ${view.generatedAt.slice(0, 10)} by APX (${view.version}).`, { size: 8.5, muted: true });
  return pdf.save();
}
