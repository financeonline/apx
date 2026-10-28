import 'server-only';
import Decimal from 'decimal.js';
import type { Transaction } from 'firebase-admin/firestore';
import { raise } from '../raise';
import { globalRow, newId, nowIso, orgCollection, orgRow } from '../schema';
import { readerOf, type Db } from '../types';
import { hasPermissionOf } from './access';
import { standardCategoryAccountType, prepareNotify, type StandardCategory } from './shared';
import { chunks, type Data, type WorkingSet } from './imports-ws';
import {
  assertRecordComplete, assertSameOrg, assignPeriods, auditInto, auditRowChange, batchRecordAssurance,
  flagRunsStale, isCurrent, isoDate, loadGuards, openBankCategoryHistory, recordFromRow, statusEventInto,
  str, supersedeRow, syncCurrentGuard, updateRecord, type AuditStamp, type RecordTable,
} from './imports-records';

/**
 * The import commit and rollback (IMPORT_ENGINE.md §9.3, §11, §13; ADR-012, ADR-029, ADR-047,
 * ADR-073, ADR-130, ADR-142) — the ports of `app.commit_import_batch`, `app.assert_batch_committable`,
 * `app.rerun_dedupe`, `app.rollback_import_batch` and `app.promote_dependants`.
 *
 * Each runs the SQL function's statements, in the SQL order, against a working set
 * (src/db/app/imports-ws.ts), so what one statement wrote is what the next one reads. Nothing here
 * writes to Firestore: the caller (src/db/app/imports-exec.ts) writes the working set's final state,
 * in ONE transaction when it fits — which is every ordinary import, and then the commit is as atomic
 * as the PL/pgSQL was — or as a durable, resumable plan when it does not.
 *
 * The trigger effects the SQL relied on are done here explicitly: the fiscal period of every record
 * (`period_assign`), `mask_description`, `open_bank_category_history`, `superseded_at_set`,
 * `set_updated_at`, the row audits (`audit_diff`), `flag_runs_stale`, the partial unique indexes
 * (`invoices_identity_unique`, `single_current_balance`, `single_current_budget` — guard documents),
 * `invoice_list_kind_at_commit` and `notify_data_added`.
 */

export interface ImportCtx {
  readonly db: Db;
  readonly orgId: string;
  /** `p_actor`: who the commit is for (reviewed_by). */
  readonly actorId: string | null;
  /** `app.uid()`: the signed-in caller, or null on the server path (status history, job requester). */
  readonly uid: string | null;
  /** `app.audit(..., p_actor)`. */
  readonly stamp: AuditStamp;
  /** The `audit_diff` trigger's `app.audit` (no actor passed). */
  readonly rowStamp: AuditStamp;
}

/**
 * What the transaction that writes the working set's LAST part must also do — data, not a closure,
 * so a chunked commit that resumes after a crash can still do it (src/db/app/imports-exec.ts):
 * the recalculation requests (`app.enqueue_recalculation`, folded into one queued job), the
 * `notify_data_added` notifications for a batch that became committed, and the batch that records
 * the recalculation job's id (`calculation_job_id`).
 */
export interface FinalizeSpec {
  readonly recalc: ReadonlyArray<{ trigger: string; refId: string | null }>;
  readonly requestedBy: string | null;
  readonly notifyBatchId: string | null;
  readonly jobOnBatchId: string | null;
}

export interface Outcome<R> {
  readonly result: R;
  readonly finalize?: FinalizeSpec;
}

const ELIGIBLE = (r: Data): boolean =>
  ((r.status === 'valid' || r.status === 'warning') || (r.status === 'duplicate' && r.reviewer_decision === 'keep'))
  && r.reviewer_decision !== 'skip';

const byRowNumber = (a: Data, b: Data) => Number(a.row_number) - Number(b.row_number);

export async function batchOf(ws: WorkingSet, orgId: string, batchId: string): Promise<Data | null> {
  return ws.get(orgRow(ws.fs, orgId, 'import_batches', batchId));
}

export async function batchRows(ws: WorkingSet, orgId: string, batchId: string): Promise<Data[]> {
  const col = orgCollection(ws.fs, orgId, 'import_rows');
  return ws.query(col, col.where('batch_id', '==', batchId), (d) => d.batch_id === batchId, `${col.path}?batch_id=${batchId}`);
}

