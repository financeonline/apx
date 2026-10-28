import 'server-only';
import type { Db } from '@/db/types';
import { ValidationError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import { callApi } from '@/core/db';
import { addDays, fixedClock, isoWeekday, todayInTimeZone } from '@/core/periods';
import type { AccessContext } from '@/modules/tenancy';
import { BRIEF_CONTENT_VERSION, type BriefContent, type BriefKind } from '../domain/brief';
import { briefWindows, composeBrief } from './brief';
import { ADVISER_CONTENT_VERSION, composeAdviserReport, type AdviserContent } from './adviser';
import { loadOrganisationBasics } from '../data/brief-sources';
import { readRowById, readRows } from '@/db/app/caller-reads';
import { composeFundingReport } from './funding-report';
import { FUNDING_REPORT_VERSION, type FundingReportContent } from '../domain/funding-report';

/**
 * Stored reports (Phase 17): composing one for the job, listing and reading them for a person,
 * and asking the queue for a new one or its PDF.
 *
 * Reads go through the caller's own client, so the `reports` policy decides what they see — a
 * Custom AI Report is its author's alone — and an id from another organisation is simply absent
 * (NOT FOUND, never FORBIDDEN; SECURITY_MODEL.md §14).
 */

export type ComposableKind = BriefKind | 'adviser' | 'funding_readiness';
export type StoredKind = ComposableKind | 'custom_ai';

export const KIND_LABELS: Readonly<Record<StoredKind, string>> = {
  daily_brief: 'Daily Executive Brief',
  weekly_intelligence: 'Weekly Intelligence Report',
  adviser: 'Accountant/CFO Report',
  custom_ai: 'Custom AI Report',
  funding_readiness: 'Funding Readiness Report',
};

export interface Composed {
  readonly content: BriefContent | AdviserContent | FundingReportContent;
  readonly contentVersion: string;
  readonly window: { readonly start: string; readonly end: string };
  readonly periodId: string | null;
}

/** For the `report.compose` job. No permission check: `api.enqueue_job` made it. */
export async function composeStoredReport(input: {
  readonly db: Db;
  readonly orgId: string;
  readonly kind: ComposableKind;
  readonly windowStart: string | null;
  readonly now: Date;
  /** The Funding Readiness Report's month, when one was named. */
  readonly periodId?: string | null;
}): Promise<Composed | null> {
  if (input.kind === 'funding_readiness') {
    const funding = await composeFundingReport({ db: input.db, orgId: input.orgId, periodId: input.periodId ?? null, now: input.now });
    if (funding === null) return null;
    return { content: funding.content, contentVersion: FUNDING_REPORT_VERSION, window: funding.window, periodId: funding.periodId };
  }
  if (input.kind === 'adviser') {
    const adviser = await composeAdviserReport({ db: input.db, orgId: input.orgId, now: input.now });
    if (adviser === null) return null;
    return {
      content: adviser.content, contentVersion: ADVISER_CONTENT_VERSION,
      window: adviser.window, periodId: adviser.periodId,
    };
  }
  if (input.windowStart === null) throw new ValidationError('A brief needs the day or week it covers.');
  const content = await composeBrief({
    db: input.db, orgId: input.orgId, kind: input.kind, windowStart: input.windowStart, now: input.now,
  });
  return { content, contentVersion: BRIEF_CONTENT_VERSION, window: content.window, periodId: null };
}

function orgOf(ctx: AccessContext): string {
  if (!ctx.orgId) throw new ValidationError('No organisation is in context.');
  return ctx.orgId;
}

export interface StoredReportSummary {
  readonly id: string;
  readonly kind: StoredKind;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly origin: 'scheduled' | 'requested';
  readonly createdAt: string;
  /** How many times this window was composed; the summary is the latest. */
  readonly versions: number;
}

export interface StoredReport extends StoredReportSummary {
  readonly contentVersion: string;
  readonly content: unknown;
  readonly periodId: string | null;
  readonly file: { readonly id: string; readonly createdAt: string } | null;
}

interface ReportRow {
  id: string; report_kind: StoredKind; window_start: string; window_end: string;
  origin: 'scheduled' | 'requested'; created_at: string; content_version: string;
  content?: unknown; period_id: string | null;
}

/** Newest window first, then newest composition, then id — the order the list was read in. */
const newestFirst = (a: ReportRow, b: ReportRow): number => {
  for (const [x, y] of [[a.window_start, b.window_start], [a.created_at, b.created_at], [a.id, b.id]] as const) {
    if (x !== y) return x < y ? 1 : -1;
  }
  return 0;
};

/**
 * The fields a list needs, without `content` (a report can be large). `requested_by` is kept
 * because the `reports` policy reads it to keep a Custom AI Report its author's own.
 */
const SUMMARY_FIELDS = [
  'id', 'report_kind', 'window_start', 'window_end', 'origin', 'created_at', 'content_version', 'period_id', 'requested_by',
] as const;

/** The latest of each (kind, window), newest windows first. */
export async function listStoredReports(
  ctx: AccessContext, kinds: readonly StoredKind[], limit = 60,
): Promise<StoredReportSummary[]> {
  assertCan(ctx, 'reports.view');
  if (kinds.length === 0) return [];
  // One `in` filter in Firestore (no composite index); the order and the window here.
  const rows = (await readRows<ReportRow>(ctx.db, orgOf(ctx), 'reports', (q) => q
    .where('report_kind', 'in', [...kinds]).select(...SUMMARY_FIELDS)))
    .sort(newestFirst)
    .slice(0, limit * 3);

  const latest = new Map<string, StoredReportSummary>();
  for (const row of rows) {
    const key = `${row.report_kind}|${row.window_start}|${row.report_kind === 'custom_ai' ? row.id : ''}`;
    const seen = latest.get(key);
    if (seen === undefined) {
      latest.set(key, {
        id: row.id, kind: row.report_kind, windowStart: row.window_start, windowEnd: row.window_end,
        origin: row.origin, createdAt: row.created_at, versions: 1,
      });
    } else {
      latest.set(key, { ...seen, versions: seen.versions + 1 });
    }
  }
  return [...latest.values()].slice(0, limit);
}

export async function getStoredReport(ctx: AccessContext, reportId: string): Promise<StoredReport | null> {
  assertCan(ctx, 'reports.view');
  const orgId = orgOf(ctx);
  if (!/^[0-9a-f-]{36}$/i.test(reportId)) return null;

  const row = await readRowById<ReportRow>(ctx.db, orgId, 'reports', reportId);
  if (row === null) return null;

  // Both counted under the caller's policies, as the RLS-filtered count and select were.
  const [versions, files] = await Promise.all([
    readRows(ctx.db, orgId, 'reports', (q) => q
      .where('report_kind', '==', row.report_kind).where('window_start', '==', row.window_start)
      .select('id', 'report_kind', 'requested_by')),
    readRows<{ id: string; created_at: string; report_id: string | null }>(ctx.db, orgId, 'report_files', (q) => q
      .where('report_id', '==', reportId).where('deleted_at', '==', null)),
  ]);
  const latestFile = files.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))[0] ?? null;

  return {
    id: row.id, kind: row.report_kind, windowStart: row.window_start, windowEnd: row.window_end,
    origin: row.origin, createdAt: row.created_at, versions: versions.length || 1,
    contentVersion: row.content_version, content: row.content, periodId: row.period_id,
    file: latestFile === null ? null : { id: latestFile.id, createdAt: latestFile.created_at },
  };
}

