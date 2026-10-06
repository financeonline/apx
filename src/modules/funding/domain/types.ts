import type { MetricObservation } from '@/modules/alerts';
import type { FactorKey } from './config';

/** The assessment's stored shape (PHASE_16_IMPLEMENTATION.md §9 `breakdown`). */

export interface RuleResult {
  readonly rule: string;
  /** The value the rule scored, as an exact decimal string; NULL when unavailable. */
  readonly value: string | null;
  /** The band label (or the flat rule's result); NULL when unavailable. */
  readonly band: string | null;
  readonly points: number;
  /** Why the rule did not score (§4.4); NULL when it scored. */
  readonly unavailable: string | null;
}

export interface MetricUse {
  readonly key: string;
  readonly periodId: string;
  readonly value: string | null;
  readonly snapshotId: string | null;
}

/** A positive or negative factor: a fixed template, its typed values, and the snapshots behind them. */
export interface FactorSentence {
  readonly rule: string;
  readonly template: string;
  readonly text: string;
  readonly values: Readonly<Record<string, string>>;
  readonly snapshotIds: readonly string[];
}

export interface MissingLine {
  readonly factor: FactorKey;
  readonly rule: string | null;
  readonly reason: string;
  readonly text: string;
}

export type ActionPriority = 'high' | 'medium' | 'low';

export interface ImprovementAction {
  readonly factor: FactorKey;
  readonly rule: string | null;
  readonly reason: string;
  readonly text: string;
  readonly priority: ActionPriority;
  /** Snapshot ids, or the missing-data code when there is nothing to cite. */
  readonly evidence: readonly string[];
}

export interface FactorResult {
  readonly key: FactorKey;
  readonly name: string;
  readonly weight: number;
  readonly appliedWeight: number;
  readonly status: 'scored' | 'missing';
  readonly score: number | null;
  /** Why the factor is unavailable (§4.6); NULL when scored. */
  readonly reason: string | null;
  readonly missingCodes: readonly string[];
  readonly capped: boolean;
  readonly capReason: string | null;
  readonly completeness: number | null;
  readonly rules: readonly RuleResult[];
  readonly metrics: readonly MetricUse[];
  readonly positives: readonly FactorSentence[];
  readonly negatives: readonly FactorSentence[];
  readonly missing: readonly MissingLine[];
  readonly actions: readonly ImprovementAction[];
}

export interface FundingAssessment {
  readonly rulesVersion: string;
  readonly periodId: string;
  readonly status: 'scored' | 'insufficient_data';
  readonly score: number | null;
  readonly band: string | null;
  readonly factorsUsed: number;
  readonly factorsTotal: 7;
  readonly substantiveWeightScored: number;
  readonly dataCoveragePercent: number;
  readonly factors: readonly FactorResult[];
  readonly actions: readonly ImprovementAction[];
  readonly disclaimer: string;
}

/** One open invoice as F5's gross share reads it (the alert's own population, ADR-124 D-5). */
export interface OpenInvoiceFact {
  readonly invoiceType: 'sales' | 'purchase' | 'sales_credit_note' | 'purchase_credit_note';
  readonly issueDate: string;
  readonly dueDate: string | null;
  /** Outstanding at the as-of, from the engine's own `invoiceOutstandingAt`. */
  readonly outstanding: string;
}

export interface FundingInput {
  readonly periodId: string;
  /** P's last day; the as-of for F5's population when the overdue figure names none. */
  readonly periodEnd: string;
  /** Fiscal periods in calendar order, oldest first, ending at P (at least P−11…P where they exist). */
  readonly periodIds: readonly string[];
  readonly currency: string;
  readonly snapshots: readonly MetricObservation[];
  /** `bankEvidenceRatio` per period (NULL: no cash-like account in scope). */
  readonly bankEvidence: ReadonlyMap<string, number | null>;
  /** Health's B3 inputs for P (`bankingAnomalies`), reused unchanged. */
  readonly anomalies: { readonly suppressed: boolean; readonly reason: string | null; readonly count: number };
  /** Accounts with a statement for P and their Phase 13 status (`reconciliationFor`). */
  readonly reconciliation: readonly { readonly accountId: string; readonly name: string; readonly status: 'reconciled' | 'unreconciled' | 'balances_missing' }[];
  /** U-3: active loan-type bank accounts, named only as a hint when debt is unknown. */
  readonly loanBankAccountNames: readonly string[];
  /** Open invoices at P's as-of, for F5.2/F5.3. */
  readonly openInvoices: readonly OpenInvoiceFact[];
}