function updateRow(ws: WorkingSet, orgId: string, id: string, patch: Data): Data {
  return ws.update(orgRow(ws.fs, orgId, 'import_rows', id), { ...patch, updated_at: nowIso() });
}

function updateBatch(ws: WorkingSet, orgId: string, id: string, patch: Data): Data {
  return ws.update(orgRow(ws.fs, orgId, 'import_batches', id), { ...patch, updated_at: nowIso() });
}

/** Records of `table` whose `field` is one of `values` (in-memory state; `in` queries of 30). */
async function recordsWhereIn(
  ws: WorkingSet, orgId: string, table: RecordTable | 'import_rows', field: string, values: readonly string[], keep: (d: Data) => boolean,
): Promise<Data[]> {
  const col = orgCollection(ws.fs, orgId, table);
  const unique = [...new Set(values.filter(Boolean))];
  const seen = new Map<string, Data>();
  for (const c of chunks(unique, 30)) {
    for (const d of await ws.query(col, col.where(field, 'in', c), (x) => c.includes(String(x[field])) && keep(x))) {
      seen.set(String(d.id), d);
    }
  }
  // Rows created in memory in this operation carry the value too.
  for (const d of ws.inMemory(col, (x) => unique.includes(String(x[field])) && keep(x))) seen.set(String(d.id), d);
  return [...seen.values()];
}

// ── app.assert_batch_committable ─────────────────────────────────────────────────────────────────

export async function assertBatchCommittable(ws: WorkingSet, orgId: string, batchId: string): Promise<{ batch: Data; rows: Data[] }> {
  const batch = await batchOf(ws, orgId, batchId);
  if (!batch) raise.notFound();
  if (batch.status !== 'awaiting_review') raise.conflict('this batch is not awaiting review');
  const rows = await batchRows(ws, orgId, batchId);

  const errors = rows.filter((r) => r.status === 'error' && r.reviewer_decision !== 'skip').length;
  if (errors > 0) raise.invalid(`${errors} row(s) still have errors; fix or skip them first`);
  const pending = rows.filter((r) => r.status === 'pending').length;
  if (pending > 0) raise.invalid(`${pending} row(s) have not been re-validated since they were edited`);

  const batchErrors = ((batch.batch_issues as Data[] | null) ?? []).filter((i) => i && i.severity === 'error').length;
  if (batchErrors > 0) {
    raise.invalid(`this file has ${batchErrors} problem(s) that must be resolved before it can be imported`);
  }
  const confirmed = (batch.confirmations as Data | null) ?? {};
  const missing = ((batch.required_confirmations as string[] | null) ?? []).find((c) => !(c in confirmed));
  if (missing !== undefined) raise.invalid(`confirmation ${missing} has not been recorded`);
  if (!batch.period_start || !batch.period_end) {
    raise.invalid('confirm the period this export covers before importing it');
  }
  if (batch.extraction_method === 'pdf_claude') {
    const pages = (batch.page_confirmations as Data | null) ?? {};
    const unconfirmed = new Set(rows
      .filter((r) => r.source_page !== null && r.source_page !== undefined
        && (r.status === 'valid' || r.status === 'warning' || r.status === 'duplicate')
        && !(String(r.source_page) in pages))
      .map((r) => Number(r.source_page))).size;
    if (unconfirmed > 0) raise.invalid(`${unconfirmed} page(s) read by AI have not been confirmed`);
  }
  return { batch, rows };
}

// ── app.rerun_dedupe ─────────────────────────────────────────────────────────────────────────────

const appendIssue = (row: Data, issue: Data): Data[] => [...(((row.issues as Data[] | null) ?? [])), issue];

