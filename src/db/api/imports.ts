import 'server-only';
import { raise } from '../raise';
import { arg, type DbFunctions } from '../registry';
import { globalRow, newId, nowIso, orgCollection, orgRow, uniqueGuard } from '../schema';
import { runTx } from '../tx';
import { uidOf, type Db } from '../types';
import { requirePermission } from '../app/access';
import { prepareRecalculation } from '../app/jobs';
import { normalizeName, STANDARD_CATEGORIES, standardCategoryAccountType, type StandardCategory } from '../app/shared';
import { throttle } from '../app/throttle';
import { txLoader, WorkingSet, chunks, type Data } from '../app/imports-ws';
import {
  auditInto, auditRowChange, auditStampOf, importLockRef, isCurrent, money, openAccountCategoryHistory, str, triggerStamp,
} from '../app/imports-records';
import { batchRows, computeCommit, computeRollback, type CommitResultRow, type RollbackResultRow } from '../app/imports-commit';
import { runImportOperation } from '../app/imports-exec';
import {
  BALANCE_BASES, BALANCE_SIGNS, EXTRACTION_METHODS, IMPORT_TYPES, INVOICE_LIST_KINDS, REVIEWER_DECISIONS,
  commitImportBatch, enumOf, enumOrNull, importCtx, importTargetOf, orgOfRow,
} from '../app/imports-shared';

/**
 * `api.*` functions of the import area (IMPORT_ENGINE.md; FIRESTORE_DATA_MODEL.md §8): the import
 * wizard's batch lifecycle, the reviewer's decisions, commit, rollback and replacement, and the
 * document library's delete. Each keeps its SQL name, `p_` arguments, result, checks and refusal
 * sentences. Commit, rollback and replacement are in src/db/app/imports-commit.ts (the statements)
 * and src/db/app/imports-exec.ts (one transaction, or a resumable plan for a very large batch).
 */

const rpcThrottle = (db: Db, limit = 120) => throttle(db.fs, uidOf(db), 'rpc', limit, 60);

/** The batch, its organisation, and the caller's role there with `perm` — or NotFound. */
async function batchFor(db: Db, batchId: string | null, perm: 'imports.review' | 'imports.create' = 'imports.review') {
  const found = await orgOfRow(db.fs, 'import_batches', batchId);
  if (!found) raise.notFound();
  const role = await requirePermission(db, found.orgId, perm);
  return { orgId: found.orgId, batch: found.row, role };
}

const IN_PREPARATION = ['created', 'parsing', 'mapping', 'validating', 'awaiting_review'];
const OPEN_FOR_REVIEW = ['mapping', 'validating', 'awaiting_review'];

/** Reads the organisation's import lock inside a transaction: refused while a large commit is applying. */
async function readLock(db: Db, orgId: string, tx: FirebaseFirestore.Transaction) {
  const ref = importLockRef(db.fs, orgId);
  const lock = (await tx.get(ref)).data();
  if (lock?.holder_batch_id) {
    raise.conflict('another import in this organisation is still being committed; try again when it has finished');
  }
  return { touch: (t: FirebaseFirestore.Transaction) => t.set(ref, { ...(lock ?? {}), holder_batch_id: null, holder_op: null, touched_at: nowIso() }) };
}

/** Runs a small read-modify-write over a working set in one transaction, with the caller's audit stamp. */
async function inTx<T>(db: Db, fn: (ws: WorkingSet, tx: FirebaseFirestore.Transaction) => Promise<T>): Promise<T> {
  return runTx(db, async (tx) => {
    const ws = new WorkingSet(db.fs, txLoader(tx));
    const out = await fn(ws, tx);
    ws.apply(tx);
    return out;
  });
}

const AMOUNT_PATTERNS: readonly RegExp[] = [
  /[£$€¥₹₽₩₪₦₺฿¢¤]\s?[0-9]/u,
  /[0-9]\s?[£$€¥₹₽₩₪₦₺฿¢¤]/u,
  /[0-9]\s?(%|per\s?cent)(?!\p{L})/iu,
  /[0-9]{1,3}(,[0-9]{3})+/u,
];

