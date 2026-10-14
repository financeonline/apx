import type { MetricCardView, PeriodLabel } from '@/modules/dashboard';
import {
  bandLabel, capReasonFor, HEALTH_DISCLAIMER, type HealthBand, type HealthCardView, type HealthDimensionKey,
} from '@/modules/health';
import { REPORT_DIMENSION_LABELS, REPORT_EXCLUSION_TEXT } from './labels';

/**
 * The Monthly Management Report — summary edition (ADR-172 addendum, the owner's decision of
 * 2026-10-14; RBAC_MATRIX.md §8.3).
 *
 * The edition a reader WITHOUT `financials.view` gets — a 3rd party (a lender, investor or partner)
 * by default, and anyone whose `financials.view` is switched off: the headline figures, the Business
 * Health Score area by area, and the report's own words about them. Nothing else. Not the alerts
 * (their sentences name customers and suppliers), not the open actions (their titles do), and
 * nothing per customer, supplier, account or bank account.
 *
 * Built ONLY from the overview, never by filtering the full report. That is the guarantee, and it is
 * structural rather than a matter of care:
 *   - `SummaryEditionSources` has no field that could carry an alert, an action, a counterparty or
 *     an account. There is nothing to forget to drop.
 *   - The cards are built from UNDIMENSIONED snapshots alone (`overviewSnapshots` in the service);
 *     the health breakdown is reduced here to fixed labels, scores and the engine's factor sentences
 *     (templates over numbers and standard categories, FINANCIAL_ENGINE.md §7.3) — never its
 *     metrics, rules, conditions or snapshot ids.
 *   - The OUTPUT is an allow-list: every field below is copied by name, so a field added to a card
 *     or a breakdown tomorrow does not reach this edition until somebody adds it here on purpose.
 *   - The service reads with the READER'S own client, so for a 3rd party the database withholds the
 *     detail as well (RLS; `health_score_breakdowns` redacts) — two independent reasons for the
 *     same answer.
 *
 * It is rendered on request and never stored (ADR-172 addendum, decision 1): the database cannot
 * redact inside a stored PDF, and a second stored file per month would exist only for the months
 * someone with `reports.generate` happened to render after this change.
 *
 * Pure: no database, no clock, no network.
 */

export const SUMMARY_EDITION_VERSION = 'summary.v1';

/** The title on the Reports page and the PDF. */
export const SUMMARY_EDITION_TITLE = 'Monthly management report — summary edition';

/** Who the edition is written for. The same words for every reader, so the document is too. */
export const SUMMARY_EDITION_AUDIENCE = 'external readers';

/** The cover line the owner asked for, verbatim in shape. */
export function summaryEditionNotice(audience: string = SUMMARY_EDITION_AUDIENCE): string {
  return `Summary edition for ${audience}: figures and Business Health Score only`;
}

/** What is not in it, said on the cover so a reader never mistakes it for the whole report. */
export const SUMMARY_EDITION_LEFT_OUT =
  'Alerts, open actions and the names of customers, suppliers and bank accounts are not part of this edition, '
  + 'and nothing in it is broken down by customer, supplier or account.';

/** One headline figure, as a reader takes it from the page. */
export interface SummaryFigure {
  readonly metricKey: string;
  readonly label: string;
  readonly value: string;
  readonly secondary: { readonly label: string; readonly value: string } | null;
  /** "+£1,200 (+4.0%) vs April 2026", or NULL when there is no honest comparison. */
  readonly change: string | null;
  /** The card's one badge ("Estimate", "Partial data", "—" …), or NULL when it carries none. */
  readonly status: string | null;
}

export interface SummaryHealthArea {
  readonly key: HealthDimensionKey;
  readonly label: string;
  /** 0–100; NULL when the area was not scored. */
  readonly score: number | null;
  readonly included: boolean;
  /** Why it was not scored, or why it was capped, in the Health panel's words; NULL otherwise. */
  readonly note: string | null;
  /** The engine's factor sentences for the area (templates over numbers, §7.3). */
  readonly helped: readonly string[];
  readonly heldBack: readonly string[];
}

export interface SummaryHealth {
  readonly score: number | null;
  /** The band's key, for the badge's tone on screen. */
  readonly bandKey: HealthBand | null;
  /** The band in words ("Healthy" …). */
  readonly band: string | null;
  /** NULL when there is no comparable previous score — not zero. */
  readonly changeVsPrevious: number | null;
  /** "+3 vs April 2026", written here so no page does arithmetic on it; NULL with no comparison. */
  readonly changeText: string | null;
  readonly dimensionsUsed: number;
  readonly dimensionsTotal: number;
  readonly areas: readonly SummaryHealthArea[];
  readonly disclaimer: string;
}

