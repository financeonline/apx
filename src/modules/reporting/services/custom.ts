import 'server-only';
import { NotFound, ValidationError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import { recordReport, withOrgScope } from '@/core/db';
import { findConversation, loadMessages } from '@/modules/ai';
import { loadPeriods, loadPeriodsWithData } from '@/modules/dashboard';
import type { AccessContext } from '@/modules/tenancy';
import {
  CUSTOM_CONTENT_VERSION, MAX_CUSTOM_QUESTIONS, entriesFromConversation, isCustomDimension,
  type CustomDimension, type CustomReportContent,
} from '../domain/custom';
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

export async function finishCustomReport(ctx: AccessContext, input: {
  readonly conversationId: string;
  readonly periodId: string;
  readonly dimensions: readonly string[];
  readonly assistantMessageIds: readonly string[];
}): Promise<string> {
  assertCan(ctx, 'reports.view');
  assertCan(ctx, 'ai.use');
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();

  if (input.assistantMessageIds.length === 0 || input.assistantMessageIds.length > MAX_CUSTOM_QUESTIONS) {
    throw new ValidationError(`A custom report answers between 1 and ${MAX_CUSTOM_QUESTIONS} questions.`);
  }
  const dimensions = [...new Set(input.dimensions)];
  if (!dimensions.every(isCustomDimension)) throw new ValidationError('That analytical dimension is not one MOTION offers.');

  const period = (await customReportPeriods(ctx)).find((candidate) => candidate.id === input.periodId);
  if (period === undefined) throw new ValidationError('Choose a complete month with figures.');

  // Theirs, in this organisation, still active — or NOT FOUND, as the analyst itself answers.
  await findConversation(ctx, input.conversationId);
  const messages = await loadMessages(ctx, input.conversationId);
  const entries = entriesFromConversation(messages, input.assistantMessageIds);
  if (entries === null) throw new ValidationError('Those answers are not all in this report\'s conversation.');

  const org = await loadOrganisationBasics(ctx.db, orgId);
  const content: CustomReportContent = {
    version: CUSTOM_CONTENT_VERSION,
    organisationName: org.name,
    period: { id: period.id, label: period.label, start: period.periodStart, end: period.periodEnd },
    dimensions: dimensions as CustomDimension[],
    conversationId: input.conversationId,
    entries,
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
