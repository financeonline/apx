import { formatReportDate, formatReportMoney } from '@/modules/marketing';
import type { InvestmentView } from '../domain/types';
import { percentText } from './format';

/**
 * The Investment department's line on the Departments page (ADR-171; ADR-155's department cards), as
 * Marketing's (ADR-170). Every status comes from the pack's real state — nothing here is a
 * placeholder dressed as a figure: no pack is "No pack yet", no figures is "No figures yet", never a
 * blank green dot. A ready pack's headline is its own allocation, the figures APX worked out.
 *
 * Pure.
 */

export type InvestmentTone = 'good' | 'attention' | 'quiet';

export interface InvestmentSummary {
  readonly tone: InvestmentTone;
  /** The status beside the dot: "Pack ready 14 Oct 2026", "Preparing", "No figures yet". */
  readonly label: string;
  /** One sentence under the title, or null. */
  readonly headline: string | null;
  /** The date of the pack shown, or null. */
  readonly asOf: string | null;
}

/** "£100,000 surplus: 45% business growth, 35% external investments, 20% liquidity." */
function allocationLine(view: InvestmentView): string | null {
  const report = view.report;
  if (report === null) return null;
  const { allocation, assumptions, base } = report.figures;
  return `${formatReportMoney(assumptions.surplus, base.currency)} surplus: ${percentText(allocation.business.percent)} business growth, `
    + `${percentText(allocation.external.percent)} external investments, ${percentText(allocation.liquidity.percent)} liquidity.`;
}

export function summariseInvestment(view: InvestmentView): InvestmentSummary {
  const report = view.report;
  const asOf = report === null ? null : formatReportDate(report.generatedAt);

  if (view.status === 'queued' || view.status === 'running') {
    return {
      tone: 'quiet', label: 'Preparing',
      headline: report === null ? 'The first pack is being written; usually under a minute.' : `Showing the pack of ${asOf} until the new one is ready.`,
      asOf,
    };
  }
  if (view.status === 'failed') {
    return {
      tone: 'attention', label: 'Last attempt failed',
      headline: report === null ? 'The pack could not be prepared. Try again from the Investment page.' : `The pack of ${asOf} is still available.`,
      asOf,
    };
  }
  if (report !== null) {
    return { tone: 'good', label: `Pack ready ${asOf}`, headline: allocationLine(view), asOf };
  }
  if (view.base === null) {
    return {
      tone: 'attention', label: 'No figures yet',
      headline: 'The pack is built on the company’s revenue and net profit; import the figures, or enter the amount to allocate.',
      asOf,
    };
  }
  return { tone: 'quiet', label: 'No pack yet', headline: `Ready to create from the ${view.base.yearLabel} figures.`, asOf };
}
