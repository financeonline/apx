import { formatMoney } from '@/core/money';
import type { InterimFigure } from '@/modules/financial-engine';
import type { AdviserContent } from './adviser';
import type { BriefActionLine, BriefAlertLine, BriefContent, BriefMonth } from './brief';
import {
  INTERIM_DISCLAIMER, INTERIM_LABELS, INTERIM_NOTES, INTERIM_STATUS_LABELS, PRIORITY_LABELS,
  REPORT_DIMENSION_LABELS, REPORT_EXCLUSION_TEXT, SEVERITY_LABELS, windowLabel,
} from './labels';
import { PdfWriter } from './pdf-kit';

/**
 * PDFs of the composed reports (Phase 17). They render the STORED content and nothing else, so the
 * PDF of a brief says what the brief said, word for word, whenever it is produced.
 */

/** To the penny: interim figures are small enough that pence matter. */
const money = (value: string, currency: string, signed = false) =>
  formatMoney(value, { currency, signDisplay: signed ? 'always' : 'auto', showMinorUnits: true });

function alertItems(pdf: PdfWriter, alerts: readonly BriefAlertLine[], total: number, empty: string): void {
  if (alerts.length === 0) { pdf.text(empty, { muted: true, after: 6 }); return; }
  for (const alert of alerts) {
    pdf.item(`${SEVERITY_LABELS[alert.severity]} - ${alert.title}`, alert.explanation,
      alert.nextStep === null ? null : `Next step: ${alert.nextStep}`);
  }
  if (total > alerts.length) pdf.text(`…and ${total - alerts.length} more.`, { muted: true, after: 6 });
}

function actionItems(pdf: PdfWriter, actions: readonly BriefActionLine[], total: number, empty: string): void {
  if (actions.length === 0) { pdf.text(empty, { muted: true, after: 6 }); return; }
  for (const action of actions) {
    const meta = [
      PRIORITY_LABELS[action.priority],
      action.dueDate === null ? 'no date set' : `due ${action.dueDate}`,
      action.assigned ? 'assigned' : 'not assigned',
    ].join(' · ');
    pdf.item(action.title, null, meta);
  }
  if (total > actions.length) pdf.text(`…and ${total - actions.length} more.`, { muted: true, after: 6 });
}

function interimFigure(
  pdf: PdfWriter, figure: InterimFigure, currency: string, period: 'day' | 'week',
  previous?: InterimFigure | null, change?: string | null,
): void {
  const status = figure.status === 'incomplete' ? ` (${INTERIM_STATUS_LABELS.incomplete})` : '';
  const comparison = previous === undefined || previous === null || change === null || change === undefined
    ? '' : ` The ${period} before: ${money(previous.value, currency)} (${money(change, currency, true)}).`;
  pdf.figure(`${INTERIM_LABELS[figure.key]}${status}`, money(figure.value, currency),
    `${INTERIM_NOTES[figure.key]} ${figure.recordCount} record${figure.recordCount === 1 ? '' : 's'}.${comparison}`);
}

function monthSection(pdf: PdfWriter, month: BriefMonth, heading: string): void {
  pdf.heading(heading);
  pdf.text(month.basisLine, { size: 9, muted: true, after: 6 });
  if (month.health !== null) {
    pdf.figure('Health score out of 100', String(month.health.score),
      `Based on ${month.health.dimensionsUsed} of ${month.health.dimensionsTotal} areas`
      + (month.health.changeVsPrevious === null ? '' : `; ${month.health.changeVsPrevious >= 0 ? '+' : ''}${month.health.changeVsPrevious} on the month before`));
  }
  for (const card of month.cards) pdf.figure(card.label, card.value, card.change);
  if (month.adverse.length > 0) {
    pdf.gap(4);
    pdf.text('Biggest adverse movements', { bold: true, after: 2 });
    for (const m of month.adverse) {
      pdf.item(`${m.label}${m.dimensionLabel === null ? '' : ` - ${m.dimensionLabel}`}: ${m.change}${m.percent === null ? '' : ` (${m.percent})`}`,
        null, `${m.comparison} to ${m.current}`);
    }
  }
  if (month.favourable.length > 0) {
    pdf.text('Biggest favourable movements', { bold: true, after: 2 });
    for (const m of month.favourable) {
      pdf.item(`${m.label}${m.dimensionLabel === null ? '' : ` - ${m.dimensionLabel}`}: ${m.change}${m.percent === null ? '' : ` (${m.percent})`}`,
        null, `${m.comparison} to ${m.current}`);
    }
  }
}