export const functions: DbFunctions = {
  async start_import_batch(db, args) {
    await rpcThrottle(db);
    const documentId = arg.str(args, 'p_document');
    const importType = enumOf(IMPORT_TYPES, arg.req(args, 'p_import_type'), 'import_type_enum');
    const opts = arg.obj(args, 'p_opts');
    const found = await orgOfRow(db.fs, 'source_documents', documentId, (d) => d.deleted_at === null || d.deleted_at === undefined);
    if (!found) raise.notFound();
    const orgId = found.orgId;
    await requirePermission(db, orgId, 'imports.create');

    const method = enumOf(EXTRACTION_METHODS, opts.extraction_method ?? 'csv', 'extraction_method_enum');
    const target = importTargetOf(importType);
    const basis = enumOrNull(BALANCE_BASES, opts.balance_basis, 'balance_basis_enum');

    return runTx(db, async (tx) => {
      const docSnap = await tx.get(orgRow(db.fs, orgId, 'source_documents', documentId!));
      const doc = docSnap.data();
      if (!doc || doc.deleted_at) raise.notFound();
      const active = await tx.get(orgCollection(db.fs, orgId, 'import_batches').where('source_document_id', '==', documentId));
      const org = (await tx.get(globalRow(db.fs, 'organizations', orgId))).data();
      const bankId = str(opts.bank_account_id);
      const bank = bankId ? await tx.get(orgRow(db.fs, orgId, 'bank_accounts', bankId)) : null;
      const stamp = await auditStampOf(db, null, null, { get: (r) => tx.get(r), query: (q) => tx.get(q) });

      if (doc.status !== 'ready') raise.conflict('this document is not ready to import');
      // One active batch per document: two wizards over one file would produce two sets of records.
      if (active.docs.some((d) => ['created', 'parsing', 'mapping', 'validating', 'awaiting_review', 'committing'].includes(String(d.get('status'))))) {
        raise.conflict('an import of this document is already in progress');
      }
      if (!['csv', 'xlsx', 'pdf_text', 'ocr'].includes(method)) {
        raise.invalid('an AI-read or manual batch is created by the server, not the wizard');
      }
      // ADR-175: `ocr` is one invoice read in the browser and checked by the reviewer — invoices only.
      if (method === 'ocr' && importType !== 'sales_invoices' && importType !== 'purchase_invoices') {
        raise.invalid('only a sales or purchase invoice is read on the upload page');
      }
      if (target === 'bank_transactions' && !bankId) raise.invalid('a bank statement import needs a bank account');
      if (bankId && !bank?.exists) raise.invalid('import_batches.bank_account_id references a row that does not exist');

      const now = new Date();
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
      const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      const periodStart = str(opts.period_start)?.slice(0, 10) ?? first;
      const periodEnd = str(opts.period_end)?.slice(0, 10) ?? last;
      if (periodEnd < periodStart) raise.conflict('new row for relation "import_batches" violates check constraint "import_batches_range"');
      const id = newId();
      const at = nowIso();
      tx.set(orgRow(db.fs, orgId, 'import_batches', id), {
        id, organization_id: orgId, source_document_id: documentId, import_type: importType, target_table: target,
        bank_account_id: bankId, mapping_id: null, mapping_snapshot: null, status: 'created', row_counts: {},
        period_start: periodStart, period_end: periodEnd, statement_opening_balance: null, statement_closing_balance: null,
        balance_sign: 'natural', fiscal_year_start_month_at_commit: org ? Number(org.fiscal_year_start_month) : null,
        invoice_list_kind: null, balance_basis: basis, extraction_method: method, pages_extracted: null, pages_failed: null,
        created_by: uidOf(db), reviewed_by: null, committed_at: null, rolled_back_at: null, rolled_back_reason: null,
        replaced_batch_id: null, error_summary: null, calculation_job_id: null, calculation_run_id: null,
        created_at: at, updated_at: at, batch_issues: [], confirmations: {}, required_confirmations: [],
        page_confirmations: {}, review_token: newId(), extraction_stats: {},
      });
      const ws = new WorkingSet(db.fs, txLoader(tx));
      auditInto(ws, orgId, stamp, {
        action: 'import.started', targetTable: 'import_batches', targetId: id,
        after: { import_type: importType, document: documentId, extraction_method: method },
      });
      ws.apply(tx);
      return id;
    });
  },

  async save_import_mapping(db, args) {
    await rpcThrottle(db);
    const batchId = arg.str(args, 'p_batch');
    const mapping = arg.obj(args, 'p_mapping');
    const { orgId, batch } = await batchFor(db, batchId);
    // ADR-027.1 / IMP-TB-012: a balance import must state cumulative or movement first.
    if (batch.target_table === 'period_balances' && (mapping.balance_basis ?? null) === null) {
      raise.invalid('a balance import needs its basis confirmed (cumulative or movement)');
    }
    const signature = str(mapping.header_signature);
    if (signature === null) raise.invalid('null value in column "header_signature" of relation "import_mappings" violates not-null constraint');
    const basis = enumOrNull(BALANCE_BASES, mapping.balance_basis, 'balance_basis_enum');
    const sign = enumOrNull(BALANCE_SIGNS, mapping.balance_sign, 'balance_sign_enum');
    const stamp = await auditStampOf(db, null);
    return inTx(db, async (ws) => {
      const guard = uniqueGuard(db.fs, { orgId }, 'import_mappings_signature_unique', [String(batch.import_type), signature]);
      const held = await ws.get(guard.ref);
      const current = await ws.get(orgRow(db.fs, orgId, 'import_batches', batchId!));
      if (!current) raise.notFound();
      const existingId = held ? str(held.owner_id) : null;
      const existing = existingId ? await ws.get(orgRow(db.fs, orgId, 'import_mappings', existingId)) : null;
      const now = nowIso();
      let mappingId: string;
      if (existing) {
        mappingId = String(existing.id);
        ws.update(orgRow(db.fs, orgId, 'import_mappings', mappingId), {
          column_map: (mapping.column_map as Data | undefined) ?? {}, transforms: (mapping.transforms as Data | undefined) ?? {},
          account_map: (mapping.account_map as Data | undefined) ?? {}, last_used_at: now, updated_at: now,
        });
      } else {
        mappingId = newId();
        ws.set(orgRow(db.fs, orgId, 'import_mappings', mappingId), {
          id: mappingId, organization_id: orgId, name: str(mapping.name) ?? 'Saved mapping', import_type: batch.import_type,
          header_signature: signature, column_map: (mapping.column_map as Data | undefined) ?? {},
          transforms: (mapping.transforms as Data | undefined) ?? {}, account_map: (mapping.account_map as Data | undefined) ?? {},
          created_by: uidOf(db), last_used_at: now, created_at: now, updated_at: now,
        });
        ws.set(guard.ref, { owner_id: mappingId, constraint: 'import_mappings_signature_unique', created_at: now });
      }
      ws.update(orgRow(db.fs, orgId, 'import_batches', batchId!), {
        mapping_id: mappingId, mapping_snapshot: mapping, balance_basis: basis ?? current.balance_basis ?? null,
        balance_sign: sign ?? current.balance_sign, status: current.status === 'created' ? 'mapping' : current.status,
        reviewed_by: uidOf(db), updated_at: now,
      });
      auditInto(ws, orgId, stamp, { action: 'import.mapped', targetTable: 'import_batches', targetId: batchId, after: { mapping: mappingId } });
      return mappingId;
    });
  },

  async create_import_accounts(db, args) {
    await rpcThrottle(db);
    const batchId = arg.str(args, 'p_batch');
    const accounts = (arg.arr<Data>(args, 'p_accounts') ?? []).filter((a) => a && typeof a === 'object');
    const { orgId, batch } = await batchFor(db, batchId);
    // Only while the batch is being prepared: new accounts for a committed batch would change its meaning.
    if (!IN_PREPARATION.includes(String(batch.status))) raise.conflict('this batch is not open for mapping');
    const stamp = await auditStampOf(db, null);
    const rowStamp = triggerStamp(db, stamp);
    return inTx(db, async (ws) => {
      const col = orgCollection(db.fs, orgId, 'accounts');
      // Load every account into the transaction's view: the matching below reads them from memory.
      await ws.query(col, col, () => true);
      const wanted = accounts.map((a) => {
        const name = (str(a.name) ?? '').trim();
        const code = (str(a.code) ?? '').trim() || null;
        const raw = str(a.standard_category);
        const category = (raw === null || raw === '' ? 'uncategorised' : enumOf(STANDARD_CATEGORIES, raw, 'standard_category_enum')) as StandardCategory;
        return { name, code, category, key: normalizeName(name) };
      }).filter((a) => a.name !== '');
      // Guards for every key a new account could claim, read before any write.
      const guardRefs = wanted.flatMap((a) => [
        uniqueGuard(db.fs, { orgId }, 'accounts_org_normalized_unique', [a.key]).ref,
        ...(a.code ? [uniqueGuard(db.fs, { orgId }, 'accounts_org_code_unique', [a.code]).ref] : []),
      ]);
      for (const c of chunks(guardRefs, 300)) await ws.load(c);

      let created = 0;
      for (const a of wanted) {
        const accountsNow = ws.inMemory(col, () => true);
        // `derive_normalized_name`: a name held for an identity decision is not available.
        const heldBy = accountsNow.find((t) => String(t.normalized_name ?? '').startsWith(`${a.key} [held `));
        if (heldBy) {
          raise.conflict(`"${a.name}" shares its name with "${heldBy.name}", and they await a decision about whether they are the same; rename or merge them first`);
        }
        const nameRef = uniqueGuard(db.fs, { orgId }, 'accounts_org_normalized_unique', [a.key]).ref;
        const codeRef = a.code ? uniqueGuard(db.fs, { orgId }, 'accounts_org_code_unique', [a.code]).ref : null;
        // `on conflict do nothing`: the name or the code is already an account's.
        if (ws.peek(nameRef) || (codeRef && ws.peek(codeRef))) continue;
        if (accountsNow.some((t) => t.normalized_name === a.key || (a.code && t.code === a.code))) continue;
        const id = newId();
        const now = nowIso();
        const row = {
          id, organization_id: orgId, code: a.code, name: a.name, normalized_name: a.key,
          account_type: standardCategoryAccountType(a.category), standard_category: a.category, is_system: false,
          is_active: true, source: 'imported', external_ref: null, mapping_confidence: 'unmapped',
          created_at: now, updated_at: now, loan_security: null,
        };
        ws.set(orgRow(db.fs, orgId, 'accounts', id), row);
        ws.set(nameRef, { owner_id: id, constraint: 'accounts_org_normalized_unique', created_at: now });
        if (codeRef) ws.set(codeRef, { owner_id: id, constraint: 'accounts_org_code_unique', created_at: now });
        auditRowChange(ws, rowStamp, 'accounts', 'insert', null, row);
        openAccountCategoryHistory(ws, row, uidOf(db));
        auditInto(ws, orgId, stamp, {
          action: 'account.created', targetTable: 'accounts', targetId: null,
          after: { name: a.name, code: a.code, standard_category: a.category }, metadata: { batch_id: batchId, source: 'import' },
        });
        created += 1;
      }
      return created;
    });
  },

  async create_import_counterparties(db, args) {
    await rpcThrottle(db);
    const batchId = arg.str(args, 'p_batch');
    const raw = args.p_names ?? [];
    const { orgId, batch } = await batchFor(db, batchId);
    if (!IN_PREPARATION.includes(String(batch.status))) raise.conflict('this batch is not open for mapping');
    if (batch.target_table !== 'invoices') raise.invalid('only an invoice list adds customers or suppliers');
    if (!Array.isArray(raw) || raw.length > 5000) raise.invalid('names must be a list of at most 5,000');
    const kind = batch.import_type === 'sales_invoices' || batch.import_type === 'sales_report' ? 'customer' : 'supplier';

    const names: string[] = [];
    for (const v of raw) {
      const name = v === null || v === undefined ? '' : String(v).trim();
      if (name === '' || [...name].length > 300 || normalizeName(name) === '') continue;
      if (AMOUNT_PATTERNS.some((p) => p.test(name))) raise.invalid('names cannot contain amounts');
      names.push(name);
    }
    const stamp = await auditStampOf(db, null);
    const meta = { batch_id: batchId, source: 'import' };
    let created = 0;
    // Each name is independent (`on conflict do nothing`), so a long list is written in parts.
    for (const part of chunks(names, 1000)) {
      created += await inTx(db, async (ws) => {
        const col = orgCollection(db.fs, orgId, 'counterparties');
        await ws.query(col, col, () => true);
        const keys = [...new Set(part.map((n) => normalizeName(n)))];
        for (const c of chunks(keys, 300)) {
          await ws.load(c.map((k) => uniqueGuard(db.fs, { orgId }, 'counterparties_org_normalized_unique', [k]).ref));
        }
        let made = 0;
        for (const name of part) {
          const key = normalizeName(name);
          const all = ws.inMemory(col, () => true);
          const heldBy = all.find((t) => (t.merged_into_id ?? null) === null && String(t.normalized_name ?? '').startsWith(`${key} [held `));
          if (heldBy) {
            raise.conflict(`"${name}" shares its name with "${heldBy.name}", and they await a decision about whether they are the same; rename or merge them first`);
          }
          const guardRef = uniqueGuard(db.fs, { orgId }, 'counterparties_org_normalized_unique', [key]).ref;
          const taken = ws.peek(guardRef) || all.some((t) => t.normalized_name === key);
          if (!taken) {
            const id = newId();
            const now = nowIso();
            ws.set(orgRow(db.fs, orgId, 'counterparties', id), {
              id, organization_id: orgId, name, normalized_name: key, kind, default_expense_category: null,
              external_ref: null, email: null, notes: null, is_active: true, merged_into_id: null, created_at: now, updated_at: now,
            });
            ws.set(guardRef, { owner_id: id, constraint: 'counterparties_org_normalized_unique', created_at: now });
            auditInto(ws, orgId, stamp, {
              action: 'counterparty.created', targetTable: 'counterparties', targetId: id, after: { name, kind }, metadata: meta,
            });
            made += 1;
            continue;
          }
          // Taken: one first seen on the other side of the business becomes `both`; a merged one stays.
          const existing = all.find((t) => t.normalized_name === key && (t.merged_into_id ?? null) === null);
          if (existing && existing.kind !== kind && existing.kind !== 'both') {
            const next = existing.kind === 'unknown' ? kind : 'both';
            ws.update(orgRow(db.fs, orgId, 'counterparties', String(existing.id)), { kind: next, updated_at: nowIso() });
            auditInto(ws, orgId, stamp, {
              action: 'counterparty.kind_changed', targetTable: 'counterparties', targetId: String(existing.id),
              before: { kind: existing.kind }, after: { kind: next }, metadata: meta,
            });
          }
        }
        return made;
      });
    }
    return created;
  },

  async decide_import_rows(db, args) {
    await rpcThrottle(db);
    const batchId = arg.str(args, 'p_batch');
    const decisions = (arg.arr<Data>(args, 'p_decisions') ?? []);
    const { orgId } = await batchFor(db, batchId);
    const stamp = await auditStampOf(db, null);
    return inTx(db, async (ws) => {
      const batch = await ws.get(orgRow(db.fs, orgId, 'import_batches', batchId!));
      if (!batch) raise.notFound();
      if (batch.status !== 'awaiting_review') raise.conflict('this batch is not awaiting review');
      const ids = decisions.map((d) => str(d?.row_id)).filter((x): x is string => !!x);
      for (const c of chunks([...new Set(ids)], 300)) await ws.load(c.map((id) => orgRow(db.fs, orgId, 'import_rows', id)));
      let count = 0;
      for (const d of decisions) {
        const rowId = str(d?.row_id);
        const decision = enumOf(REVIEWER_DECISIONS, d?.decision, 'reviewer_decision_enum');
        const reason = d?.reason === undefined || d?.reason === null ? null : String(d.reason);
        const ref = rowId ? orgRow(db.fs, orgId, 'import_rows', rowId) : null;
        const row = ref ? ws.peek(ref) : null;
        const inBatch = row && row.batch_id === batchId ? row : null;
        // A reason is mandatory when the reviewer overrides what validation concluded.
        if (decision === 'keep' && reason === null && inBatch?.status === 'duplicate') raise.invalid('keeping a duplicate needs a reason');
        if (decision === 'skip' && reason === null && inBatch?.status === 'valid') raise.invalid('skipping a valid row needs a reason');
        if (inBatch) ws.update(ref!, { reviewer_decision: decision, reviewer_reason: reason, updated_at: nowIso() });
        count += 1;
      }
      auditInto(ws, orgId, stamp, { action: 'import.row_decided', targetTable: 'import_batches', targetId: batchId, after: { rows: count } });
      return count;
    });
  },

  async record_batch_confirmation(db, args) {
    await rpcThrottle(db);
    const batchId = arg.str(args, 'p_batch');
    const code = arg.req(args, 'p_code');
    let value = arg.obj(args, 'p_value');
    const { orgId } = await batchFor(db, batchId);
    const stamp = await auditStampOf(db, null);
    return inTx(db, async (ws) => {
      const ref = orgRow(db.fs, orgId, 'import_batches', batchId!);
      const batch = await ws.get(ref);
      if (!batch) raise.notFound();
      if (!OPEN_FOR_REVIEW.includes(String(batch.status))) raise.conflict('this batch is not open for review');
      // A confirmation this batch does not call for is refused, never pre-recorded.
      if (!((batch.required_confirmations as string[] | null) ?? []).includes(code)) {
        raise.invalid(`${code} is not a confirmation this batch requires`);
      }
      if (code === 'IMP-TB-016' && !['complete', 'partial'].includes(String(value.report_complete ?? ''))) {
        raise.invalid('say whether the report lists every account (complete or partial)');
      }
      if (code === 'IMP-INV-013' && !['complete', 'partial'].includes(String(value.opening ?? ''))) {
        raise.invalid('say whether the list includes every invoice still unpaid at its start (complete or partial)');
      }
      // What a completeness answer covers is a fact of the report type, stored by the server.
      if (code === 'IMP-TB-016') {
        value = {
          ...value,
          scope: batch.import_type === 'trial_balance' ? 'all_accounts'
            : batch.import_type === 'balance_sheet' ? 'assets_and_liabilities' : 'income_and_expense',
        };
      }
      const uid = uidOf(db);
      const now = nowIso();
      const patch: Data = {
        confirmations: { ...((batch.confirmations as Data | null) ?? {}), [code]: { by: uid, at: now, value } },
        reviewed_by: uid, updated_at: now,
      };
      // The declared export range is SET here (ADR-047.6): coverage reads these two columns.
      if (code === 'IMP-RANGE-015') {
        if ((value.period_start ?? null) === null || (value.period_end ?? null) === null) {
          raise.invalid('confirming the export range needs both a start and an end');
        }
        patch.period_start = String(value.period_start).slice(0, 10);
        patch.period_end = String(value.period_end).slice(0, 10);
        if (String(patch.period_end) < String(patch.period_start)) {
          raise.conflict('new row for relation "import_batches" violates check constraint "import_batches_range"');
        }
      }
      if (code === 'IMP-TB-012') patch.balance_basis = enumOrNull(BALANCE_BASES, value.balance_basis, 'balance_basis_enum');
      if (code === 'IMP-TB-013') {
        const s = enumOrNull(BALANCE_SIGNS, value.balance_sign, 'balance_sign_enum');
        if (s === null) raise.invalid('null value in column "balance_sign" of relation "import_batches" violates not-null constraint');
        patch.balance_sign = s;
      }
      if (code === 'IMP-INV-012') patch.invoice_list_kind = enumOrNull(INVOICE_LIST_KINDS, value.invoice_list_kind, 'invoice_list_kind_enum');
      ws.update(ref, patch);
      auditInto(ws, orgId, stamp, { action: 'import.confirmed', targetTable: 'import_batches', targetId: batchId, after: { code, value } });
      return batchId;
    });
  },

  async set_statement_balances(db, args) {
    await rpcThrottle(db);
    const batchId = arg.str(args, 'p_batch');
    const opening = money(args.p_opening);
    const closing = money(args.p_closing);
    const { orgId } = await batchFor(db, batchId);
    const stamp = await auditStampOf(db, null);
    return inTx(db, async (ws) => {
      const ref = orgRow(db.fs, orgId, 'import_batches', batchId!);
      const batch = await ws.get(ref);
      if (!batch) raise.notFound();
      if (!OPEN_FOR_REVIEW.includes(String(batch.status))) raise.conflict('this batch is not open for review');
      ws.update(ref, { statement_opening_balance: opening, statement_closing_balance: closing, reviewed_by: uidOf(db), updated_at: nowIso() });
      auditInto(ws, orgId, stamp, {
        action: 'import.mapped', targetTable: 'import_batches', targetId: batchId,
        after: { opening, closing, reviewer_entered: true },
      });
      return batchId;
    });
  },

  async confirm_pdf_page(db, args) {
    await rpcThrottle(db);
    const batchId = arg.str(args, 'p_batch');
    const page = arg.num(args, 'p_page');
    const { orgId, batch } = await batchFor(db, batchId);
    if (batch.extraction_method !== 'pdf_claude') raise.invalid('page confirmation applies to AI-read documents only');
    const stamp = await auditStampOf(db, null);
    return inTx(db, async (ws) => {
      const ref = orgRow(db.fs, orgId, 'import_batches', batchId!);
      const current = await ws.get(ref);
      if (!current) raise.notFound();
      const uid = uidOf(db);
      const now = nowIso();
      ws.update(ref, {
        page_confirmations: { ...((current.page_confirmations as Data | null) ?? {}), [String(page)]: { by: uid, at: now } },
        reviewed_by: uid, updated_at: now,
      });
      auditInto(ws, orgId, stamp, { action: 'import.page_confirmed', targetTable: 'import_batches', targetId: batchId, after: { page } });
      return batchId;
    });
  },

  async reject_import_batch(db, args) {
    await rpcThrottle(db);
    const batchId = arg.str(args, 'p_batch');
    const reason = arg.str(args, 'p_reason');
    const { orgId } = await batchFor(db, batchId);
    const stamp = await auditStampOf(db, null);
    const rest = await inTx(db, async (ws, tx) => {
      const ref = orgRow(db.fs, orgId, 'import_batches', batchId!);
      const batch = await ws.get(ref);
      if (!batch) raise.notFound();
      // Pre-commit only: once records exist, undoing is a rollback.
      if (batch.status === 'committed') raise.conflict('a committed batch is rolled back, not rejected');
      const lock = (await tx.get(importLockRef(db.fs, orgId))).data();
      if (lock?.holder_batch_id === batchId) raise.conflict('this batch is still being committed; finish that first');
      ws.update(ref, { status: 'rejected', rolled_back_reason: reason, updated_at: nowIso() });
      const rows = (await batchRows(ws, orgId, batchId!)).filter((r) => r.status !== 'committed' && r.status !== 'rejected');
      const now = nowIso();
      const inline = rows.length <= 2000 ? rows : [];
      for (const r of inline) ws.update(orgRow(db.fs, orgId, 'import_rows', String(r.id)), { status: 'rejected', updated_at: now });
      auditInto(ws, orgId, stamp, { action: 'import.rejected', targetTable: 'import_batches', targetId: batchId, after: { reason } });
      return rows.length > 2000 ? rows.map((r) => String(r.id)) : [];
    });
    // A very large batch's rows follow the batch (it is already rejected, so retrying is safe).
    if (rest.length > 0) {
      const writer = db.fs.bulkWriter();
      const now = nowIso();
      for (const id of rest) void writer.update(orgRow(db.fs, orgId, 'import_rows', id), { status: 'rejected', updated_at: now });
      await writer.close();
    }
    return batchId;
  },

  async commit_import_batch(db, args) {
    await rpcThrottle(db);
    const batchId = arg.str(args, 'p_batch');
    const { orgId } = await batchFor(db, batchId);
    return commitImportBatch(db, orgId, batchId!, uidOf(db)) as Promise<CommitResultRow>;
  },

  async rollback_import_batch(db, args) {
    await rpcThrottle(db);
    const batchId = arg.str(args, 'p_batch');
    const reason = arg.str(args, 'p_reason');
    if ((reason ?? '').trim() === '') raise.invalid('a reason is required to roll back an import');
    const { orgId } = await batchFor(db, batchId);
    const ctx = await importCtx(db, orgId, uidOf(db));
    return runImportOperation<RollbackResultRow>(db, orgId, 'rollback', batchId!, (ws) => computeRollback(ws, ctx, batchId!, reason));
  },

  async replace_import_batch(db, args) {
    await rpcThrottle(db);
    const oldId = arg.str(args, 'p_old_batch');
    const newBatchId = arg.str(args, 'p_new_batch');
    const reason = arg.str(args, 'p_reason');
    if ((reason ?? '').trim() === '') raise.invalid('a reason is required to replace an import');
    const old = await orgOfRow(db.fs, 'import_batches', oldId);
    const fresh = await orgOfRow(db.fs, 'import_batches', newBatchId);
    if (!old || !fresh || fresh.orgId !== old.orgId) raise.notFound();
    const orgId = old.orgId;
    await requirePermission(db, orgId, 'imports.review');
    if (old.row.import_type !== fresh.row.import_type) raise.invalid('a batch can only be replaced by one of the same type');
    if (oldId === newBatchId) raise.invalid('a batch cannot replace itself');
    const ctx = await importCtx(db, orgId, uidOf(db));

    return runImportOperation(db, orgId, 'replace', newBatchId!, async (ws) => {
      const rolledBack = await computeRollback(ws, ctx, oldId!, reason);
      // The new file's rows that were duplicates only OF the old batch are valid again.
      const oldRecords = new Set((await batchRows(ws, orgId, oldId!)).map((r) => str(r.committed_record_id)).filter(Boolean));
      for (const r of await batchRows(ws, orgId, newBatchId!)) {
        if (r.status === 'duplicate' && r.duplicate_of_id && oldRecords.has(String(r.duplicate_of_id))) {
          ws.update(orgRow(db.fs, orgId, 'import_rows', String(r.id)), {
            status: 'valid', duplicate_of_table: null, duplicate_of_id: null, updated_at: nowIso(),
          });
        }
      }
      const committed = await computeCommit(ws, ctx, newBatchId!);
      // Both halves are one write, so a collision aborts the whole replacement.
      if (committed.result.status === 'conflict') {
        raise.conflict('the replacement file collides with data committed since it was checked');
      }
      ws.update(orgRow(db.fs, orgId, 'import_batches', newBatchId!), { replaced_batch_id: oldId, updated_at: nowIso() });
      auditInto(ws, orgId, ctx.stamp, {
        action: 'import.replaced', targetTable: 'import_batches', targetId: newBatchId,
        after: { replaced: oldId, reason, rollback: rolledBack.result, commit: committed.result },
      });
      return {
        result: { rolledBack: rolledBack.result, committed: committed.result },
        finalize: {
          recalc: [...(rolledBack.finalize?.recalc ?? []), ...(committed.finalize?.recalc ?? [])],
          requestedBy: ctx.uid,
          notifyBatchId: committed.finalize?.notifyBatchId ?? null,
          jobOnBatchId: committed.finalize?.jobOnBatchId ?? null,
        },
      };
    });
  },

  async attest_report_completeness(db, args) {
    await throttle(db.fs, uidOf(db), 'rpc', 60, 60);
    const batchId = arg.str(args, 'p_batch');
    const periodStart = arg.str(args, 'p_period_start')?.slice(0, 10) ?? null;
    const coverage = arg.str(args, 'p_coverage');
    const reason = arg.str(args, 'p_reason');
    const found = await orgOfRow(db.fs, 'import_batches', batchId);
    if (!found) raise.notFound();
    const { orgId, row: batch } = found;
    const role = await requirePermission(db, orgId, 'imports.review');
    if (role !== 'owner' && role !== 'admin') raise.denied('only an owner or admin can confirm what a report covers');
    const target = batch.target_table;
    const type = batch.import_type;
    // A trial balance, P&L or balance sheet (N-1), or a FULL invoice list (R-2).
    if (!((target === 'period_balances' && ['trial_balance', 'pnl_report', 'balance_sheet'].includes(String(type)))
      || (target === 'invoices' && (batch.invoice_list_kind ?? 'full') === 'full'))) {
      raise.invalid('only a trial balance, a P&L report, a balance sheet or a full invoice list has a completeness answer');
    }
    if (batch.status !== 'committed') {
      raise.invalid("confirm completeness on an imported report; answer the import's own question while reviewing it");
    }
    if (coverage !== 'complete' && coverage !== 'partial') raise.invalid('the answer must be complete or partial');
    if (reason === null || reason.trim().length === 0) raise.invalid('say what you checked in the report');
    const trimmed = reason.trim();
    if ([...trimmed].length > 2000) raise.conflict('new row for relation "report_completeness_attestations" violates check constraint "report_completeness_reason"');
    const stamp = await auditStampOf(db, null);

    return runTx(db, async (tx) => {
      // NF-5: the organisation lock commit and rollback hold — what we read is what was committed.
      const lock = await readLock(db, orgId, tx);
      const ws = new WorkingSet(db.fs, txLoader(tx));
      const confirmations = (batch.confirmations as Data | null) ?? {};
      const answer = target === 'invoices'
        ? str(((confirmations['IMP-INV-013'] as Data | undefined)?.value as Data | undefined)?.opening)
        : str(((confirmations['IMP-TB-016'] as Data | undefined)?.value as Data | undefined)?.report_complete);
      let lines: Data[] = [];
      if (target === 'period_balances') {
        const col = orgCollection(db.fs, orgId, 'period_balances');
        lines = await ws.query(col, col.where('import_batch_id', '==', batchId), (d) => d.import_batch_id === batchId && d.period_start === periodStart);
        if (lines.some((l) => (l.superseded_by ?? null) !== null) && !lines.some((l) => isCurrent(l))) {
          raise.conflict('this report was replaced by a newer one for that month; confirm the newer import instead');
        }
      }
      const monthOf = (d: string) => `${d.slice(0, 7)}-01`;
      if (periodStart === null || periodStart !== monthOf(periodStart)
        || (target === 'period_balances' && !lines.some((l) => isCurrent(l)))
        || (target === 'invoices' && periodStart !== monthOf(String(batch.period_start ?? '')))) {
        raise.invalid('this import does not state that month');
      }
      const acol = orgCollection(db.fs, orgId, 'report_completeness_attestations');
      const prior = (await ws.query(acol, acol.where('import_batch_id', '==', batchId),
        (d) => d.import_batch_id === batchId && d.period_start === periodStart))
        .sort((a, b) => String(b.attested_at).localeCompare(String(a.attested_at)) || String(b.id).localeCompare(String(a.id)))[0] ?? null;
      const previous = str(prior?.coverage) ?? (answer === 'complete' || answer === 'partial' ? answer : 'unconfirmed');
      const scope = target === 'invoices' ? 'open_invoices' : type === 'trial_balance' ? 'all_accounts'
        : type === 'balance_sheet' ? 'assets_and_liabilities' : 'income_and_expense';
      const recalc = await prepareRecalculation(db.fs, orgId, 'recalc_manual', batchId, uidOf(db), tx);
      const id = newId();
      ws.set(orgRow(db.fs, orgId, 'report_completeness_attestations', id), {
        id, organization_id: orgId, import_batch_id: batchId, period_start: periodStart, coverage, scope,
        origin: 'owner_review', reason: trimmed, attested_by: uidOf(db), attested_role: role, attested_at: nowIso(),
        supersedes_id: str(prior?.id),
      });
      auditInto(ws, orgId, stamp, {
        action: 'report.completeness_attested', targetTable: 'import_batches', targetId: batchId,
        before: { period_start: periodStart, coverage: previous, attestation_id: str(prior?.id) },
        after: { period_start: periodStart, coverage, scope, reason: trimmed, attestation_id: id, role },
      });
      ws.apply(tx);
      lock.touch(tx);
      recalc.write(tx);
      return id;
    });
  },

  async delete_document(db, args) {
    await rpcThrottle(db);
    const documentId = arg.str(args, 'p_document');
    const found = await orgOfRow(db.fs, 'source_documents', documentId, (d) => d.deleted_at === null || d.deleted_at === undefined);
    if (!found) raise.notFound();
    const { orgId } = found;
    await requirePermission(db, orgId, 'imports.review');
    const stamp = await auditStampOf(db, null);
    return inTx(db, async (ws) => {
      const ref = orgRow(db.fs, orgId, 'source_documents', documentId!);
      const doc = await ws.get(ref);
      if (!doc || doc.deleted_at) raise.notFound();
      const bcol = orgCollection(db.fs, orgId, 'import_batches');
      const batches = await ws.query(bcol, bcol.where('source_document_id', '==', documentId), (d) => d.source_document_id === documentId);
      const shaGuard = uniqueGuard(db.fs, { orgId }, 'source_documents_sha_unique', [str(doc.sha256)]).ref;
      const guard = await ws.get(shaGuard);
      // A quarantined file is evidence of an attempted upload and is kept.
      if (doc.status === 'quarantined') raise.conflict('a quarantined document cannot be deleted');
      if (batches.some((b) => b.status !== 'rejected' && b.status !== 'rolled_back')) {
        raise.conflict('this document is referenced by an import');
      }
      // The row is marked, not removed; the Storage signer then deletes the object (ADR-043.4).
      const now = nowIso();
      ws.update(ref, { status: 'deleted', deleted_at: now, updated_at: now });
      if (guard && guard.owner_id === documentId) ws.delete(shaGuard);
      auditInto(ws, orgId, stamp, { action: 'document.deleted', targetTable: 'source_documents', targetId: documentId });
      return str(doc.storage_path);
    });
  },
};
