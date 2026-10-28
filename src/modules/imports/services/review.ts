import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseMoney, toMoneyString } from '@/core/money';
import { toMotionError } from '@/core/errors';
import { countRowsByStatus, listBatchRows, listBatches } from '../data/repository';
import type { ImportBatch, ImportRow } from '../domain/types';

/**
 * What the review screen and the import history read (IMPORT_ENGINE.md §8, §13).
 *
 * The review screen's job is stated in §8: show a reviewer everything that will NOT commit cleanly,
 * grouped so the same problem is one decision rather than four hundred. Nothing is hidden — a row
 * that failed validation is on the screen with its reason, because discarding a record silently is
 * the one thing this engine must never do (SOW §23).
 */

export interface BatchIssueGroup {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly rowCount: number;
  /** A handful of examples, so the reviewer can see the shape without loading four hundred rows. */
  readonly examples: ReadonlyArray<{ rowNumber: number; detail: string }>;
}

export interface BatchReview {
  readonly batch: ImportBatch;
  readonly filename: string | null;
  readonly counts: Record<string, number>;
  readonly issueGroups: readonly BatchIssueGroup[];
  readonly batchIssues: ReadonlyArray<{ code: string; message: string; severity: string }>;
  readonly requiredConfirmations: readonly string[];
  readonly confirmedCodes: readonly string[];
  readonly duplicates: readonly ImportRow[];
  /**
   * Rows that cannot import and have had no decision.
   *
   * §8.2 will not let a batch commit while any row is in this state, and it is right not to: a row
   * MOTION could not read is a line of somebody's file, and leaving it unaddressed would mean
   * committing a file while quietly ignoring part of it. The reviewer says "skip these", and that
   * decision is recorded.
   */
  readonly undecidedErrors: readonly ImportRow[];
  readonly rows: readonly ImportRow[];
  /**
   * How many rows will actually import.
   *
   * `valid` PLUS `warning`: a warning is a caveat about a row, not a refusal — an unmapped account
   * still imports, into the uncategorised bucket, and saying "import 3 rows" when five are going in
   * would be a wrong number on the button that does the thing.
   */
  readonly importableRows: number;
  /** True when every gate §8.2 names is satisfied and Commit may be the primary action. */
  readonly committable: boolean;
  readonly blockingReason: string | null;
  /** §5.4: pages read by AI that carry rows and have not been confirmed, in page order. */
  readonly unconfirmedPages: readonly number[];
  /** The typed balances against what the AI read (§5.4): shown only after both were typed. */
  readonly balanceComparison: 'matches_ai' | 'differs_from_ai' | null;
  readonly typedBalances: { readonly opening: string | null; readonly closing: string | null };
}

/**
 * Has a reviewer decided about this row?
 *
 * `import_rows.reviewer_decision` defaults to `'none'`, not NULL — so testing for NULL finds
 * nothing, and a screen built on that test silently offers no decisions at all while the commit gate
 * keeps refusing (ADR-058.2).
 */
function undecided(decision: string | null): boolean {
  return decision === null || decision === 'none';
}

/**
 * Groups row issues by code (§8.1).
 *
 * Four hundred rows with the same unparseable date are ONE problem with a count, not four hundred
 * lines of scrolling. The grouping is what makes a large messy file reviewable at all.
 */
export function groupIssues(rows: readonly ImportRow[]): BatchIssueGroup[] {
  const groups = new Map<string, {
    message: string; severity: 'error' | 'warning' | 'info';
    rowCount: number; examples: Array<{ rowNumber: number; detail: string }>;
  }>();

  for (const row of rows) {
    for (const issue of row.issues) {
      const group = groups.get(issue.code)
        ?? { message: issue.message, severity: issue.severity, rowCount: 0, examples: [] };
      group.rowCount += 1;
      if (group.examples.length < 5) {
        group.examples.push({
          rowNumber: row.rowNumber,
          detail: issue.suggestion ?? issue.field ?? issue.message,
        });
      }
      groups.set(issue.code, group);
    }
  }

  // Errors first, then by how many rows they affect: the reviewer's biggest decision comes first.
  const order = { error: 0, warning: 1, info: 2 } as const;
  return [...groups.entries()]
    .map(([code, group]) => ({ code, ...group }))
    .sort((a, b) => order[a.severity] - order[b.severity] || b.rowCount - a.rowCount);
}