export async function rerunDedupe(ws: WorkingSet, orgId: string, batchId: string, target: RecordTable): Promise<number> {
  if (target === 'period_balances' || target === 'budget_lines') return 0;
  const rows = (await batchRows(ws, orgId, batchId)).sort(byRowNumber);

  // Pass 2: the same row, byte for byte, committed since this file was checked.
  const candidates = rows.filter((r) => (r.status === 'valid' || r.status === 'warning')
    && r.reviewer_decision !== 'skip' && r.dedupe_hash !== null && r.dedupe_hash !== undefined);
  const existing = await recordsWhereIn(ws, orgId, target, 'dedupe_hash', candidates.map((r) => String(r.dedupe_hash)),
    (t) => isCurrent(t) && t.import_batch_id !== batchId);
  const byHash = new Map<string, Data>();
  for (const t of existing) if (!byHash.has(String(t.dedupe_hash))) byHash.set(String(t.dedupe_hash), t);
  let collisions = 0;
  for (const r of candidates) {
    const hit = byHash.get(String(r.dedupe_hash));
    if (!hit || hit.import_batch_id === r.batch_id) continue;
    updateRow(ws, orgId, String(r.id), {
      status: 'duplicate', duplicate_of_table: target, duplicate_of_id: hit.id, reviewer_decision: 'none',
      issues: appendIssue(r, {
        code: 'IMP-DUP-001', severity: 'duplicate',
        message: 'This row duplicates a record committed since this file was checked.',
      }),
    });
    collisions += 1;
  }

  if (target === 'invoices') {
    // Pass 1 (ADR-073): the same invoice IDENTITY committed since this file was checked updates it.
    const fresh = (await batchRows(ws, orgId, batchId)).filter((r) => (r.status === 'valid' || r.status === 'warning')
      && r.reviewer_decision !== 'skip' && (r.duplicate_of_id ?? null) === null);
    const numbers = fresh.map((r) => str((r.mapped_data as Data | null)?.invoice_number)).filter((n): n is string => !!n);
    const invoices = await recordsWhereIn(ws, orgId, 'invoices', 'invoice_number', numbers,
      (i) => isCurrent(i) && i.import_batch_id !== batchId);
    for (const r of fresh) {
      const m = (r.mapped_data ?? {}) as Data;
      const hit = invoices.find((i) => i.invoice_type === str(m.invoice_type) && i.counterparty_id === str(m.counterparty_id)
        && i.invoice_number === str(m.invoice_number) && i.import_batch_id !== r.batch_id);
      if (!hit) continue;
      updateRow(ws, orgId, String(r.id), {
        duplicate_of_table: 'invoices', duplicate_of_id: hit.id,
        issues: appendIssue(r, {
          code: 'IMP-INV-010', severity: 'warning',
          message: 'An invoice with this number for this customer was committed since this file was checked; this row updates it.',
        }),
      });
    }

    // An update candidate whose target was itself updated since validation follows the chain.
    const pointing = (await batchRows(ws, orgId, batchId))
      .filter((r) => r.duplicate_of_table === 'invoices' && r.duplicate_of_id);
    const olds = await ws.load(pointing.map((r) => orgRow(ws.fs, orgId, 'invoices', String(r.duplicate_of_id))));
    const stale = pointing.map((r, i) => ({ r, old: olds[i] })).filter((x) => x.old && (x.old.superseded_by ?? null) !== null);
    if (stale.length > 0) {
      const current = await recordsWhereIn(ws, orgId, 'invoices', 'invoice_number',
        stale.map((x) => String(x.old!.invoice_number)), (i) => isCurrent(i));
      for (const { r, old } of stale) {
        const cur = current.find((c) => c.invoice_type === old!.invoice_type
          && (c.counterparty_id ?? null) === (old!.counterparty_id ?? null) && c.invoice_number === old!.invoice_number);
        if (cur) updateRow(ws, orgId, String(r.id), { duplicate_of_id: cur.id });
      }
    }
  }
  return collisions;
}

// ── Loading what a set of records references ─────────────────────────────────────────────────────

/** The composite foreign keys the inserts relied on: each referenced row must exist in this organisation. */
async function assertReferences(ws: WorkingSet, orgId: string, table: RecordTable, recs: readonly Data[]): Promise<void> {
  const refs: Array<[('accounts' | 'counterparties' | 'bank_accounts'), string, string]> = [];
  for (const r of recs) {
    if (r.account_id) refs.push(['accounts', String(r.account_id), `${table}.account_id`]);
    if (r.counterparty_id) refs.push(['counterparties', String(r.counterparty_id), `${table}.counterparty_id`]);
    if (r.bank_account_id) refs.push(['bank_accounts', String(r.bank_account_id), `${table}.bank_account_id`]);
  }
  const unique = [...new Map(refs.map((x) => [`${x[0]}/${x[1]}`, x])).values()];
  for (const c of chunks(unique, 300)) await ws.load(c.map(([t, id]) => orgRow(ws.fs, orgId, t, id)));
  for (const [t, id, label] of unique) await assertSameOrg(ws, orgId, t, id, label);
}

