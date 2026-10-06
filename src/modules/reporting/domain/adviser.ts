import type { HealthDimensionKey } from '@/modules/health';
import type { BriefActionLine, BriefAlertLine, BriefMonth, Capped } from './brief';

/**
 * The Accountant/CFO Report's stored content (Phase 17; REQ-RP-04). Composed by
 * `services/adviser.ts`; read by the page and the PDF.
 */

export const ADVISER_CONTENT_VERSION = 'adviser.v1';

/** How far back "recently completed" actions reach. */
export const COMPLETED_WINDOW_DAYS = 30;

export interface AdviserDimensionLine {
  readonly key: HealthDimensionKey;
  readonly score: number | null;
  readonly included: boolean;
  readonly exclusionReason: string | null;
  readonly capped: boolean;
  readonly positives: readonly string[];
  readonly negatives: readonly string[];
}

export interface AdviserCompletedAction extends BriefActionLine {
  readonly outcomeValue: string | null;
  readonly outcomeCurrency: string | null;
}

export interface AdviserContent {
  readonly version: typeof ADVISER_CONTENT_VERSION;
  readonly organisationName: string;
  readonly timezone: string;
  readonly currency: string;
  readonly composedAt: string;
  readonly asOfDate: string;
  readonly month: BriefMonth;
  readonly dimensions: readonly AdviserDimensionLine[];
  readonly trend: readonly { readonly periodLabel: string; readonly score: number | null; readonly band: string | null }[];
  /** The Command Centre's reasons, worst first, already worded. */
  readonly attention: readonly string[];
  readonly alerts: {
    readonly bySeverity: Readonly<Record<BriefAlertLine['severity'], number>>;
    readonly standing: Capped<BriefAlertLine>;
  };
  readonly actions: {
    readonly open: number;
    readonly overdue: Capped<BriefActionLine>;
    readonly urgent: Capped<BriefActionLine>;
    readonly completedRecently: Capped<AdviserCompletedAction>;
  };
  readonly dataQuality: {
    readonly dataRefreshedAt: string | null;
    readonly bankAccounts: readonly { readonly name: string; readonly latestDate: string | null }[];
    /** Of the twelve months up to the reported one, those with no figures. */
    readonly monthsWithoutData: readonly string[];
  };
  readonly disclaimer: string;
}
