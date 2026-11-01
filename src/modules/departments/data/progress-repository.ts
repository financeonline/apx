import 'server-only';
import { orgRows, orgRowsByIds } from '@/db/rls';
import type { Db } from '@/db/types';

/**
 * Reads for Data progress (`/data/progress`) and the dashboard's Compliance View card. Every read is
 * the caller's, through the read policies in `src/db/rls.ts` (a table they may not read is empty).
 * One query per collection, filtered here — the local emulator has no indexes, and a company has
 * tens or hundreds of uploads, not thousands — and documents by id through `orgRowsByIds`.
 */

export interface BatchRow {
  readonly id: string;
  readonly importType: string;
  readonly status: string;
  readonly bankAccountId: string | null;
  readonly sourceDocumentId: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly errorStage: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string | null;
  readonly committedAt: string | null;
  readonly rolledBackAt: string | null;
  /** The printed statement balances (bank statements); null when not entered or not read. */
  readonly statementOpening: string | null;
  readonly statementClosing: string | null;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const amount = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/** Every upload the caller may see, newest first (one read; `imports.review`, else none). */
export async function allBatches(db: Db, orgId: string): Promise<BatchRow[]> {
  const rows = await orgRows<Record<string, unknown>>(db, orgId, 'import_batches', (q) => q.select(
    'id', 'import_type', 'status', 'bank_account_id', 'source_document_id', 'period_start', 'period_end', 'row_counts',
    'error_summary', 'created_at', 'committed_at', 'rolled_back_at', 'statement_opening_balance', 'statement_closing_balance',
  ));
  return rows.map((r) => {
    const error = (r.error_summary ?? null) as { stage?: unknown; message?: unknown } | null;
    const counts = (r.row_counts ?? {}) as Record<string, unknown>;
    return {
      id: String(r.id),
      importType: String(r.import_type ?? ''),
      status: String(r.status ?? ''),
      bankAccountId: text(r.bank_account_id),
      sourceDocumentId: text(r.source_document_id),
      periodStart: text(r.period_start),
      periodEnd: text(r.period_end),
      rowCounts: Object.fromEntries(Object.entries(counts).filter(([, n]) => typeof n === 'number')) as Record<string, number>,
      errorStage: text(error?.stage),
      errorMessage: text(error?.message),
      createdAt: text(r.created_at),
      committedAt: text(r.committed_at),
      rolledBackAt: text(r.rolled_back_at),
      statementOpening: amount(r.statement_opening_balance),
      statementClosing: amount(r.statement_closing_balance),
    };
  }).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/** Original file names by document id; an id the caller may not read is absent. */
export async function documentNames(db: Db, orgId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await orgRowsByIds<{ id: string; original_filename?: string | null }>(db, orgId, 'source_documents', ids);
  return new Map(rows.map((r) => [r.id, r.original_filename ?? 'Untitled file']));
}

export interface RunFacts {
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly engineVersion: string | null;
}

const toRun = (r: Record<string, unknown> | undefined): RunFacts | null => (r === undefined ? null : {
  status: String(r.status ?? ''),
  startedAt: text(r.started_at),
  finishedAt: text(r.finished_at),
  engineVersion: text(r.engine_version),
});

/**
 * The latest calculation run (any status) and the latest that succeeded. Two single-document reads
 * (`calculation_runs` is readable with `financials.view` or `reports.view`; otherwise both null).
 */
export async function latestRuns(db: Db, orgId: string): Promise<{ latest: RunFacts | null; succeeded: RunFacts | null }> {
  const fields = ['status', 'started_at', 'finished_at', 'engine_version'];
  const [latest, succeeded] = await Promise.all([
    orgRows<Record<string, unknown>>(db, orgId, 'calculation_runs', (q) => q.orderBy('started_at', 'desc').limit(1).select(...fields)),
    orgRows<Record<string, unknown>>(db, orgId, 'calculation_runs', (q) => q
      .where('status', '==', 'succeeded').orderBy('finished_at', 'desc').limit(1).select(...fields)),
  ]);
  return { latest: toRun(latest[0]), succeeded: toRun(succeeded[0]) };
}
