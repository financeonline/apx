import 'server-only';
import { ConflictError, ValidationError, toMotionError } from '@/core/errors';
import type { DocumentData, Query } from 'firebase-admin/firestore';
import { orgRowById as rlsRowById, orgRows as rlsRows } from '@/db/rls';
import { orgCollection, orgRow, type OrgTable } from '@/db/schema';
import type { Db } from '@/db/types';
import { log } from '@/core/logging';
import { runPipeline, type PipelineInput, type AccountRef, type CounterpartyRef } from '../domain/pipeline';
import type { ParsedTable, TargetField, Transforms } from '../domain/pipeline-types';
import type { ImportTarget, ImportType } from '../domain/types';
import { heldNameKey } from '../domain/mapping';

/**
 * Parse → map → validate → detect duplicates → persist (IMPORT_ENGINE.md §5–§9).
 *
 * This is the seam between the pure pipeline and the database. It reads what the pipeline needs
 * (the chart of accounts, counterparties, the records already accepted), runs the pure functions,
 * and writes the result through `api_server.*` — because a parse result is a fact the SERVER
 * observed about a file, not an intention a user expressed (ADR-043).
 *
 * Note what it does NOT do: decide whether the batch may commit. That is `app.assert_batch_committable`
 * (ported to `src/db/app/imports-*.ts`), re-checked at the moment of commit against data that may have changed since.
 */

export interface ParseAndValidateInput {
  readonly organizationId: string;
  readonly batchId: string;
  readonly importType: ImportType;
  readonly targetTable: ImportTarget;
  readonly table: ParsedTable;
  readonly columnMap: Readonly<Record<string, TargetField>>;
  readonly transforms: Transforms;
  readonly declaredPeriodStart: string;
  readonly declaredPeriodEnd: string;
  readonly bankAccountId?: string | null;
  /** Issues added to every tabular row by the caller — the extraction job's `IMP-PDF-001` (§5.4). */
  readonly annotateRow?: PipelineInput['annotateRow'];
  readonly balancesRequired?: boolean;
}

export interface ParseAndValidateDeps {
  readonly db: Db;
  readonly actorUserId: string;
  readonly today: string;
  readonly baseCurrency: string;
  readonly writeRows: (batchId: string, rows: unknown[]) => Promise<number>;
  readonly setValidation: (
    batchId: string,
    batchIssues: unknown[],
    required: string[],
    counts: Record<string, number>,
    statement: Record<string, unknown> | null,
  ) => Promise<void>;
  readonly failBatch: (batchId: string, stage: string, message: string) => Promise<void>;
  readonly requestId?: string;
}

/**
 * Reads for the pipeline. A request reads as the reviewer, through the read policies
 * (`src/db/rls.ts`). The extraction JOB reads as the server — the service role bypassed row-level
 * security on PostgreSQL, and `orgRows` admits no row to a service actor — so it reads the
 * organisation's collection directly, and only the organisation the job is scoped to.
 */
function serverRead(db: Db, orgId: string): boolean {
  if (db.actor.kind !== 'service') return false;
  if (db.actor.scope !== null && db.actor.scope !== orgId) {
    throw new ConflictError('The organization scope does not match the organization being read.');
  }
  return true;
}

async function orgRows<T = DocumentData>(db: Db, orgId: string, table: OrgTable, refine?: (q: Query) => Query): Promise<T[]> {
  if (!serverRead(db, orgId)) return rlsRows<T>(db, orgId, table, refine);
  const base: Query = orgCollection(db.fs, orgId, table);
  const snap = await (refine ? refine(base) : base).get();
  return snap.docs.map((d) => d.data() as T);
}

async function orgRowById<T = DocumentData>(db: Db, orgId: string, table: OrgTable, id: string): Promise<T | null> {
  if (!serverRead(db, orgId)) return rlsRowById<T>(db, orgId, table, id);
  const snap = await orgRow(db.fs, orgId, table, id).get();
  return snap.exists ? (snap.data() as T) : null;
}

/** The maximum rows a request may commit synchronously (§11.7, CD-22). */
export const SYNC_ROW_LIMIT = 5_000;

async function loadAccounts(
  db: Db, orgId: string, _requestId?: string,
): Promise<AccountRef[]> {
  const data = await orgRows<Record<string, unknown>>(db, orgId, 'accounts', (q) => q
    .select('id', 'code', 'name', 'normalized_name'));
  return data.map((a) => ({
    id: a.id as string,
    code: a.code as string | null,
    normalizedName: a.normalized_name as string,
    name: a.name as string,
  }));
}