function balanceKindOf(importType: unknown): 'trial_balance' | 'pnl_report' | 'balance_sheet' {
  return importType === 'trial_balance' ? 'trial_balance' : importType === 'pnl_report' ? 'pnl_report' : 'balance_sheet';
}

// ── app.commit_import_batch ──────────────────────────────────────────────────────────────────────

export interface CommitResultRow {
  status: 'committed' | 'conflict' | 'needs_confirmation';
  committed: number;
  superseded: number;
  collisions?: number;
  code?: string;
  replaces?: number;
  job?: string | null;
}

export async function computeCommit(ws: WorkingSet, ctx: ImportCtx, batchId: string): Promise<Outcome<CommitResultRow>> {
  const { orgId } = ctx;
  const fs = ws.fs;
  await assertBatchCommittable(ws, orgId, batchId);
  let batch = (await batchOf(ws, orgId, batchId))!;
  const target = String(batch.target_table) as RecordTable;
  const method = String(batch.extraction_method);

  // §9.3, BEFORE anything is written: a collision RETURNS (the re-flagged rows are the evidence).
  const collisions = await rerunDedupe(ws, orgId, batchId, target);
  if (collisions > 0) {
    updateBatch(ws, orgId, batchId, {
      status: 'awaiting_review', error_summary: { stage: 'dedupe', collisions, at: nowIso() },
    });
    auditInto(ws, orgId, ctx.stamp, {
      action: 'import.commit_conflicted', targetTable: 'import_batches', targetId: batchId, after: { collisions },
    });
    return { result: { status: 'conflict', collisions, committed: 0, superseded: 0 } };
  }

  let kind: 'trial_balance' | 'pnl_report' | 'balance_sheet' | null = null;
  if (target === 'period_balances') {
    kind = balanceKindOf(batch.import_type);
    // Step 0F (N-3): replacing accepted balances is never silent (IMP-COV-013).
    const months = [...new Set((await batchRows(ws, orgId, batchId)).filter(ELIGIBLE)
      .map((r) => isoDate((r.mapped_data as Data | null)?.period_start)).filter((d): d is string => !!d))];
    const replaced = await recordsWhereIn(ws, orgId, 'period_balances', 'period_start', months,
      (o) => o.balance_kind === kind && isCurrent(o) && o.import_batch_id !== batchId);
    const confirmations = (batch.confirmations as Data | null) ?? {};
    if (replaced.length > 0 && !('IMP-COV-013' in confirmations)) {
      const required = (batch.required_confirmations as string[] | null) ?? [];
      updateBatch(ws, orgId, batchId, {
        required_confirmations: required.includes('IMP-COV-013') ? required : [...required, 'IMP-COV-013'],
      });
      auditInto(ws, orgId, ctx.stamp, {
        action: 'import.replacement_unconfirmed', targetTable: 'import_batches', targetId: batchId,
        after: { replaces: replaced.length },
      });
      return { result: { status: 'needs_confirmation', code: 'IMP-COV-013', replaces: replaced.length, committed: 0, superseded: 0 } };
    }
  }

  batch = updateBatch(ws, orgId, batchId, { status: 'committing' });

  const issues = (batch.batch_issues as Data[] | null) ?? [];
  const reconciled = !issues.some((i) => i && (i.code === 'IMP-BAL-006' || i.code === 'IMP-BAL-007'));
  const assurance = method === 'pdf_claude' ? 'inferred' : method === 'pdf_text' ? (reconciled ? 'verified' : 'calculated') : 'verified';

  const eligible = (await batchRows(ws, orgId, batchId)).filter(ELIGIBLE).sort(byRowNumber);
  const dateCol = { ledger_entries: 'entry_date', bank_transactions: 'transaction_date', invoices: 'issue_date', period_balances: 'period_start', budget_lines: 'period_start' }[target];
  const periods = await assignPeriods(ws, orgId, eligible
    .map((r) => isoDate((r.mapped_data as Data | null)?.[dateCol])).filter((d): d is string => !!d));
  const src = {
    orgId, batchId, documentId: str(batch.source_document_id), bankAccountId: str(batch.bank_account_id), assurance, periods,
  };

  // The reporting-sign flip (N-6) needs each account's category: load them once.
  const sign = String(batch.balance_sign ?? 'natural');
  if (target === 'period_balances' || target === 'budget_lines' || target === 'ledger_entries') {
    const ids = [...new Set(eligible.map((r) => str((r.mapped_data as Data | null)?.account_id)).filter((x): x is string => !!x))];
    for (const c of chunks(ids, 300)) await ws.load(c.map((id) => orgRow(fs, orgId, 'accounts', id)));
  }

  // Build every record first, so the guards and references can be loaded in one pass.
  const planned: Array<{ row: Data; rec: Data; update: boolean }> = [];
  const cells = new Set<string>();
  for (const row of eligible) {
    const id = newId();
    const keep = row.reviewer_decision === 'keep';
    let rec: Data;
    let update = false;
    if (target === 'invoices') {
      update = row.duplicate_of_table === 'invoices' && !!row.duplicate_of_id;
      rec = recordFromRow(target, row, src, id, { recordStatus: update ? 'pending' : 'accepted', duplicateReviewed: keep });
    } else if (target === 'period_balances') {
      const m = (row.mapped_data ?? {}) as Data;
      let closing: string | null = null;
      if (sign === 'reporting' && (m.debit_total ?? null) === null && (m.credit_total ?? null) === null) {
        const account = ws.peek(orgRow(fs, orgId, 'accounts', String(m.account_id ?? '')));
        const type = account ? standardCategoryAccountType(account.standard_category as StandardCategory) : null;
        if (type === 'income' || type === 'liability' || type === 'equity') {
          const raw = str(m.closing_balance);
          closing = raw === null ? null : new Decimal(raw).neg().toFixed(2);
        }
      }
      rec = recordFromRow(target, row, src, id, {
        recordStatus: 'pending', duplicateReviewed: keep, closing, kind: kind!, basis: String(batch.balance_basis ?? 'movement'),
      });
    } else if (target === 'budget_lines') {
      rec = recordFromRow(target, row, src, id, { recordStatus: 'pending', duplicateReviewed: keep });
    } else {
      rec = recordFromRow(target, row, src, id, { recordStatus: 'accepted', duplicateReviewed: keep });
    }
    assertRecordComplete(target, rec);
    if (target === 'period_balances' || target === 'budget_lines') {
      const cell = `${rec.period_id}|${rec.account_id}`;
      if (cells.has(cell)) {
        raise.conflict(`duplicate key value violates unique constraint "${target}_batch_cell_unique"`);
      }
      cells.add(cell);
    }
    planned.push({ row, rec, update });
  }
  await assertReferences(ws, orgId, target, planned.map((p) => p.rec));

  // Invoice update candidates: the invoices they replace, and every guard involved.
  const replacedInvoices = planned.filter((p) => p.update).map((p) => orgRow(fs, orgId, 'invoices', String(p.row.duplicate_of_id)));
  const oldInvoices = await ws.load(replacedInvoices);
  await loadGuards(ws, target, [...planned.map((p) => ({ ...p.rec, record_status: 'accepted' })), ...oldInvoices]);

  // Balances and budgets: the accepted rows of the months this batch states (superseded below).
  let olds: Data[] = [];
  if (target === 'period_balances' || target === 'budget_lines') {
    const periodIds = [...new Set(planned.map((p) => String(p.rec.period_id)))];
    olds = await recordsWhereIn(ws, orgId, target, 'period_id', periodIds,
      (o) => isCurrent(o) && o.import_batch_id !== batchId && (target !== 'period_balances' || o.balance_kind === kind));
    await loadGuards(ws, target, olds);
  }
  await flagRunsStale(ws, orgId);

  let committed = 0;
  let superseded = 0;
  for (const { row, rec, update } of planned) {
    const ref = orgRow(fs, orgId, target, String(rec.id));
    ws.set(ref, rec);
    syncCurrentGuard(ws, target, null, rec);
    auditRowChange(ws, ctx.rowStamp, target, 'insert', null, rec);
    if (target === 'bank_transactions') openBankCategoryHistory(ws, rec, ctx.uid);
    if (update) {
      supersedeRow(ws, ctx.rowStamp, {
        orgId, table: 'invoices', recordId: String(row.duplicate_of_id), replacementId: String(rec.id), batchId, actorId: ctx.uid,
      });
      updateRecord(ws, ctx.rowStamp, 'invoices', orgId, String(rec.id), { record_status: 'accepted' });
      superseded += 1;
    }
    statusEventInto(ws, { orgId, table: target, recordId: String(rec.id), event: 'accepted', batchId, actorId: ctx.uid });
    updateRow(ws, orgId, String(row.id), { status: 'committed', committed_table: target, committed_record_id: rec.id });
    committed += 1;
  }

  if (target === 'period_balances' || target === 'budget_lines') {
    const mine = planned.map((p) => p.rec);
    for (const old of olds) {
      // The same account's new line where the report has one; else the report's line for the month.
      const candidates = mine.filter((n) => n.period_id === old.period_id && (target !== 'period_balances' || n.balance_kind === old.balance_kind))
        .sort((a, b) => Number(b.account_id === old.account_id) - Number(a.account_id === old.account_id)
          || String(a.id).localeCompare(String(b.id)));
      supersedeRow(ws, ctx.rowStamp, {
        orgId, table: target, recordId: String(old.id), replacementId: str(candidates[0]?.id), batchId, actorId: ctx.uid,
      });
      superseded += 1;
    }
    // The old report has left the index; the new one takes its place in the same write.
    for (const rec of mine) {
      const cur = ws.peek(orgRow(fs, orgId, target, String(rec.id)));
      if (cur && cur.record_status === 'pending') updateRecord(ws, ctx.rowStamp, target, orgId, String(rec.id), { record_status: 'accepted' });
    }
  }

  for (const r of await batchRows(ws, orgId, batchId)) {
    if ((r.reviewer_decision === 'skip' || r.status === 'duplicate' || r.status === 'error') && r.status !== 'committed') {
      updateRow(ws, orgId, String(r.id), { status: 'skipped' });
    }
  }

  const org = await ws.get(globalRow(fs, 'organizations', orgId));
  const total = (await batchRows(ws, orgId, batchId)).length;
  const finalPatch: Data = {
    status: 'committed', committed_at: nowIso(), reviewed_by: ctx.actorId,
    row_counts: { committed, superseded, total },
    fiscal_year_start_month_at_commit: org ? Number(org.fiscal_year_start_month) : null,
  };
  // `invoice_list_kind_at_commit`: an invoice list committed without an answer is a full list.
  if (target === 'invoices' && (batch.invoice_list_kind ?? null) === null) {
    finalPatch.invoice_list_kind = 'IMP-INV-012' in ((batch.confirmations as Data | null) ?? {}) ? 'open_items' : 'full';
  }
  batch = updateBatch(ws, orgId, batchId, finalPatch);
  if (target === 'bank_transactions' && !batch.bank_account_id) {
    raise.conflict('new row for relation "import_batches" violates check constraint "import_batches_bank_target_needs_account"');
  }
  if (target === 'period_balances' && !batch.balance_basis) {
    raise.conflict('new row for relation "import_batches" violates check constraint "import_batches_basis_required_for_balances"');
  }

  auditInto(ws, orgId, ctx.stamp, {
    action: 'import.committed', targetTable: 'import_batches', targetId: batchId,
    after: { committed, superseded, assurance, method },
  });

  return {
    result: { status: 'committed', committed, superseded, job: null },
    finalize: { recalc: [{ trigger: 'import_commit', refId: batchId }], requestedBy: ctx.uid, notifyBatchId: batchId, jobOnBatchId: batchId },
  };
}

