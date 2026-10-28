import 'server-only';
import { sanitiseFilename } from '@/core/storage/filenames';
import { raise } from '../raise';
import { arg, type DbFunctions } from '../registry';
import { globalRow, newId, nowIso, orgCollection, orgRow, uniqueGuard } from '../schema';
import { runTx } from '../tx';
import type { Db } from '../types';
import { hasPermissionOf } from '../app/access';
import { requireServer } from '../app/scope';
import { throttle } from '../app/throttle';
import { aiTokensUsedThisMonth, effectiveQuota } from '../app/ai-quota';
import { chunks, txLoader, WorkingSet, type Data } from '../app/imports-ws';
import { auditInto, auditStampOf, money, str, isRecordTable, type AuditStamp } from '../app/imports-records';
import {
  DOCUMENT_KINDS, REVIEWER_DECISIONS, ROW_STATUSES, BATCH_STATUSES, commitImportBatch, enumOf, enumOrNull, hexOf, orgOfRow,
} from '../app/imports-shared';

/**
 * `api_server.*` functions of the import area (ADR-043; IMPORT_ENGINE.md §5.4, §7): what the server
 * OBSERVED about a file — the upload handshake (`register_document` → the object is written →
 * `finalize_upload`), the rows the parser produced, the validation verdict, a failure, the AI
 * reading's page accounting — and the queued large commit. None of them is reachable from a
 * browser: every one starts with `requireServer`, and the human actor is passed explicitly and
 * re-checked (`hasPermissionOf`), so a forged request cannot name one.
 */

const PRE_COMMIT = ['created', 'parsing', 'mapping', 'validating', 'awaiting_review'];

/** The row and the organisation-scope guard of every server write here. */
async function requireActorPermission(db: Db, actorId: string | null, orgId: string, perm: 'imports.create' | 'imports.review', sentence: string) {
  if (!actorId || !(await hasPermissionOf(db.fs, actorId, orgId, perm))) raise.denied(sentence);
}

async function aiReadingEnabled(db: Db, orgId: string): Promise<void> {
  const org = (await globalRow(db.fs, 'organizations', orgId).get()).data();
  const flag = (org?.features as Data | undefined)?.ai_pdf_extraction;
  if (!(flag === true || flag === 'true')) {
    raise.denied('AI reading of documents is not enabled for this organisation');
  }
}


/** Removes a batch's rows: inside the transaction when there are few, after it otherwise. */
async function deleteRows(db: Db, orgId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const writer = db.fs.bulkWriter();
  for (const id of ids) void writer.delete(orgRow(db.fs, orgId, 'import_rows', id));
  await writer.close();
}

/** The stamp of an audit row the SQL inserted directly into `audit_events` as the consenting user. */
function consentStamp(actorId: string, scope: string | null): AuditStamp {
  return { orgScope: scope, actorId, actorType: 'user', requestId: null, ip: null, userAgent: null };
}

const EXTRACTION_STATS = (pages: number) => ({
  pages_total: pages, pages_extracted: [], pages_failed: [], pages_deferred: [], attempts: {},
  tokens_in: 0, tokens_out: 0, confidence: {}, line_counts: {},
});

