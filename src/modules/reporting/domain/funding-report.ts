import type { FactorResult, ImprovementAction } from '@/modules/funding';

/**
 * The Funding Readiness Report (REQ-RP-05; ADR-141, ADR-145): one month's current assessment as the
 * page shows it, frozen into a stored report. It adds nothing — every score, line and action is the
 * assessment's own — and it carries the assessment's disclaimer verbatim.
 */
export const FUNDING_REPORT_VERSION = 'funding.v1';

export interface FundingReportContent {
  readonly version: typeof FUNDING_REPORT_VERSION;
  readonly organisationName: string;
  readonly period: { readonly id: string; readonly label: string; readonly start: string; readonly end: string };
  readonly assessment: {
    readonly id: string;
    readonly status: 'scored' | 'insufficient_data';
    readonly score: number | null;
    readonly band: string | null;
    readonly dataCoveragePercent: number;
    readonly factorsUsed: number;
    readonly factors: readonly FactorResult[];
    readonly actions: readonly ImprovementAction[];
    readonly rulesVersion: string;
    readonly engineVersion: string;
    readonly calculationRunId: string;
    readonly assessedAt: string;
    readonly disclaimer: string;
  };
  readonly composedAt: string;
}
