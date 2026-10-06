import type { PortfolioReportContent } from '@/modules/portfolio';
import { PdfWriter } from './pdf-kit';

/**
 * The Portfolio Report as a PDF (SOW §20; ADR-149). Here rather than in `modules/portfolio` because
 * reporting already reads the portfolio; the content is the portfolio's, assembled there.
 */
export async function renderPortfolioPdf(content: PortfolioReportContent): Promise<Uint8Array> {
  const c = content.counts;
  const pdf = await PdfWriter.create(`Portfolio Report - ${content.today}`);
  pdf.text('Portfolio Report', { size: 18, bold: true, after: 4 });
  pdf.text(`${content.today} - ${c.clients} ${c.clients === 1 ? 'client' : 'clients'}`, { size: 12, muted: true, after: 8 });

  pdf.heading('The portfolio');
  pdf.figure('Clients needing attention', String(c.needingAttention));
  pdf.figure('Clients Stable or Strong', String(c.healthy));
  pdf.figure('Clients not yet scored', String(c.unscored));
  pdf.figure('Clients with advisory opportunities', String(content.clientsWithOpportunities));
  pdf.figure('Critical / high alerts standing', `${c.criticalAlerts} / ${c.highAlerts}`);
  pdf.figure('Open actions (overdue)', `${c.openActions} (${c.overdueActions})`);

  for (const client of content.clients) {
    pdf.heading(client.suspended ? `${client.name} (suspended)` : client.name);
    if (client.health === null) {
      pdf.text('Not yet scored: no complete month has a Health Score.', { muted: true });
    } else {
      const h = client.health;
      pdf.figure(`Health, ${h.periodLabel}`, h.score === null ? 'not enough data' : `${h.score} - ${h.band}`,
        `${h.trend ?? 'No earlier month to compare'}; based on ${h.dimensionsUsed} of ${h.dimensionsTotal} areas.`);
    }
    pdf.figure('Alerts standing (critical / high)', `${client.counts.alertsStanding} (${client.counts.criticalAlerts} / ${client.counts.highAlerts})`);
    pdf.figure('Open actions (overdue)', `${client.counts.openActions} (${client.counts.overdueActions})`);
    if (client.attention.length > 0) pdf.item('Needs attention', client.attention.join('; '));
    for (const o of client.opportunities) pdf.item(`Opportunity: ${o.title}`, `${o.suggestion} Because: ${o.because}.`);
  }

  pdf.gap(8);
  pdf.text(content.disclaimer, { size: 8.5, muted: true });
  pdf.text(`Produced ${content.generatedAt.slice(0, 16).replace('T', ' ')} UTC by MOTION from the figures current at that moment.`, { size: 8.5, muted: true });
  return pdf.save();
}