/** `notify_data_added`: everyone in the organisation hears that new data arrived. Reads, then writes. */
export async function prepareDataAdded(db: Db, tx: Transaction, batch: Data): Promise<{ write(tx: Transaction): void }> {
  const fs = db.fs;
  const orgId = String(batch.organization_id);
  const r = readerOf(tx);
  const org = await r.get(globalRow(fs, 'organizations', orgId));
  const slug = String(org.get('slug') ?? '');
  const [members, assignments] = await Promise.all([
    r.query(orgCollection(fs, orgId, 'organization_memberships').where('status', '==', 'active')),
    r.query(orgCollection(fs, orgId, 'organization_assignments').where('status', '==', 'active')),
  ]);
  const now = Date.now();
  const people = new Set<string>(members.docs.map((d) => String(d.get('user_id'))));
  for (const a of assignments.docs) {
    const starts = a.get('starts_at') as string | null | undefined;
    const ends = a.get('ends_at') as string | null | undefined;
    if (starts && new Date(starts).getTime() > now) continue;
    if (ends && new Date(ends).getTime() <= now) continue;
    people.add(String(a.get('employee_user_id')));
  }
  const what = String(batch.import_type).replace(/_/g, ' ');
  const writes: Array<{ write(tx: Transaction): void }> = [];
  for (const person of [...people].sort()) {
    const reviewer = await hasPermissionOf(fs, person, orgId, 'imports.review', r);
    writes.push(await prepareNotify(fs, {
      orgId, userId: person, actorId: str(batch.reviewed_by), permission: 'financials.view', kind: 'data_added',
      title: `New data added: ${what}`,
      body: `Covering ${batch.period_start ?? '?'} to ${batch.period_end ?? '?'}. Figures are recalculated shortly.`,
      href: reviewer ? `/app/${slug}/data/imports/${batch.id}` : `/app/${slug}/home`,
    }, r));
  }
  return { write: (t) => { for (const w of writes) w.write(t); } };
}

