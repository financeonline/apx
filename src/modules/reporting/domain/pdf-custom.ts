import type { CustomReportContent } from './custom';
import {
  ANSWER_SECTION_TITLES, CUSTOM_DIMENSION_NAMES, DEGRADED_TEXT, NOTE_TEXT, PRIORITY_LABELS,
  STATEMENT_KIND_LABELS, UNANSWERED_TEXT, UNSUPPORTED_TEXT,
} from './labels-custom';
import { PdfWriter } from './pdf-kit';

/**
 * The Custom AI Report as a PDF (Phase 17, R17-4): each question as asked, and the analyst's stored
 * answer section by section with every statement's kind — exactly what the screen shows.
 */
export async function renderCustomPdf(content: CustomReportContent): Promise<Uint8Array> {
  const pdf = await PdfWriter.create(`Custom AI Report - ${content.organisationName} - ${content.period.label}`);
  pdf.text(content.organisationName, { size: 18, bold: true, after: 4 });
  pdf.text(`Custom AI Report - ${content.period.label}`, { size: 12, muted: true, after: 4 });
  if (content.dimensions.length > 0) {
    pdf.text(`Looking at: ${content.dimensions.map((d) => CUSTOM_DIMENSION_NAMES[d]).join(', ')}.`, { size: 9.5, muted: true, after: 4 });
  }
  pdf.text('Every answer below is the AI Analyst\'s, under its usual checks: figures come from MOTION\'s calculations, '
    + 'and each statement says whether it is a fact, a calculation, an estimate, analysis or a recommendation.',
  { size: 8.5, muted: true, after: 6 });

  content.entries.forEach((entry, index) => {
    pdf.heading(`${index + 1}. ${entry.asked}`);
    const answer = entry.answer;
    if (answer === null || entry.groundingStatus === 'failed') {
      pdf.text(UNANSWERED_TEXT, { muted: true });
      return;
    }
    if (entry.groundingStatus === 'degraded') pdf.text(DEGRADED_TEXT, { size: 9, muted: true, after: 4 });

    pdf.text(answer.direct_answer.statement, { bold: true, after: 1 });
    pdf.text(STATEMENT_KIND_LABELS[answer.direct_answer.kind] ?? '', { size: 8.5, muted: true, after: 4 });

    for (const key of ['key_findings', 'causes', 'risks', 'opportunities'] as const) {
      if (answer[key].length === 0) continue;
      pdf.text(ANSWER_SECTION_TITLES[key], { bold: true, after: 2 });
      for (const statement of answer[key]) {
        pdf.item(statement.statement, null, STATEMENT_KIND_LABELS[statement.kind] ?? null);
      }
    }
    if (answer.recommended_actions.length > 0) {
      pdf.text(ANSWER_SECTION_TITLES.recommended_actions, { bold: true, after: 2 });
      for (const action of answer.recommended_actions) {
        pdf.item(action.title.statement, action.recommendation.statement, PRIORITY_LABELS[action.priority]);
      }
    }
    for (const note of answer.confidence.data_quality_notes) {
      const text = NOTE_TEXT[note.code] ?? note.code.replace(/_/g, ' ');
      pdf.text(`${text.charAt(0).toUpperCase()}${text.slice(1)}${note.period ? ` (${note.period})` : ''}.`, { size: 9, muted: true, after: 1 });
    }
    for (const item of answer.unsupported) {
      pdf.text(`Not covered: ${item.topic} - ${UNSUPPORTED_TEXT[item.reason] ?? 'could not be included'}`, { size: 9, muted: true, after: 1 });
    }
  });

  pdf.gap(8);
  pdf.text(`Produced ${content.composedAt.slice(0, 16).replace('T', ' ')} UTC by MOTION.`, { size: 8.5, muted: true });
  return pdf.save();
}