export async function loadBatchReview(
  db: SupabaseClient, orgId: string, batchId: string, requestId?: string,
): Promise<BatchReview | null> {
  const batches = await listBatches(db, orgId, { limit: 200, offset: 0 }, requestId);
  const batch = batches.find((b) => b.id === batchId);
  if (batch === undefined) return null;

  const [counts, rows, meta] = await Promise.all([
    countRowsByStatus(db, orgId, batchId, requestId),
    listBatchRows(db, orgId, batchId, {}, { limit: 500, offset: 0 }, requestId),
    loadBatchMeta(db, orgId, batchId, requestId),
  ]);

  const duplicates = rows.filter((r) => r.status === 'duplicate');
  const undecidedErrors = rows.filter(
    (r) => r.status === 'error' && undecided(r.reviewerDecision),
  );
  const importableRows = (counts.valid ?? 0) + (counts.warning ?? 0);
  const unconfirmedPages = batch.extractionMethod === 'pdf_claude'
    ? [...new Set(rows.filter((r) => r.sourcePage !== null && ['valid', 'warning', 'duplicate'].includes(r.status)).map((r) => r.sourcePage!))]
      .filter((page) => batch.pageConfirmations[String(page)] === undefined)
      .sort((a, b) => a - b)
    : [];
  const read = batch.extractionStats.balances_read ?? {};
  const typedBoth = meta.openingBalance !== null && meta.closingBalance !== null;
  const balanceComparison = batch.extractionMethod !== 'pdf_claude' || !typedBoth || (read.opening === undefined && read.closing === undefined)
    ? null
    : (read.opening !== undefined && read.closing !== undefined
        && parseMoney(read.opening).equals(parseMoney(meta.openingBalance!))
        && parseMoney(read.closing).equals(parseMoney(meta.closingBalance!)))
      ? 'matches_ai' as const : 'differs_from_ai' as const;
  const blocking = blockingReasonFor(batch, importableRows, meta, duplicates, undecidedErrors, unconfirmedPages);

  return {
    batch,
    filename: meta.filename,
    counts,
    issueGroups: groupIssues(rows),
    batchIssues: meta.batchIssues,
    requiredConfirmations: meta.requiredConfirmations,
    confirmedCodes: meta.confirmedCodes,
    duplicates,
    undecidedErrors,
    rows,
    importableRows,
    committable: blocking === null,
    blockingReason: blocking,
    unconfirmedPages,
    balanceComparison,
    typedBalances: { opening: meta.openingBalance, closing: meta.closingBalance },
  };
}

/**
 * Why Commit is not offered (§8.2).
 *
 * The database re-checks all of this at the moment of commit — `app.assert_batch_committable` is the
 * authority, and it re-runs against data that may have changed since. This exists so the screen can
 * say WHY rather than presenting a button that fails.
 */
function blockingReasonFor(
  batch: ImportBatch,
  importableRows: number,
  meta: BatchMeta,
  duplicates: readonly ImportRow[],
  undecidedErrors: readonly ImportRow[],
  unconfirmedPages: readonly number[] = [],
): string | null {
  if (batch.status === 'committed') return 'This file has already been imported.';
  if (batch.status === 'rolled_back') return 'This import was removed from your figures.';
  if (batch.status === 'failed') return 'This file could not be read all the way through.';
  if (batch.status === 'validating') return 'Still checking the file.';

  const outstanding = meta.requiredConfirmations.filter((c) => !meta.confirmedCodes.includes(c));
  if (outstanding.length > 0) {
    return 'A question below needs answering before this can be imported.';
  }

  const openDuplicates = duplicates.filter((r) => undecided(r.reviewerDecision)).length;
  if (openDuplicates > 0) {
    return `${openDuplicates} possible duplicate${openDuplicates === 1 ? '' : 's'} still need a decision.`;
  }

  if (undecidedErrors.length > 0) {
    return `${undecidedErrors.length} row${undecidedErrors.length === 1 ? '' : 's'} `
      + 'cannot be imported. Skip them, or fix the file and upload it again.';
  }

  if (importableRows === 0) {
    return 'No rows in this file are ready to import.';
  }

  // §5.4: a page the reviewer has not compared cannot contribute rows. The database refuses too.
  if (unconfirmedPages.length > 0) {
    return `Page${unconfirmedPages.length === 1 ? '' : 's'} ${unconfirmedPages.join(', ')} read by AI still need${unconfirmedPages.length === 1 ? 's' : ''} confirming against the statement.`;
  }

  return null;
}