// ── app.promote_dependants ───────────────────────────────────────────────────────────────────────

export async function promoteDependants(ws: WorkingSet, ctx: ImportCtx, batchId: string): Promise<number> {
  const { orgId } = ctx;
  const fs = ws.fs;
  const source = (await batchRows(ws, orgId, batchId)).filter((r) => r.committed_record_id);
  const recordIds = source.map((r) => String(r.committed_record_id));
  const deps = (await recordsWhereIn(ws, orgId, 'import_rows', 'duplicate_of_id', recordIds,
    (d) => d.batch_id !== batchId && d.reviewer_decision === 'skip' && !!d.duplicate_of_id)).sort(byRowNumber);
  const depBatches = new Map<string, Data | null>();
  const batchIds = [...new Set(deps.map((d) => String(d.batch_id)))];
  const loaded = await ws.load(batchIds.map((id) => orgRow(fs, orgId, 'import_batches', id)));
  batchIds.forEach((id, i) => depBatches.set(id, loaded[i] ?? null));
  const live = deps.filter((d) => depBatches.get(String(d.batch_id))?.status === 'committed');

  let promoted = 0;
  const plans: Array<{ dep: Data; table: RecordTable; rec: Data }> = [];
  for (const dep of live) {
    if (dep.mapped_data === null || dep.mapped_data === undefined) {
      raise.conflict(`a row of batch ${dep.batch_id} depends on this batch and cannot be recovered; roll that batch back first`);
    }
    const depBatch = depBatches.get(String(dep.batch_id))!;
    const table = String(depBatch.target_table) as RecordTable;
    if (table !== 'bank_transactions' && table !== 'ledger_entries' && table !== 'invoices') continue;
    plans.push({ dep, table, rec: {} });
  }
  // Periods for every promoted row, then the records themselves.
  const dateCol = { ledger_entries: 'entry_date', bank_transactions: 'transaction_date', invoices: 'issue_date' } as const;
  const periods = await assignPeriods(ws, orgId, plans
    .map((p) => isoDate((p.dep.mapped_data as Data)[dateCol[p.table as keyof typeof dateCol]])).filter((d): d is string => !!d));
  for (const p of plans) {
    const depBatch = depBatches.get(String(p.dep.batch_id))!;
    p.rec = recordFromRow(p.table, p.dep, {
      orgId, batchId: String(p.dep.batch_id), documentId: str(depBatch.source_document_id),
      bankAccountId: str(depBatch.bank_account_id), assurance: batchRecordAssurance(depBatch), periods,
    }, newId(), { recordStatus: 'accepted', duplicateReviewed: false, promotedFrom: batchId });
    assertRecordComplete(p.table, p.rec);
  }
  for (const table of ['bank_transactions', 'ledger_entries', 'invoices'] as const) {
    const recs = plans.filter((p) => p.table === table).map((p) => p.rec);
    if (recs.length > 0) {
      await assertReferences(ws, orgId, table, recs);
      await loadGuards(ws, table, recs);
    }
  }
  if (plans.length > 0) await flagRunsStale(ws, orgId);
  for (const { dep, table, rec } of plans) {
    ws.set(orgRow(fs, orgId, table, String(rec.id)), rec);
    syncCurrentGuard(ws, table, null, rec);
    auditRowChange(ws, ctx.rowStamp, table, 'insert', null, rec);
    if (table === 'bank_transactions') openBankCategoryHistory(ws, rec, ctx.uid);
    statusEventInto(ws, { orgId, table, recordId: String(rec.id), event: 'accepted', batchId: String(dep.batch_id), actorId: ctx.uid });
    updateRow(ws, orgId, String(dep.id), {
      status: 'committed', committed_table: table, committed_record_id: rec.id, reviewer_decision: 'keep',
      reviewer_reason: `${dep.reviewer_reason ?? ''} (kept automatically when the batch it duplicated was rolled back)`,
    });
    promoted += 1;
  }
  return promoted;
}