/** The most recent completed day and Monday-to-Sunday week for an organisation. */
export async function latestCompletedWindows(ctx: AccessContext): Promise<{
  today: string; yesterday: string; lastWeekStart: string; thisWeekStart: string; timezone: string;
}> {
  const org = await loadOrganisationBasics(ctx.db, orgOf(ctx));
  const today = todayInTimeZone(fixedClock(ctx.now()), org.timezone);
  const thisWeekStart = addDays(today, 1 - isoWeekday(today));
  return {
    today,
    yesterday: addDays(today, -1),
    lastWeekStart: addDays(thisWeekStart, -7),
    thisWeekStart,
    timezone: org.timezone,
  };
}

/**
 * The brief for a day or week still in progress, composed now and NOT stored: a stored report says
 * a period was reported on, and this one has not finished (R17-3).
 */
export async function previewBrief(ctx: AccessContext, kind: BriefKind): Promise<BriefContent> {
  assertCan(ctx, 'reports.view');
  // The stored daily and weekly reports also need `financials.view` (`reports_select`, ADR-172): they
  // list the day's alerts, overdue actions and movements by account. A preview composed live under a
  // reader without it would be the same report with its detail silently missing.
  assertCan(ctx, 'financials.view');
  const windows = await latestCompletedWindows(ctx);
  return composeBrief({
    db: ctx.db, orgId: orgOf(ctx), kind,
    windowStart: kind === 'daily_brief' ? windows.today : windows.thisWeekStart,
    now: ctx.now(), requestId: ctx.requestId,
  });
}

/** Asks the queue to compose a report. `api.enqueue_job` checks the permission and the window. */
export async function requestCompose(
  ctx: AccessContext, kind: ComposableKind, windowStart: string | null,
): Promise<string> {
  assertCan(ctx, 'reports.generate');
  if (kind !== 'adviser' && kind !== 'funding_readiness') {
    if (windowStart === null || !/^\d{4}-\d{2}-\d{2}$/.test(windowStart)) {
      throw new ValidationError('Choose the day or week the report covers.');
    }
    briefWindows(kind, windowStart);
  }
  return callApi<string>(ctx.db, 'enqueue_job', {
    p_org: orgOf(ctx),
    p_job_type: 'report.compose',
    p_payload: kind === 'adviser' || kind === 'funding_readiness' ? { kind } : { kind, windowStart },
  }, ctx.requestId);
}

/** Asks the queue for the PDF of a stored report. */
export async function requestStoredPdf(ctx: AccessContext, reportId: string): Promise<string> {
  assertCan(ctx, 'reports.generate');
  return callApi<string>(ctx.db, 'enqueue_job', {
    p_org: orgOf(ctx),
    p_job_type: 'report.render',
    p_payload: { reportId },
  }, ctx.requestId);
}

/** For the render job: the stored report, read with the job's scoped client. */
export async function loadStoredReportForJob(
  db: Db, orgId: string, reportId: string,
): Promise<{ kind: StoredKind; content: unknown; contentVersion: string } | null> {
  const row = await readRowById<{ report_kind: StoredKind; content: unknown; content_version: string }>(
    db, orgId, 'reports', reportId,
  );
  if (row === null) return null;
  return { kind: row.report_kind, content: row.content, contentVersion: row.content_version };
}