interface BatchMeta {
  readonly filename: string | null;
  readonly openingBalance: string | null;
  readonly closingBalance: string | null;
  readonly batchIssues: ReadonlyArray<{ code: string; message: string; severity: string }>;
  readonly requiredConfirmations: readonly string[];
  readonly confirmedCodes: readonly string[];
}

async function loadBatchMeta(
  db: SupabaseClient, orgId: string, batchId: string, requestId?: string,
): Promise<BatchMeta> {
  const { data, error } = await db
    .from('import_batches')
    .select(`batch_issues, required_confirmations, confirmations, source_document_id, statement_opening_balance, statement_closing_balance`)
    .eq('organization_id', orgId)
    .eq('id', batchId)
    .maybeSingle();

  if (error) throw toMotionError(error, requestId);

  const row = data as {
    batch_issues?: unknown;
    required_confirmations?: unknown;
    confirmations?: unknown;
    source_document_id?: string | null;
    statement_opening_balance?: number | string | null;
    statement_closing_balance?: number | string | null;
  } | null;

  /*
   * The filename is fetched separately rather than embedded.
   *
   * `import_batches` references `source_documents` on the COMPOSITE key (organization_id, id) per
   * ADR-044.8, and PostgREST cannot always resolve an embed across one. A second small read is
   * cheaper than a join that works locally and fails on a different PostgREST version.
   */
  const filename = row?.source_document_id == null
    ? null
    : await loadFilename(db, orgId, row.source_document_id, requestId);

  const confirmations = row?.confirmations;
  return {
    filename,
    batchIssues: Array.isArray(row?.batch_issues)
      ? (row.batch_issues as Array<{ code: string; message: string; severity: string }>)
      : [],
    requiredConfirmations: Array.isArray(row?.required_confirmations)
      ? (row.required_confirmations as string[])
      : [],
    confirmedCodes: confirmations !== null && typeof confirmations === 'object'
      ? Object.keys(confirmations as Record<string, unknown>)
      : [],
    openingBalance: row?.statement_opening_balance == null ? null : toMoneyString(parseMoney(String(row.statement_opening_balance))),
    closingBalance: row?.statement_closing_balance == null ? null : toMoneyString(parseMoney(String(row.statement_closing_balance))),
  };
}

async function loadFilename(
  db: SupabaseClient, orgId: string, documentId: string, requestId?: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('source_documents')
    .select('original_filename')
    .eq('organization_id', orgId)
    .eq('id', documentId)
    .maybeSingle();
  if (error) throw toMotionError(error, requestId);
  return (data as { original_filename?: string } | null)?.original_filename ?? null;
}

export interface ImportHistoryRow {
  readonly batch: ImportBatch;
  readonly filename: string | null;
  readonly rows: number;
}

/** The import history (§13): what was loaded, when, and what became of it. */
export async function loadImportHistory(
  db: SupabaseClient, orgId: string, requestId?: string,
): Promise<ImportHistoryRow[]> {
  const batches = await listBatches(db, orgId, { limit: 100, offset: 0 }, requestId);
  if (batches.length === 0) return [];

  const { data } = await db
    .from('source_documents')
    .select('id, original_filename')
    .eq('organization_id', orgId)
    .in('id', batches.map((b) => b.sourceDocumentId).filter((id): id is string => id !== null));

  const names = new Map(
    ((data ?? []) as Array<{ id: string; original_filename: string }>)
      .map((row) => [row.id, row.original_filename]),
  );

  return batches.map((batch) => ({
    batch,
    filename: batch.sourceDocumentId === null ? null : names.get(batch.sourceDocumentId) ?? null,
    rows: Object.values(batch.rowCounts ?? {}).reduce<number>(
      (total, n) => total + (typeof n === 'number' ? n : 0), 0,
    ),
  }));
}
