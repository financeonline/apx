import type { MarketingView } from '../domain/types';
import { formatReportDate } from './format';

/**
 * The Marketing department's line on the Departments page, and the Competitive Readiness card
 * (ADR-170; ADR-155's department cards). Every status comes from the report's real state — nothing
 * here is a placeholder dressed as a figure: no report is "No report yet", not a blank green dot.
 *
 * Pure.
 */

export type MarketingTone = 'good' | 'attention' | 'quiet';

export interface MarketingSummary {
  readonly tone: MarketingTone;
  /** The status beside the dot: "Report ready 13 Oct 2026", "Preparing", "Fill in the company profile". */
  readonly label: string;
  /** One sentence under the title, or null. */
  readonly headline: string | null;
  /** Section 01's first three comparators, for Competitive Readiness; empty with no report. */
  readonly competitors: readonly { readonly name: string; readonly positioning: string }[];
  /** The date of the report they come from, or null. */
  readonly asOf: string | null;
}

export function summariseMarketing(view: MarketingView): MarketingSummary {
  const report = view.report;
  const asOf = report === null ? null : formatReportDate(report.generatedAt);
  const competitors = report === null ? [] : report.narrative.competitors.competitors.slice(0, 3)
    .map((c) => ({ name: c.name.trim(), positioning: c.positioning.trim() }))
    .filter((c) => c.name !== '');

  if (view.status === 'queued' || view.status === 'running') {
    return {
      tone: 'quiet', label: 'Preparing',
      headline: report === null ? 'The first report is being written; usually under a minute.' : `Showing the report of ${asOf} until the new one is ready.`,
      competitors, asOf,
    };
  }
  if (view.status === 'failed') {
    return {
      tone: 'attention', label: 'Last attempt failed',
      headline: report === null ? 'The report could not be prepared. Try again from the Marketing page.' : `The report of ${asOf} is still available.`,
      competitors, asOf,
    };
  }
  if (report !== null) {
    return { tone: 'good', label: `Report ready ${asOf}`, headline: null, competitors, asOf };
  }
  if (!view.profileReady) {
    return {
      tone: 'attention', label: 'Fill in the company profile',
      headline: 'The report is written from what the company sells and its industry.',
      competitors, asOf,
    };
  }
  return { tone: 'quiet', label: 'No report yet', headline: 'Ready to create from the company profile.', competitors, asOf };
}