// ── app.rollback_import_batch ────────────────────────────────────────────────────────────────────

export interface RollbackResultRow { rejected: number; promoted: number; restored: number }

export async function computeRollback(
  ws: WorkingSet, ctx: ImportCtx, batchId: string, reason: string | null,
): Promise<Outcome<RollbackResultRow>> {
  const { orgId } = ctx;
  const fs = ws.fs;
  const batch = await batchOf(ws, orgId, batchId);
  if (!batch) raise.notFound();
  if (batch.status !== 'committed') raise.conflict('only a committed batch can be rolled back');
  const table = String(batch.target_table) as RecordTable;

  // Step 1: dependants are promoted, not refused (ADR-047.9).
  const promoted = await promoteDependants(ws, ctx, batchId);

  // The supersession chain, read before anything changes (ADR-047.1).
  const col = orgCollection(fs, orgId, table);
  const mine = await ws.query(col, col.where('import_batch_id', '==', batchId), (d) => d.import_batch_id === batchId);
  const mineById = new Map(mine.map((m) => [String(m.id), m]));
  const olds = await recordsWhereIn(ws, orgId, table, 'superseded_by', [...mineById.keys()], () => true);
  const chain = olds.map((o) => ({ oldId: String(o.id), nextId: str(mineById.get(String(o.superseded_by))?.superseded_by) }));
  await loadGuards(ws, table, [...mine, ...olds.map((o) => ({ ...o, superseded_by: null }))]);
  await flagRunsStale(ws, orgId);

  // Step 2: this batch's records are soft-rejected FIRST, so they leave every partial index.
  let rejected = 0;
  for (const m of mine) {
    const cur = ws.peek(orgRow(fs, orgId, table, String(m.id)));
    if (!cur || cur.record_status !== 'accepted') continue;
    updateRecord(ws, ctx.rowStamp, table, orgId, String(m.id), { record_status: 'rejected', rejected_reason: reason ?? 'batch rolled back' });
    statusEventInto(ws, { orgId, table, recordId: String(m.id), event: 'rejected', batchId, actorId: ctx.uid });
    rejected += 1;
  }

  // Step 3: re-link, or restore, the predecessors.
  let restored = 0;
  for (const { oldId, nextId } of chain) {
    updateRecord(ws, ctx.rowStamp, table, orgId, oldId, { superseded_by: nextId });
    statusEventInto(ws, {
      orgId, table, recordId: oldId, event: nextId === null ? 'restored' : 'unsuperseded', relatedId: nextId, batchId, actorId: ctx.uid,
    });
    restored += 1;
  }

  for (const r of await batchRows(ws, orgId, batchId)) {
    if (r.status === 'committed') updateRow(ws, orgId, String(r.id), { status: 'rejected' });
  }
  updateBatch(ws, orgId, batchId, { status: 'rolled_back', rolled_back_at: nowIso(), rolled_back_reason: reason });
  auditInto(ws, orgId, ctx.stamp, {
    action: 'import.rolled_back', targetTable: 'import_batches', targetId: batchId,
    after: { reason, rejected, promoted, restored },
  });

  return {
    result: { rejected, promoted, restored },
    finalize: { recalc: [{ trigger: 'import_rollback', refId: batchId }], requestedBy: ctx.uid, notifyBatchId: null, jobOnBatchId: null },
  };
}