export async function renderBriefPdf(content: BriefContent): Promise<Uint8Array> {
  const daily = content.kind === 'daily_brief';
  const title = daily ? 'Daily Executive Brief' : 'Weekly Intelligence Report';
  const when = windowLabel(content.window.start, content.window.end);
  const pdf = await PdfWriter.create(`${title} - ${content.organisationName} - ${when}`);
  const c = content.currency;

  pdf.text(content.organisationName, { size: 18, bold: true, after: 4 });
  pdf.text(`${title} - ${when}`, { size: 12, muted: true, after: 4 });
  pdf.text(INTERIM_DISCLAIMER, { size: 8.5, muted: true, after: 8 });

  pdf.heading(daily ? 'Key movements' : 'Financial changes this week');
  if (content.comparison.length === 0) {
    pdf.text('No day or week figures are available for this period.', { muted: true });
  }
  for (const row of content.comparison) interimFigure(pdf, row.current, c, daily ? 'day' : 'week', row.previous, row.change);
  for (const notice of content.notices) pdf.text(notice.text, { size: 9, muted: true, after: 1 });

  pdf.heading(daily ? 'Risks' : 'Causes');
  alertItems(pdf, content.events.alertsRaised.items, content.events.alertsRaised.total,
    daily ? 'No new alerts were raised.' : 'No new alerts were raised this week.');
  if (!daily && content.latestMonth !== null && content.latestMonth.adverse.length > 0) {
    pdf.text(`What moved most in ${content.latestMonth.label}`, { bold: true, after: 2 });
    for (const m of content.latestMonth.adverse) {
      pdf.item(`${m.label}${m.dimensionLabel === null ? '' : ` - ${m.dimensionLabel}`}: ${m.change}`, null, `${m.comparison} to ${m.current}`);
    }
  }

  if (daily) {
    pdf.heading('Opportunities');
    const favourable = content.latestMonth?.favourable ?? [];
    const collected = content.interim.invoicing?.find((f) => f.key === 'sales_collected') ?? null;
    if (collected !== null && collected.recordCount > 0) {
      pdf.item(`${money(collected.value, c)} collected from customers`, `${collected.recordCount} invoice${collected.recordCount === 1 ? '' : 's'} paid in full.`);
    }
    for (const m of favourable) {
      pdf.item(`${m.label}${m.dimensionLabel === null ? '' : ` - ${m.dimensionLabel}`}: ${m.change}`, null, `In ${content.latestMonth?.label}`);
    }
    if (favourable.length === 0 && (collected === null || collected.recordCount === 0)) {
      pdf.text('Nothing new to point to.', { muted: true });
    }
  }

  pdf.heading(daily ? 'What needs attention today' : 'Unresolved issues');
  const sev = content.attention.standingBySeverity;
  pdf.text(`Open alerts: ${sev.critical} critical, ${sev.high} high, ${sev.medium} medium, ${sev.low} low.`, { after: 4 });
  alertItems(pdf, content.attention.standingAlerts.items, content.attention.standingAlerts.total, 'No critical or high alerts are open.');
  pdf.text('Overdue actions', { bold: true, after: 2 });
  actionItems(pdf, content.attention.overdueActions.items, content.attention.overdueActions.total, 'Nothing is overdue.');
  pdf.text(`Due in the next 7 days`, { bold: true, after: 2 });
  actionItems(pdf, content.attention.dueSoonActions.items, content.attention.dueSoonActions.total, 'Nothing falls due.');

  pdf.heading('Actions');
  pdf.text(`${content.events.actionsCompleted.total} completed, ${content.events.actionsCreated.total} created, `
    + `${content.events.alertsResolved.total} alert${content.events.alertsResolved.total === 1 ? '' : 's'} resolved.`, { after: 4 });
  actionItems(pdf, content.events.actionsCompleted.items, content.events.actionsCompleted.total, 'No actions were completed.');

  if (content.latestMonth !== null) monthSection(pdf, content.latestMonth, `The latest complete month: ${content.latestMonth.label}`);

  pdf.gap(8);
  pdf.text(`Produced ${content.composedAt.slice(0, 16).replace('T', ' ')} UTC by APX. Days are ${content.timezone} days. `
    + (content.dataRefreshedAt === null ? '' : `Data last added ${content.dataRefreshedAt.slice(0, 10)}.`), { size: 8.5, muted: true });
  return pdf.save();
}