export interface SummaryEditionView {
  readonly edition: 'summary';
  readonly version: typeof SUMMARY_EDITION_VERSION;
  readonly title: string;
  readonly notice: string;
  readonly leftOut: string;
  readonly organisationName: string;
  readonly period: { readonly id: string; readonly label: string };
  readonly comparisonLabel: string | null;
  /** The report's opening sentence, the full report's own (`summaryFor`), never the AI's. */
  readonly summary: string;
  readonly basisLine: string;
  readonly figures: readonly SummaryFigure[];
  readonly health: SummaryHealth | null;
  readonly asOf: { readonly engineVersion: string | null; readonly finishedAt: string | null };
  readonly generatedAt: string;
}

/**
 * Everything the edition may be made of. Deliberately NOT `ReportViewModel`: that type carries
 * `alerts` and `openActions`, and a type that could hold them is a type somebody could pass them in.
 */
export interface SummaryEditionSources {
  readonly organisationName: string;
  readonly period: PeriodLabel;
  readonly comparisonLabel: string | null;
  /** Built by `buildHeadlineCards` from undimensioned snapshots only. */
  readonly cards: readonly MetricCardView[];
  readonly health: HealthCardView | null;
  readonly summary: string;
  readonly basisLine: string;
  readonly asOf: { readonly engineVersion: string | null; readonly finishedAt: string | null };
  readonly generatedAt: string;
}

/** A sentence list from stored jsonb, kept only if it really is a list of strings. */
function sentences(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
}

const KNOWN_CAP_REASONS: ReadonlySet<string> = new Set(
  [capReasonFor(true, false), capReasonFor(false, true), capReasonFor(true, true)]
    .filter((reason): reason is string => reason !== null),
);

function areaNote(included: boolean, exclusionReason: string | null, capped: boolean, capReason: string | null): string | null {
  if (!included) {
    return (exclusionReason === null ? null : REPORT_EXCLUSION_TEXT[exclusionReason]) ?? 'Not scored.';
  }
  // The cap reason is printed only when it is one of the engine's own fixed notes (`capReasonFor`),
  // so a future free-text reason cannot arrive in an external document unread.
  if (capped) {
    return capReason !== null && KNOWN_CAP_REASONS.has(capReason) ? `Capped: ${capReason}.` : 'Capped.';
  }
  return null;
}

function composeHealth(health: HealthCardView | null, comparisonLabel: string | null): SummaryHealth | null {
  if (health === null) return null;
  const change = health.changeVsPrevious;
  const areas = health.breakdown
    .filter((d) => Object.prototype.hasOwnProperty.call(REPORT_DIMENSION_LABELS, d.key))
    .map((d): SummaryHealthArea => ({
      key: d.key,
      label: REPORT_DIMENSION_LABELS[d.key],
      score: d.included && typeof d.score === 'number' ? d.score : null,
      included: d.included === true,
      note: areaNote(d.included === true, d.exclusion_reason ?? null, d.capped === true, d.cap_reason ?? null),
      helped: d.included ? sentences(d.positives) : [],
      heldBack: d.included ? sentences(d.negatives) : [],
    }));
  return {
    score: health.score,
    bandKey: health.band,
    band: bandLabel(health.band),
    changeVsPrevious: change,
    changeText: change === null
      ? null
      : `${change > 0 ? '+' : ''}${change} vs ${comparisonLabel ?? 'the previous month'}`,
    dimensionsUsed: health.dimensionsUsed,
    dimensionsTotal: health.dimensionsTotal,
    areas,
    disclaimer: HEALTH_DISCLAIMER,
  };
}

export function composeSummaryEdition(sources: SummaryEditionSources): SummaryEditionView {
  return {
    edition: 'summary',
    version: SUMMARY_EDITION_VERSION,
    title: SUMMARY_EDITION_TITLE,
    notice: summaryEditionNotice(),
    leftOut: SUMMARY_EDITION_LEFT_OUT,
    organisationName: sources.organisationName,
    period: { id: sources.period.id, label: sources.period.label },
    comparisonLabel: sources.comparisonLabel,
    summary: sources.summary,
    basisLine: sources.basisLine,
    // Copied field by field: the card's evidence link (`whyHref`), its raw value and its period are
    // not part of a document that leaves the product.
    figures: sources.cards.map((card) => ({
      metricKey: card.metricKey,
      label: card.label,
      value: card.value,
      secondary: card.secondaryLine === null ? null : { label: card.secondaryLine.label, value: card.secondaryLine.value },
      change: card.change?.text ?? null,
      status: card.status.label,
    })),
    health: composeHealth(sources.health, sources.comparisonLabel),
    asOf: { engineVersion: sources.asOf.engineVersion, finishedAt: sources.asOf.finishedAt },
    generatedAt: sources.generatedAt,
  };
}