/** `begin_extraction` and `begin_receipt_extraction` share their write. */
async function beginReading(
  db: Db, orgId: string, batchId: string, documentId: string, actorId: string, stats: Data, auditMeta: Data,
  check: (batch: Data, doc: Data | null, account: Data | null) => void, accountId: string | null,
): Promise<string> {
  const leftover = await runTx(db, async (tx) => {
    const ws = new WorkingSet(db.fs, txLoader(tx));
    const ref = orgRow(db.fs, orgId, 'import_batches', batchId);
    const batch = await ws.get(ref);
    const doc = await ws.get(orgRow(db.fs, orgId, 'source_documents', documentId));
    const account = accountId ? await ws.get(orgRow(db.fs, orgId, 'accounts', accountId)) : null;
    if (!batch || batch.source_document_id !== documentId) raise.notFound();
    check(batch, doc && !doc.deleted_at ? doc : null, account);
    const rcol = orgCollection(db.fs, orgId, 'import_rows');
    const rows = await ws.query(rcol, rcol.where('batch_id', '==', batchId), (d) => d.batch_id === batchId);
    const now = nowIso();
    ws.update(ref, {
      extraction_method: 'pdf_claude', status: 'parsing', error_summary: null, pages_extracted: 0, pages_failed: [],
      extraction_stats: stats, updated_at: now,
    });
    const inline = rows.length <= 2000;
    if (inline) for (const r of rows) ws.delete(orgRow(db.fs, orgId, 'import_rows', String(r.id)));
    // F-A-15, CD-35: what is about to be sent to the provider, with the consenting reviewer as actor.
    auditInto(ws, orgId, consentStamp(actorId, db.actor.kind === 'service' ? db.actor.scope : null), {
      action: 'document.sent_to_ai', targetTable: 'source_documents', targetId: documentId, metadata: auditMeta,
    });
    ws.apply(tx);
    return inline ? [] : rows.map((r) => String(r.id));
  });
  await deleteRows(db, orgId, leftover);
  return batchId;
}

