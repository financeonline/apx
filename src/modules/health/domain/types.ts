/**
 * The health engine's type contract (FINANCIAL_ENGINE.md §7).
 *
 * The score is a pure function of snapshots, coverage and condition counts. It reads no `alerts`
 * row, no status and no clock, which is what makes the two guarantees in TEST_STRATEGY.md §7
 * checkable: two runs over identical data give identical scores whatever was acknowledged or
 * dismissed in between, and the stored breakdown alone is enough to re-derive the number.
 *
 * Pure.
 */

import type { DataQualityWarning } from '@/modules/financial-engine';
import type { MetricObservation, RuleContext } from '@/modules/alerts';
import type { HealthBand, HealthDimensionKey } from './config';

export type { HealthBand, HealthDimensionKey };

/** Why a dimension was left out of the score (§7.2). Shown to the reader, never swallowed. */
export type ExclusionReason =
  | 'required_metric_missing'
  | 'insufficient_completeness'
  | 'no_bank_coverage'
  /** marketing_efficiency: no campaign spend recorded in its three-month window (ADR-147). */
  | 'no_campaign_data';

/** One rule's verdict, exactly as it is stored in `breakdown[].rules` (§7.4). */
export interface RuleApplication {
  readonly rule: string;
  /** The band the value fell in, in the rule's own words. */
  readonly result: string;
  readonly points: number;
  /** The value the rule read, as a string. NULL when the rule was skipped. */
  readonly value: string | null;
  /** Set when the rule did not run at all — a NULL input, or a suppressed condition count. */
  readonly skipped_reason: string | null;
}

/** A metric the dimension rested on, pinned so a reader can open it (§7.4). */
export interface MetricReference {
  readonly metric_key: string;
  readonly value: string | null;
  readonly snapshot_id: string | null;
}

/** A condition count's contributing rows (§7.3 K3/B3, §7.4). */
export interface ConditionReference {
  readonly rule_key: string;
  readonly subject_id: string | null;
  readonly subject_key: string | null;
  readonly snapshot_ids: readonly string[];
  readonly record_ids: readonly string[];
}

/**
 * A factor sentence with its numbers as typed fields (ADR-032.1).
 *
 * The AI's allowed set is built from `values`, never from the rendered prose, so a model can quote
 * the figure but cannot invent a neighbouring one by paraphrasing a sentence.
 */
export interface FactorSentence {
  readonly template_id: string;
  readonly text: string;
  readonly values: Readonly<Record<string, string>>;
  readonly snapshot_ids: readonly string[];
}

/** One dimension of the score, and the whole of `breakdown[]` (§7.4). */
export interface DimensionBreakdown {
  readonly key: HealthDimensionKey;
  /** 0-100 after clamping and capping; NULL when the dimension is excluded. */
  readonly score: number | null;
  readonly weight_config: number;
  /** The renormalised weight actually applied, to 1 dp; 0 when excluded. */
  readonly weight_applied: number;
  readonly included: boolean;
  readonly exclusion_reason: ExclusionReason | null;
  readonly metrics: readonly MetricReference[];
  readonly rules: readonly RuleApplication[];
  readonly conditions: readonly ConditionReference[];
  readonly capped: boolean;
  readonly cap_reason: string | null;
  readonly positives: readonly string[];
  readonly negatives: readonly string[];
  readonly positives_structured: readonly FactorSentence[];
  readonly negatives_structured: readonly FactorSentence[];
  readonly data_quality: {
    readonly completeness: number;
    readonly warnings: readonly DataQualityWarning[];
  };
}

/** The engine's output for one period. */
export interface HealthScore {
  readonly organizationId: string;
  readonly periodId: string;
  /** NULL when fewer than three dimensions could be included (§7.2). */
  readonly score: number | null;
  readonly band: HealthBand | null;
  readonly dimensionsUsed: number;
  readonly dimensionsTotal: number;
  readonly configVersion: string;
  readonly breakdown: readonly DimensionBreakdown[];
  /** True when any included dimension was capped — Home shows the bank-only note (ADR-035). */
  readonly capped: boolean;
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/**
 * Everything one period's score may read.
 *
 * `snapshots` covers the period and its lookback, so the trailing rules (C3, G2, B1) find their
 * history without a second query. `conditions` is the shared alert-rule context, from which K3 and
 * B3 count conditions through the SAME functions the alert job uses (§8.3).
 */
export interface HealthInput {
  readonly organizationId: string;
  readonly periodId: string;
  /** The period and its lookback, newest last. Trailing rules walk backwards from `periodId`. */
  readonly periodIds: readonly string[];
  readonly isComplete: boolean;
  /** ISO 4217, from `organizations.base_currency`; factor sentences carry the right symbol (§8.2). */
  readonly currency: string;
  readonly snapshots: readonly MetricObservation[];
  /**
   * In-scope cash-like accounts with a covering statement, over all of them (§2.2), or NULL when no
   * cash-like account is in scope: no bank data, which excludes banking_health (§7.1, H-1).
   */
  readonly bankCoverageRatio: number | null;
  /** The shared alert-rule context for this period, or NULL when record-level data was not loaded. */
  readonly conditions: RuleContext | null;
  /**
   * health.config.v5 (ADR-147). The last day of each period in `periodIds`: the as-of for the
   * overdue shares (R3/R4) and the bounds of marketing's window. Absent: those rules are skipped.
   */
  readonly periodEnds?: ReadonlyMap<string, string>;
  /** The first day of each period in `periodIds`, for marketing's window. */
  readonly periodStarts?: ReadonlyMap<string, string>;
  /** Live invoices issued by the end of the window, for R3/R4's gross population. Absent: skipped. */
  readonly invoices?: readonly HealthInvoice[];
  /** The Commercial records marketing_efficiency reads. Absent: excluded `no_campaign_data`. */
  readonly commercial?: HealthCommercial;
}

/** An invoice as R3/R4 read it (the fields `invoiceOutstandingAt` needs, plus the dates). */
export interface HealthInvoice {
  readonly invoiceType: 'sales' | 'purchase' | 'sales_credit_note' | 'purchase_credit_note';
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly totalAmount: string;
  readonly balanceDue: string;
  readonly paidDate: string | null;
}

/** ADR-102's inputs, as recorded: campaign spend per period and opportunities. */
export interface HealthCommercial {
  readonly spend: ReadonlyArray<{ readonly campaignId: string; readonly periodId: string; readonly amount: string }>;
  readonly opportunities: ReadonlyArray<{
    readonly id: string;
    readonly stage: 'lead' | 'qualified' | 'proposal' | 'won' | 'lost';
    readonly counterpartyId: string | null;
    readonly campaignId: string | null;
    readonly wonOn: string | null;
  }>;
}