export async function loadCounterparties(
  db: Db, orgId: string, _requestId?: string,
): Promise<CounterpartyRef[]> {
  // Every one: a customer missing from this list would look new, could not be created (its name is
  // taken) and would block its invoice row. (PostgREST capped a read at 1,000 rows; Firestore does
  // not, so the old paging is gone.)
  const data = await orgRows<Record<string, unknown>>(db, orgId, 'counterparties', (q) => q
    .select('id', 'name', 'normalized_name', 'merged_into_id'));

  /*
   * A merged-away counterparty keeps its name, and `normalized_name` is unique across merged rows
   * too — so a file naming it can neither match it (it is not current) nor create it again (the
   * name is taken). Its name resolves to the counterparty it was merged into, following the chain,
   * which is what the engine already does with `merged_into_id`.
   */
  const rows = data as Array<{ id: string; name: string; normalized_name: string; merged_into_id: string | null }>;
  const mergedInto = new Map(rows.map((c) => [c.id, c.merged_into_id]));
  const survivor = (id: string): string => {
    let current = id;
    for (let hop = 0; hop < rows.length; hop += 1) {
      const next = mergedInto.get(current);
      if (next === null || next === undefined) return current;
      current = next;
    }
    return current;
  };
  // A merged-away record that was HELD (ADR-136) no longer stands for anyone: the merge was the
  // decision, so it neither blocks the name nor resolves it.
  return rows
    .filter((c) => !(c.merged_into_id !== null && heldNameKey(c.normalized_name) !== null))
    .map((c) => ({ id: survivor(c.id), normalizedName: c.normalized_name, name: c.name }));
}

/**
 * The records duplicate detection compares against: accepted and not superseded, which is the
 * definition of "current" everywhere in the system. A rolled-back row must NOT block a re-import of
 * the same data, which is exactly why the filter is on both columns.
 */
async function loadExistingRecords(
  db: Db, orgId: string, target: ImportTarget, _requestId?: string,
) {
  const dateColumn = target === 'bank_transactions' ? 'transaction_date'
    : target === 'ledger_entries' ? 'entry_date'
    : target === 'invoices' ? 'issue_date' : 'period_start';
  const amountColumn = target === 'period_balances' ? 'closing_balance'
    : target === 'invoices' ? 'total_amount' : 'amount';

  // `period_balances` has no row hash: balances supersede at batch scope (§11), so there is no row
  // duplicate to find, and selecting the column failed every trial balance, P&L and balance sheet.
  // Budget lines likewise (ADR-142): a month's budget replaces the last one at batch scope.
  const columns: string[] = target === 'period_balances' || target === 'budget_lines'
    ? ['id', dateColumn, amountColumn]
    : ['id', 'dedupe_hash', dateColumn, amountColumn];
  const data = await orgRows<Record<string, unknown>>(db, orgId, target, (q) => q
    .where('record_status', '==', 'accepted')
    .where('superseded_by', '==', null)
    .select(...columns)
    .limit(50_000));

  return data.map((row) => {
    return {
      id: row.id as string,
      // Stored as lower-case hex (no `\\x`), which is what the pipeline works in.
      dedupeHash: String(row.dedupe_hash ?? '').replace(/^\\x/, ''),
      date: String(row[dateColumn] ?? ''),
      amount: String(row[amountColumn] ?? '0'),
      scopeKey: '',
      normalizedDescription: '',
    };
  });
}