export async function renderAdviserPdf(content: AdviserContent): Promise<Uint8Array> {
  const pdf = await PdfWriter.create(`Accountant/CFO Report - ${content.organisationName} - ${content.month.label}`);

  pdf.text(content.organisationName, { size: 18, bold: true, after: 4 });
  pdf.text(`Accountant/CFO Report - ${content.month.label}`, { size: 12, muted: true, after: 8 });

  pdf.heading('Needs attention');
  if (content.attention.length === 0) pdf.text('Nothing in the Command Centre\'s rules flags this client.', { muted: true });
  for (const reason of content.attention) pdf.item(reason);

  monthSection(pdf, content.month, `${content.month.label} at a glance`);

  pdf.heading('Health, area by area');
  for (const d of content.dimensions) {
    pdf.figure(REPORT_DIMENSION_LABELS[d.key], d.score === null ? '-' : String(d.score),
      d.included ? [...d.negatives, ...d.positives].join(' ') || null
        : REPORT_EXCLUSION_TEXT[d.exclusionReason ?? ''] ?? 'Not scored.');
  }
  const scored = content.trend.filter((p) => p.score !== null);
  if (scored.length > 0) {
    pdf.text(`Scores: ${content.trend.map((p) => `${p.periodLabel} ${p.score ?? '-'}`).join(', ')}`, { size: 9, muted: true, after: 4 });
  }
  pdf.text(content.disclaimer, { size: 8.5, muted: true, after: 4 });

  pdf.heading('Open alerts');
  const sev = content.alerts.bySeverity;
  pdf.text(`${sev.critical} critical, ${sev.high} high, ${sev.medium} medium, ${sev.low} low.`, { after: 4 });
  alertItems(pdf, content.alerts.standing.items, content.alerts.standing.total, 'No critical, high or medium alerts are open.');

  pdf.heading('Actions');
  pdf.text(`${content.actions.open} open.`, { after: 2 });
  pdf.text('Overdue', { bold: true, after: 2 });
  actionItems(pdf, content.actions.overdue.items, content.actions.overdue.total, 'Nothing is overdue.');
  pdf.text('Urgent', { bold: true, after: 2 });
  actionItems(pdf, content.actions.urgent.items, content.actions.urgent.total, 'Nothing urgent.');
  pdf.text('Completed in the last 30 days', { bold: true, after: 2 });
  if (content.actions.completedRecently.items.length === 0) pdf.text('None.', { muted: true });
  for (const action of content.actions.completedRecently.items) {
    pdf.item(action.title, null, action.outcomeValue === null ? `completed ${action.at?.slice(0, 10) ?? ''}`
      : `completed ${action.at?.slice(0, 10) ?? ''} · outcome ${money(action.outcomeValue, action.outcomeCurrency ?? content.currency)}`);
  }

  pdf.heading('How far the data goes');
  pdf.text(content.dataQuality.dataRefreshedAt === null ? 'No data has been added yet.'
    : `Data last added ${content.dataQuality.dataRefreshedAt.slice(0, 10)}.`, { after: 2 });
  for (const account of content.dataQuality.bankAccounts) {
    pdf.text(`${account.name}: ${account.latestDate === null ? 'no transactions imported' : `statements reach ${account.latestDate}`}.`, { size: 9.5, after: 1 });
  }
  if (content.dataQuality.monthsWithoutData.length > 0) {
    pdf.text(`Months with no figures: ${content.dataQuality.monthsWithoutData.join(', ')}.`, { size: 9.5, after: 2 });
  }

  pdf.gap(8);
  pdf.text(`Produced ${content.composedAt.slice(0, 16).replace('T', ' ')} UTC by APX.`, { size: 8.5, muted: true });
  return pdf.save();
}
