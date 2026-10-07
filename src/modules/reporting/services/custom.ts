import 'server-only';
import { NotFound, ValidationError } from '@/core/errors';
import { assertCan, can } from '@/core/permissions';
import { recordReport, withOrgScope } from '@/core/db';
import { findConversation, loadMessages } from '@/modules/ai';
import { loadPeriodSnapshots, loadPeriods, loadPeriodsWithData, missingReasonText } from '@/modules/dashboard';
import { loadCorporationTaxView, loadVatView, vatQuarterFor } from '@/modules/tax';
import type { AccessContext } from '@/modules/tenancy';
import {
  CUSTOM_CONTENT_VERSION, MAX_CUSTOM_QUESTIONS, entriesFromConversation, isCustomDimension,
  type CustomAnswerEntry, type CustomDimension, type CustomReportContent,
} from '../domain/custom';
import {
  FIXED_AREAS, NO_PERMISSION_REASON, buildCorporationTaxSection, buildSnapshotSection, buildVatSection,
  unavailableSection, type CustomSection, type FixedArea, type SectionFigure,
} from '../domain/custom-sections';
import { loadOrganisationBasics } from '../data/brief-sources';

/**
 * Finishing a Custom AI Report (Phase 17, R17-4).
 *
 * The browser has already put each question to the analyst through `POST /api/ai/chat`, in one
 * conversation of its own — every turn charged, grounded and stored by the analyst itself. Here the
 * server reads that conversation back (it must be the caller's), takes the named answers from the
 * STORED messages, and records the report. Nothing the browser sends is taken as an answer.
 */

/** The complete months with figures a custom report may be about, newest first. */
export async function customReportPeriods(ctx: AccessContext) {
  assertCan(ctx, 'reports.view');
  if (!ctx.orgId) throw new NotFound();
  const [periods, withData] = await Promise.all([
    loadPeriods(ctx.db, ctx.orgId, ctx.requestId),
    loadPeriodsWithData(ctx.db, ctx.orgId, ctx.requestId),
  ]);
  return periods.filter((period) => period.isComplete && withData.has(period.id));
}

/**
 * The fixed figures tables for the chosen Loans / Assets / VAT / Corporation Tax areas (ADR-156),
 * computed here by MOTION — not by the AI — so they are in the report whether or not the analyst
 * answered anything.
 */
async function fixedSections(
  ctx: AccessContext, orgId: string, areas: readonly FixedArea[],
  period: { readonly id: string; readonly label: string; readonly periodStart: string; readonly periodEnd: string },
  currency: string,
): Promise<CustomSection[]> {
  if (areas.length === 0) return [];
  const needsSnapshots = areas.includes('loans') || areas.includes('assets');
  const snapshots = needsSnapshots ? await loadPeriodSnapshots(ctx.db, orgId, period.id, ctx.requestId) : [];
  const figures = new Map<string, SectionFigure>();
  for (const row of snapshots) {
    if (row.dimensionType !== 'none') continue;
    figures.set(row.metricKey, { value: row.value, missing: row.dataQuality.missing });
  }
  const seesTax = can(ctx, 'financials.view');

  const sections: CustomSection[] = [];
  for (const area of areas) {
    if (area === 'loans' || area === 'assets') {
      sections.push(buildSnapshotSection({
        area, figures, currency, periodLabel: period.label, missingReason: missingReasonText,
      }));
    } else if (!seesTax) {
      sections.push(unavailableSection(area, NO_PERMISSION_REASON));
    } else if (area === 'vat') {
      const probe = await loadVatView(ctx);
      const monthEnd = probe.facts.vatQuarterEndMonth;
      if (monthEnd === null) {
        sections.push(buildVatSection({ quartersSet: false, quarter: null, vatReturn: null, periodLabel: period.label, currency }));
        continue;
      }
      const quarter = vatQuarterFor(period.periodEnd, monthEnd);
      const view = probe.selected?.end === quarter.end ? probe : await loadVatView(ctx, quarter.end);
      sections.push(buildVatSection({
        quartersSet: true, quarter, vatReturn: view.vatReturn, periodLabel: period.label, currency,
      }));
    } else {
      const view = await loadCorporationTaxView(ctx, period.periodStart);
      sections.push(buildCorporationTaxSection({ view, currency }));
    }
  }
  return sections;
}

export async function finishCustomReport(ctx: AccessContext, input: {
  /** NULL when no question was asked: a report of fixed sections only (ADR-156). */
  readonly conversationId: string | null;
  readonly periodId: string;
  readonly dimensions: readonly string[];
  readonly assistantMessageIds: readonly string[];
}): Promise<string> {
  assertCan(ctx, 'reports.view');
  assertCan(ctx, 'ai.use');
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();

  const dimensions = [...new Set(input.dimensions)];
  if (!dimensions.every(isCustomDimension)) throw new ValidationError('That analytical dimension is not one MOTION offers.');
  const fixed = FIXED_AREAS.filter((area) => dimensions.includes(area));

  // With a Loans, Assets, VAT or Corporation Tax area chosen the report has MOTION's own figures,
  // so it may carry no answers at all — when the analyst is unavailable, say. Otherwise, at least one.
  const fewest = fixed.length > 0 ? 0 : 1;
  if (input.assistantMessageIds.length < fewest || input.assistantMessageIds.length > MAX_CUSTOM_QUESTIONS) {
    throw new ValidationError(`A custom report answers between 1 and ${MAX_CUSTOM_QUESTIONS} questions.`);
  }
  if (input.assistantMessageIds.length > 0 && input.conversationId === null) {
    throw new ValidationError('Those answers are not all in this report\'s conversation.');
  }

  const period = (await customReportPeriods(ctx)).find((candidate) => candidate.id === input.periodId);
  if (period === undefined) throw new ValidationError('Choose a complete month with figures.');

  let entries: CustomAnswerEntry[] = [];
  if (input.conversationId !== null && input.assistantMessageIds.length > 0) {
    // Theirs, in this organisation, still active — or NOT FOUND, as the analyst itself answers.
    await findConversation(ctx, input.conversationId);
    const messages = await loadMessages(ctx, input.conversationId);
    const found = entriesFromConversation(messages, input.assistantMessageIds);
    if (found === null) throw new ValidationError('Those answers are not all in this report\'s conversation.');
    entries = found;
  }

  const org = await loadOrganisationBasics(ctx.db, orgId);
  const sections = await fixedSections(ctx, orgId, fixed, period, org.baseCurrency);
  const content: CustomReportContent = {
    version: CUSTOM_CONTENT_VERSION,
    organisationName: org.name,
    period: { id: period.id, label: period.label, start: period.periodStart, end: period.periodEnd },
    dimensions: dimensions as CustomDimension[],
    conversationId: entries.length === 0 ? null : input.conversationId,
    entries,
    ...(sections.length === 0 ? {} : { sections }),
    composedAt: ctx.now().toISOString(),
  };

  return withOrgScope(orgId, () => recordReport(
    { userId: ctx.userId, requestId: ctx.requestId },
    {
      organizationId: orgId,
      kind: 'custom_ai',
      windowStart: period.periodStart,
      windowEnd: period.periodEnd,
      periodId: period.id,
      jobId: null,
      origin: 'requested',
      content,
      contentVersion: CUSTOM_CONTENT_VERSION,
    },
  ));
}