export const functions: DbFunctions = {
  async register_document(db, args) {
    requireServer(db);
    const actorId = arg.str(args, 'p_actor');
    const orgId = arg.req(args, 'p_org');
    const meta = arg.obj(args, 'p_meta');
    const requestId = arg.str(args, 'p_request_id');
    if (!actorId) raise.invalid('an actor is required');
    await requireActorPermission(db, actorId, orgId, 'imports.create', 'imports.create required');

    const id = newId();
    const filename = str(meta.original_filename) ?? 'upload';
    // The storage path is ours to construct, not the file's: the signer's own rule, not a twin of it.
    const safe = sanitiseFilename(filename);
    const path = `${orgId}/${id}/${safe}`;
    const sha = hexOf(meta.sha256, 'sha256');
    if (sha === null) raise.invalid('null value in column "sha256" of relation "source_documents" violates not-null constraint');
    const byteSize = arg.num(meta, 'byte_size');
    if (byteSize === null) raise.invalid('null value in column "byte_size" of relation "source_documents" violates not-null constraint');
    if (byteSize <= 0) raise.conflict('new row for relation "source_documents" violates check constraint "source_documents_size_positive"');
    const kind = enumOf(DOCUMENT_KINDS, meta.document_kind ?? 'unknown', 'document_kind_enum');
    const hasText = meta.has_text_layer === undefined || meta.has_text_layer === null ? null : meta.has_text_layer === true || meta.has_text_layer === 'true';
    const pages = arg.num(meta, 'page_count');
    const stamp = await auditStampOf(db, actorId, requestId);

    return runTx(db, async (tx) => {
      const ws = new WorkingSet(db.fs, txLoader(tx));
      // CD-12: the same bytes twice is a file-level duplicate, reported with the earlier id.
      const guard = uniqueGuard(db.fs, { orgId }, 'source_documents_sha_unique', [sha]).ref;
      const held = await ws.get(guard);
      if (held?.owner_id) {
        const prior = await ws.get(orgRow(db.fs, orgId, 'source_documents', String(held.owner_id)));
        if (prior && !prior.deleted_at) {
          raise.conflict(`this file has already been uploaded (${held.owner_id})`, { existingId: held.owner_id });
        }
      }
      const now = nowIso();
      ws.set(orgRow(db.fs, orgId, 'source_documents', id), {
        id, organization_id: orgId, storage_bucket: 'source-documents', storage_path: path, original_filename: filename,
        mime_type: str(meta.mime_type) ?? 'application/octet-stream', byte_size: byteSize, sha256: sha,
        document_kind: kind, page_count: pages === null ? null : Math.trunc(pages), has_text_layer: hasText,
        extracted_text_path: null, status: 'uploaded', scan_result: {}, uploaded_by: actorId, deleted_at: null,
        created_at: now, updated_at: now,
      });
      ws.set(guard, { owner_id: id, constraint: 'source_documents_sha_unique', created_at: now });
      auditInto(ws, orgId, stamp, {
        action: 'document.uploaded', targetTable: 'source_documents', targetId: id,
        after: { filename: safe, kind: str(meta.document_kind) },
      });
      ws.apply(tx);
      return id;
    });
  },

  async finalize_upload(db, args) {
    requireServer(db);
    const actorId = arg.str(args, 'p_actor');
    const orgId = arg.req(args, 'p_org');
    const documentId = arg.req(args, 'p_document');
    const byteSize = arg.num(args, 'p_byte_size');
    const scan = args.p_scan_result ?? null;
    const status = enumOf(['uploaded', 'scanning', 'ready', 'unreadable', 'quarantined', 'deleted'], arg.req(args, 'p_status'), 'document_status_enum');
    await requireActorPermission(db, actorId, orgId, 'imports.create', 'imports.create required');
    if (!['ready', 'quarantined', 'unreadable'].includes(status)) {
      raise.invalid('finalize_upload sets ready, quarantined or unreadable only');
    }
    const stamp = await auditStampOf(db, actorId, arg.str(args, 'p_request_id'));
    return runTx(db, async (tx) => {
      const ws = new WorkingSet(db.fs, txLoader(tx));
      const ref = orgRow(db.fs, orgId, 'source_documents', documentId);
      const doc = await ws.get(ref);
      if (!doc || doc.status !== 'uploaded') raise.notFound();
      if (Number(doc.byte_size) !== byteSize) raise.invalid('the stored object does not match the declared size');
      ws.update(ref, { status, scan_result: (scan as Data | null) ?? {}, updated_at: nowIso() });
      if (status === 'quarantined') {
        auditInto(ws, orgId, stamp, {
          action: 'document.quarantined', targetTable: 'source_documents', targetId: documentId, after: { scan },
        });
      }
      ws.apply(tx);
      return documentId;
    });
  },

  async write_import_rows(db, args) {
    requireServer(db);
    const actorId = arg.str(args, 'p_actor');
    const orgId = arg.req(args, 'p_org');
    const batchId = arg.req(args, 'p_batch');
    const rows = arg.arr<Data>(args, 'p_rows') ?? [];
    const status = enumOf(BATCH_STATUSES, args.p_status ?? 'validating', 'import_batch_status_enum');
    await requireActorPermission(db, actorId, orgId, 'imports.create', 'imports.create required');

    const batchRef = orgRow(db.fs, orgId, 'import_batches', batchId);
    const batch = (await batchRef.get()).data();
    if (!batch || !PRE_COMMIT.includes(String(batch.status))) raise.notFound();

    // Each row as the insert would store it; a reference must be this organisation's (`same_org_ref`).
    const now = nowIso();
    const docs = rows.map((r) => {
      const dupTable = r.duplicate_of_table ?? null;
      const dupId = str(r.duplicate_of_id);
      if (dupTable === null && dupId !== null) {
        raise.invalid('import_rows.duplicate_of_id is set although import_rows.duplicate_of_table is null');
      }
      if (dupTable !== null && !isRecordTable(dupTable)) raise.invalid(`invalid input value for enum financial_record_table_enum: "${String(dupTable)}"`);
      if ((dupTable === null) !== (dupId === null)) {
        raise.conflict('new row for relation "import_rows" violates check constraint "import_rows_duplicate_pair"');
      }
      const rowNumber = arg.num(r, 'row_number');
      if (rowNumber === null) raise.invalid('null value in column "row_number" of relation "import_rows" violates not-null constraint');
      return {
        id: newId(), organization_id: orgId, batch_id: batchId, row_number: Math.trunc(rowNumber),
        source_ref: str(r.source_ref), raw_data: (r.raw_data as Data | null | undefined) ?? {},
        mapped_data: (r.mapped_data as Data | null | undefined) ?? null,
        status: enumOf(ROW_STATUSES, r.status ?? 'pending', 'import_row_status_enum'),
        issues: (r.issues as unknown[] | null | undefined) ?? [], dedupe_hash: hexOf(r.dedupe_hash, 'dedupe_hash'),
        duplicate_of_table: dupTable, duplicate_of_id: dupId,
        duplicate_within_batch_row_id: str(r.duplicate_within_batch_row_id),
        reviewer_decision: enumOrNull(REVIEWER_DECISIONS, r.reviewer_decision, 'reviewer_decision_enum') ?? 'none',
        reviewer_reason: str(r.reviewer_reason), committed_table: null, committed_record_id: null,
        created_at: now, updated_at: now, fixed_by: null, fixed_at: null,
        source_page: r.source_page === null || r.source_page === undefined ? null : Math.trunc(Number(r.source_page)),
      };
    });
    // `import_rows_batch_row_unique` (batch_id, row_number): this function is the only writer of a
    // batch's rows and replaces them wholesale, so the key is checked here rather than guarded.
    const existing = await orgCollection(db.fs, orgId, 'import_rows').where('batch_id', '==', batchId).get();
    const committedNumbers = new Set(existing.docs.filter((d) => d.get('status') === 'committed').map((d) => Number(d.get('row_number'))));
    const seen = new Set<number>();
    for (const d of docs) {
      if (seen.has(d.row_number) || committedNumbers.has(d.row_number)) {
        raise.conflict('duplicate key value violates unique constraint "import_rows_batch_row_unique"');
      }
      seen.add(d.row_number);
    }
    const refs = [...new Map(docs.filter((d) => d.duplicate_of_id).map((d) => [`${d.duplicate_of_table}/${d.duplicate_of_id}`, d])).values()];
    for (const c of chunks(refs, 300)) {
      const snaps = await db.fs.getAll(...c.map((d) => orgRow(db.fs, orgId, d.duplicate_of_table as never, String(d.duplicate_of_id))));
      if (snaps.some((s) => !s.exists)) raise.invalid('import_rows.duplicate_of_id references a row that does not exist');
    }
    const stale = existing.docs.filter((d) => d.get('status') !== 'committed').map((d) => d.ref);

    // Re-parsing replaces the previous rows wholesale; a committed batch's rows are never touched.
    // A small set is one transaction. A large one is written with bulkWriter while the batch is
    // still in its pre-review status, and the status flips afterwards in one transaction, so the
    // review never opens on a partial set (FIRESTORE_DATA_MODEL.md §7). A crash in between leaves
    // the batch where it was, and the parser's retry replaces the rows again.
    const flip = (tx: FirebaseFirestore.Transaction, b: Data | undefined) => {
      if (!b || !PRE_COMMIT.includes(String(b.status))) raise.notFound();
      tx.update(batchRef, { status, updated_at: nowIso() });
    };
    if (docs.length + stale.length <= 1500) {
      await runTx(db, async (tx) => {
        const b = (await tx.get(batchRef)).data();
        for (const ref of stale) tx.delete(ref);
        for (const d of docs) tx.set(orgRow(db.fs, orgId, 'import_rows', d.id), d);
        flip(tx, b);
      });
    } else {
      const writer = db.fs.bulkWriter();
      for (const ref of stale) void writer.delete(ref);
      for (const d of docs) void writer.set(orgRow(db.fs, orgId, 'import_rows', d.id), d);
      await writer.close();
      await runTx(db, async (tx) => flip(tx, (await tx.get(batchRef)).data()));
    }
    return docs.length;
  },

  async set_batch_validation(db, args) {
    requireServer(db);
    const actorId = arg.str(args, 'p_actor');
    const orgId = arg.req(args, 'p_org');
    const batchId = arg.req(args, 'p_batch');
    await requireActorPermission(db, actorId, orgId, 'imports.create', 'imports.create required');
    const issues = arg.arr(args, 'p_batch_issues') ?? [];
    const required = arg.arr<string>(args, 'p_required') ?? [];
    const counts = (args.p_row_counts as Data | null | undefined) ?? {};
    const statement = (args.p_statement as Data | null | undefined) ?? null;
    const stamp = await auditStampOf(db, actorId);
    return runTx(db, async (tx) => {
      const ws = new WorkingSet(db.fs, txLoader(tx));
      const ref = orgRow(db.fs, orgId, 'import_batches', batchId);
      const b = await ws.get(ref);
      if (!b) raise.notFound();
      // Deterministic or reviewer-typed balances only: an AI reading never reaches these (F-C-03).
      ws.update(ref, {
        batch_issues: issues, required_confirmations: required.map(String), row_counts: counts,
        statement_opening_balance: money(statement?.opening) ?? b.statement_opening_balance ?? null,
        statement_closing_balance: money(statement?.closing) ?? b.statement_closing_balance ?? null,
        status: 'awaiting_review',
        // Any reviewer holding a stale view must reload before acting (§16).
        review_token: newId(), updated_at: nowIso(),
      });
      auditInto(ws, orgId, stamp, {
        action: 'import.validated', targetTable: 'import_batches', targetId: batchId,
        after: { counts, issues: issues.length },
      });
      ws.apply(tx);
      return batchId;
    });
  },

  async fail_import_batch(db, args) {
    requireServer(db);
    const actorId = arg.str(args, 'p_actor');
    const orgId = arg.req(args, 'p_org');
    const batchId = arg.req(args, 'p_batch');
    const stage = arg.str(args, 'p_stage');
    const message = arg.str(args, 'p_message');
    const deferred = arg.bool(args, 'p_deferred') ?? false;
    const stamp = await auditStampOf(db, actorId);
    return runTx(db, async (tx) => {
      const ws = new WorkingSet(db.fs, txLoader(tx));
      const ref = orgRow(db.fs, orgId, 'import_batches', batchId);
      if (!(await ws.get(ref))) raise.notFound();
      ws.update(ref, { status: 'failed', error_summary: { stage, message, at: nowIso(), deferred }, updated_at: nowIso() });
      auditInto(ws, orgId, stamp, {
        action: 'import.failed', targetTable: 'import_batches', targetId: batchId, after: { stage, deferred },
      });
      ws.apply(tx);
      return batchId;
    });
  },

  async commit_batch_as(db, args) {
    requireServer(db);
    const actorId = arg.str(args, 'p_actor');
    const batchId = arg.str(args, 'p_batch');
    const found = await orgOfRow(db.fs, 'import_batches', batchId);
    if (!found) raise.notFound();
    if (!actorId || !(await hasPermissionOf(db.fs, actorId, found.orgId, 'imports.review'))) {
      raise.denied('the requester no longer has permission to import');
    }
    return commitImportBatch(db, found.orgId, batchId!, actorId);
  },

  async begin_extraction(db, args) {
    requireServer(db);
    const actorId = arg.str(args, 'p_actor');
    const orgId = arg.req(args, 'p_org');
    const batchId = arg.req(args, 'p_batch');
    const documentId = arg.req(args, 'p_document');
    const pages = Math.trunc(arg.num(args, 'p_pages_total') ?? 0);
    await requireActorPermission(db, actorId, orgId, 'imports.review', 'imports.review required');
    await aiReadingEnabled(db, orgId);
    return beginReading(db, orgId, batchId, documentId, actorId!, EXTRACTION_STATS(pages),
      { document_id: documentId, pages, batch_id: batchId },
      (batch, doc) => {
        // §5.4: only after the deterministic parse failed, and only for a document with a text layer.
        if (!(batch.status === 'failed' && batch.extraction_method === 'pdf_text')) {
          raise.conflict('AI reading is offered only for a PDF the deterministic parser could not read');
        }
        if (doc?.has_text_layer !== true) raise.conflict('this document has no text layer to read');
      }, null);
  },

  async begin_receipt_extraction(db, args) {
    requireServer(db);
    const actorId = arg.str(args, 'p_actor');
    const orgId = arg.req(args, 'p_org');
    const batchId = arg.req(args, 'p_batch');
    const documentId = arg.req(args, 'p_document');
    const pagesArg = arg.num(args, 'p_pages_total');
    const accountId = arg.str(args, 'p_account');
    await requireActorPermission(db, actorId, orgId, 'imports.review', 'imports.review required');
    await aiReadingEnabled(db, orgId);
    if (pagesArg === null || pagesArg < 1 || pagesArg > 10) raise.invalid('a receipt file is read whole, up to 10 pages');
    const pages = Math.trunc(pagesArg);
    return beginReading(db, orgId, batchId, documentId, actorId!,
      { ...EXTRACTION_STATS(pages), kind: 'receipts', receipt_account_id: accountId },
      { document_id: documentId, pages, batch_id: batchId, kind: 'receipts', file_sent: true, account: accountId },
      (batch, doc, account) => {
        if (batch.import_type !== 'receipts' || !(batch.status === 'failed' && batch.extraction_method === 'pdf_text')) {
          raise.conflict('only a Receipts upload waiting to be read can be read this way');
        }
        if (!doc || doc.status === 'quarantined' || doc.document_kind !== 'receipt') {
          raise.conflict('this document is not a receipt that can be read');
        }
        // The reviewer's account: this organisation's, active, and an expense.
        if (!account || account.is_active !== true || account.account_type !== 'expense') {
          raise.invalid("choose one of this organisation's expense accounts for the receipts");
        }
      }, accountId);
  },

  async charge_extraction_page(db, args) {
    requireServer(db);
    const actorId = arg.str(args, 'p_actor');
    const orgId = arg.req(args, 'p_org');
    const documentId = arg.req(args, 'p_document');
    await requireActorPermission(db, actorId, orgId, 'imports.review', 'imports.review required');
    await aiReadingEnabled(db, orgId);
    const doc = (await orgRow(db.fs, orgId, 'source_documents', documentId).get()).data();
    if (!doc || doc.deleted_at) raise.notFound();
    // ADR-033: the daily page budget is charged per model call, first attempts and retries alike.
    const pages = await effectiveQuota(db.fs, orgId, 'ai_extraction_pages_per_day');
    if (pages !== null) await throttle(db.fs, orgId, 'ai_extraction_page', pages, 86_400);
    const ceiling = await effectiveQuota(db.fs, orgId, 'ai_token_ceiling_monthly');
    if (ceiling !== null && (await aiTokensUsedThisMonth(db.fs, orgId)) >= ceiling) {
      raise.quota('this organisation has reached its monthly AI allowance');
    }
    return null;
  },

  async record_extraction_page(db, args) {
    requireServer(db);
    const orgId = arg.req(args, 'p_org');
    const batchId = arg.req(args, 'p_batch');
    const page = Math.trunc(arg.num(args, 'p_page') ?? NaN);
    const outcome = arg.str(args, 'p_outcome');
    if (outcome !== 'extracted' && outcome !== 'failed' && outcome !== 'deferred') {
      raise.invalid('a page attempt is extracted, failed or deferred');
    }
    const tokensIn = Math.trunc(arg.num(args, 'p_tokens_in') ?? 0);
    const tokensOut = Math.trunc(arg.num(args, 'p_tokens_out') ?? 0);
    const confidence = arg.str(args, 'p_confidence');
    const lineCount = arg.num(args, 'p_line_count');
    const error = arg.str(args, 'p_error');
    const balancesRead = (args.p_balances_read as Data | null | undefined) ?? null;
    await runTx(db, async (tx) => {
      const ref = orgRow(db.fs, orgId, 'import_batches', batchId);
      const snap = await tx.get(ref);
      const current = snap.exists ? (snap.get('extraction_stats') as Data | null | undefined) : null;
      if (!current) raise.notFound();
      const stats: Data = { ...current };
      const key = String(page);
      const attempts = { ...((stats.attempts as Data | undefined) ?? {}) };
      attempts[key] = Number(attempts[key] ?? 0) + 1;
      stats.attempts = attempts;
      stats.tokens_in = Number(stats.tokens_in ?? 0) + tokensIn;
      stats.tokens_out = Number(stats.tokens_out ?? 0) + tokensOut;
      if (lineCount !== null) stats.line_counts = { ...((stats.line_counts as Data | undefined) ?? {}), [key]: Math.trunc(lineCount) };
      // A page leaves the failed/deferred lists when it succeeds; the extracted list holds it once.
      const list = (name: string) => ((stats[name] as unknown[] | undefined) ?? []).filter((e) => Number(e) !== page);
      stats.pages_failed = list('pages_failed');
      stats.pages_deferred = list('pages_deferred');
      if (outcome === 'extracted') {
        const extracted = (stats.pages_extracted as unknown[] | undefined) ?? [];
        if (!extracted.some((e) => Number(e) === page)) stats.pages_extracted = [...extracted, page];
        if (confidence !== null) stats.confidence = { ...((stats.confidence as Data | undefined) ?? {}), [key]: confidence };
      } else if (outcome === 'failed') {
        stats.pages_failed = [...(stats.pages_failed as unknown[]), page];
      } else {
        stats.pages_deferred = [...(stats.pages_deferred as unknown[]), page];
      }
      if (error !== null) stats.errors = { ...((stats.errors as Data | undefined) ?? {}), [key]: [...error].slice(0, 300).join('') };
      // F-C-03: what the model READ as the balances is kept for the reviewer's line only.
      if (balancesRead !== null) stats.balances_read = { ...((stats.balances_read as Data | undefined) ?? {}), ...balancesRead };
      tx.update(ref, {
        extraction_stats: stats,
        pages_extracted: ((stats.pages_extracted as unknown[] | undefined) ?? []).length,
        pages_failed: ((stats.pages_failed as unknown[]) ?? []).map(Number).sort((a, b) => a - b),
        updated_at: nowIso(),
      });
    });
    return null;
  },

  async record_storage_cleanup(db, args) {
    requireServer(db);
    const orgId = arg.str(args, 'p_org');
    const jobId = arg.str(args, 'p_job');
    const bucket = arg.str(args, 'p_bucket');
    const examined = arg.num(args, 'p_examined');
    const removed = arg.num(args, 'p_removed');
    const failed = arg.num(args, 'p_failed');
    if (bucket !== 'source-documents' && bucket !== 'reports') raise.invalid('unknown bucket');
    if ((examined ?? -1) < 0 || (removed ?? -1) < 0 || (failed ?? -1) < 0) raise.invalid('counts cannot be negative');
    // A sweep that removed more than it looked at has miscounted: refuse, so the job fails loudly.
    if (removed! > examined!) raise.invalid('a sweep cannot remove more objects than it examined');
    // The organisation is NOT checked: the sweep after a purge records an organisation that is gone.
    // Counts only, no keys (ADR-038.9); the actor is the system.
    const stamp = await auditStampOf(db, null);
    return runTx(db, async (tx) => {
      const ws = new WorkingSet(db.fs, txLoader(tx));
      const id = auditInto(ws, orgId, stamp, {
        action: 'storage.orphans_removed', after: { bucket, examined, removed, failed }, metadata: { job_id: jobId },
      });
      ws.apply(tx);
      return id;
    });
  },
};