export async function parseAndValidate(
  deps: ParseAndValidateDeps,
  input: ParseAndValidateInput,
): Promise<{ counts: Record<string, number>; requiredConfirmations: readonly string[] }> {
  try {
    if (input.table.rows.length > SYNC_ROW_LIMIT * 10) {
      throw new ValidationError(
        'That file has more rows than APX can import in one go. Split it by period.',
      );
    }

    const [accounts, counterparties, existingRecords] = await Promise.all([
      loadAccounts(deps.db, input.organizationId, deps.requestId),
      loadCounterparties(deps.db, input.organizationId, deps.requestId),
      loadExistingRecords(deps.db, input.organizationId, input.targetTable, deps.requestId),
    ]);

    let bankIdentity;
    // A card or loan statement's balances are what is owed, so its balance checks run the other way.
    let liabilityAccount = false;
    if (input.bankAccountId) {
      const data = await orgRowById<Record<string, unknown>>(deps.db, input.organizationId, 'bank_accounts', input.bankAccountId);
      if (data) {
        liabilityAccount = data.account_type === 'credit_card' || data.account_type === 'loan';
        bankIdentity = {
          bankName: data.bank_name as string | null,
          sortCodeMasked: data.sort_code_masked as string | null,
          accountNumberMasked: data.account_number_masked as string | null,
        };
      }
    }

    const result = runPipeline({
      organizationId: input.organizationId,
      importType: input.importType,
      targetTable: input.targetTable,
      table: input.table,
      columnMap: input.columnMap,
      transforms: input.transforms,
      baseCurrency: deps.baseCurrency,
      today: deps.today,
      declaredPeriodStart: input.declaredPeriodStart,
      declaredPeriodEnd: input.declaredPeriodEnd,
      ...(input.annotateRow === undefined ? {} : { annotateRow: input.annotateRow }),
      ...(input.balancesRequired === undefined ? {} : { balancesRequired: input.balancesRequired }),
      liabilityAccount,
      accounts,
      counterparties,
      existingRecords,
      bankIdentity,
    });

    /*
     * ADR-139 C4: a report that would REPLACE an accepted report of its kind for a month it states is
     * asked about here, while the reviewer is reading the file — not only when Import is pressed
     * (commit still re-checks under the organisation lock, for a report committed in between).
     */
    let requiredConfirmations = [...result.requiredConfirmations];
    const kind = input.importType === 'trial_balance' || input.importType === 'pnl_report' || input.importType === 'balance_sheet'
      ? input.importType : null;
    if (input.targetTable === 'period_balances' && kind !== null && !requiredConfirmations.includes('IMP-COV-013')) {
      const months = [...new Set(result.rows.filter((r) => r.status !== 'error')
        .map((r) => r.mapped.period_start).filter((m): m is string => typeof m === 'string' && m !== ''))];
      if (months.length > 0) {
        let count = 0;
        for (let i = 0; i < months.length && count === 0; i += 30) {
          const chunk = months.slice(i, i + 30);
          const current = await orgRows<{ import_batch_id: string | null }>(deps.db, input.organizationId, 'period_balances', (q) => q
            .where('balance_kind', '==', kind)
            .where('record_status', '==', 'accepted')
            .where('superseded_by', '==', null)
            .where('period_start', 'in', chunk)
            .select('import_batch_id'));
          count += current.filter((r) => r.import_batch_id !== input.batchId).length;
        }
        if (count > 0) requiredConfirmations = [...requiredConfirmations, 'IMP-COV-013'];
      }
    }

    // Every parsed line becomes a row, including the ones that will never commit. That is the
    // invariant the whole engine rests on (SOW §23).
    await deps.writeRows(
      input.batchId,
      result.rows.map((row) => ({
        row_number: row.rowNumber,
        source_ref: row.sourceRef,
        source_page: row.sourcePage ?? null,
        raw_data: row.raw,
        mapped_data: row.mapped,
        status: row.status,
        issues: row.issues,
        dedupe_hash: row.dedupeHash,
        reviewer_decision: 'none',
        reviewer_reason: row.suggestedReason ?? null,
      })),
    );

    await deps.setValidation(
      input.batchId,
      [...result.batchIssues],
      requiredConfirmations,
      result.counts,
      input.table.statement
        ? {
            // Deterministic capture only. An AI-read balance never reaches these columns (§5.4).
            opening: input.table.statement.openingBalance ?? null,
            closing: input.table.statement.closingBalance ?? null,
          }
        : null,
    );

    return { counts: result.counts, requiredConfirmations };
  } catch (cause) {
    // §16: a parse or validation failure leaves the batch `failed` with a reason the user can act
    // on, and the document intact so they can retry without re-uploading. It is never swallowed.
    const message = cause instanceof Error ? cause.message : String(cause);
    log.error('an import could not be validated', { batchId: input.batchId, error: message });
    await deps.failBatch(input.batchId, 'validate', message).catch(() => {
      // The batch could not even be marked failed; the original error is the one worth raising.
    });
    throw cause instanceof ConflictError || cause instanceof ValidationError
      ? cause
      : toMotionError(cause, deps.requestId);
  }
}
