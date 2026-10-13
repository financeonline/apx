import type { FundingReportContent } from './funding-report';
import { PdfWriter } from './pdf-kit';

/** The Funding Readiness Report as a PDF (REQ-RP-05): the stored assessment, disclaimer first. */
export async function renderFundingPdf(content: FundingReportContent): Promise<Uint8Array> {
  const a = content.assessment;
  const pdf = await PdfWriter.create(`Funding Readiness Report - ${content.organisationName} - ${content.period.label}`);
  pdf.text(content.organisationName, { size: 18, bold: true, after: 4 });
  pdf.text(`Funding Readiness Report - ${content.period.label}`, { size: 12, muted: true, after: 6 });
  pdf.text(a.disclaimer, { size: 9, after: 8 });

  pdf.heading(a.status === 'scored' ? `Indicative readiness: ${a.score} out of 100 - ${a.band}` : 'Insufficient data');
  pdf.text(`Data coverage ${a.dataCoveragePercent}%; ${a.factorsUsed} of 7 factors scored.`, { size: 9.5, muted: true, after: 6 });

  pdf.heading('The seven factors');
  for (const f of a.factors) {
    pdf.figure(`${f.name} (weight ${f.weight})`, f.score === null ? 'not scored' : String(f.score),
      f.status === 'missing' ? f.missing[0]?.text ?? null : f.capReason === null ? null : `At most 70: ${f.capReason}.`);
  }
  const positives = a.factors.flatMap((f) => f.positives);
  const negatives = a.factors.flatMap((f) => f.negatives);
  pdf.heading('What helps');
  if (positives.length === 0) pdf.text('Nothing here.', { muted: true });
  for (const s of positives) pdf.item(s.text);
  pdf.heading('What holds it back');
  if (negatives.length === 0) pdf.text('Nothing here.', { muted: true });
  for (const s of negatives) pdf.item(s.text);
  pdf.heading('Missing information');
  const missing = a.factors.flatMap((f) => f.missing.map((m) => `${f.name}: ${m.text}`));
  if (missing.length === 0) pdf.text('Nothing is missing.', { muted: true });
  for (const m of missing) pdf.item(m);
  pdf.heading('What would improve readiness');
  if (a.actions.length === 0) pdf.text('Nothing to suggest.', { muted: true });
  for (const x of a.actions) pdf.item(x.text, null, x.priority);

  pdf.gap(8);
  pdf.text(`Rules ${a.rulesVersion}; engine ${a.engineVersion}; assessed ${a.assessedAt.slice(0, 16).replace('T', ' ')} UTC from calculation ${a.calculationRunId.slice(0, 8)}. Produced ${content.composedAt.slice(0, 16).replace('T', ' ')} UTC by APX.`,
    { size: 8.5, muted: true });
  return pdf.save();
}
