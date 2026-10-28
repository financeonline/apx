import 'server-only';
import type { DocumentData } from 'firebase-admin/firestore';
import { arg, type DbFunctions } from '../registry';
import { raise } from '../raise';
import { newId, nowIso, orgCollection, orgRow, uniqueGuard, type OrgTable } from '../schema';
import { runTx } from '../tx';
import { readerOf, uidOf, type Db } from '../types';
import { requirePermission } from '../app/access';
import { prepareAudit } from '../app/audit';
import { prepareRecalculation } from '../app/jobs';
import { standardCategoryAccountType, writeRecordStatusEvent, type StandardCategory } from '../app/shared';
import {
  BANK_ACCOUNT_TYPES, COUNTERPARTY_KINDS, FINANCIAL_RECORD_TABLES, STANDARD_CATEGORY_VALUES,
  boolValue, btrim, charLength, checkViolation, dateValue, decimalOf, enumValue, has, locateOrNotFound,
  nonEmpty, prepareFlagRunsStale, prepareName, prepareRowAudit, readOrganization, readRow, rpcThrottle,
  scaled, textOf, uuidValue,
} from '../app/financials-helpers';

/**
 * `api.*` functions of the Financials area, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8):
 * bank accounts, the chart of accounts, counterparties, opening balances and corrections.
 *
 * Each keeps its SQL original's checks, sentences and side effects, and does what the tables'
 * triggers did (§4) itself: `set_updated_at`, the `audit_diff` row events, `derive_normalized_name`
 * with its unique key, `superseded_at_set`, `flag_runs_stale` and the recalculation request, all in
 * the function's one transaction (`pg_advisory_xact_lock` is Firestore's transaction contention).
 */

type Row = DocumentData;

/** `api.create_bank_account(p_org, p_input)` → the new id. */
async function create_bank_account(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db);
  const orgId = arg.str(args, 'p_org');
  await requirePermission(db, orgId, 'financials.edit');
  const input = arg.obj(args, 'p_input');
  const name = btrim(textOf(input, 'name') ?? '');
  const bankName = btrim(textOf(input, 'bank_name') ?? '');
  if (name === '' || bankName === '') raise.invalid('a name and bank name are required');
  const org = orgId!;

  return runTx(db, async (tx) => {
    const organization = await readOrganization(db.fs, org, readerOf(tx));
    const accountType = textOf(input, 'account_type') === null
      ? 'current' : enumValue(BANK_ACCOUNT_TYPES, textOf(input, 'account_type'), 'bank_account_type_enum');
    const ledger = uuidValue(textOf(input, 'ledger_account_id'));
    if (ledger && !(await tx.get(orgRow(db.fs, org, 'accounts', ledger))).exists) {
      raise.invalid('bank_accounts references a row that does not exist');
    }
    if (charLength(name) > 200) checkViolation('bank_accounts', 'bank_accounts_name_len');
    const accountNumber = textOf(input, 'account_number_masked');
    const sortCode = textOf(input, 'sort_code_masked');
    const id = newId();
    // ADR-029.4: a second account with the same masked identity is refused, and the UI offers the
    // existing one. Two rows for one real account would double every cash figure. NULLs are
    // distinct in the SQL key, so an account without both masked parts holds no guard.
    const identity = sortCode !== null && accountNumber !== null
      ? await uniqueGuard(db.fs, { orgId: org }, 'bank_identity_unique', [bankName, sortCode, accountNumber]).read(tx)
      : null;
    if (identity?.owner) raise.conflict('an account with those details already exists', { existingId: identity.owner });

    const now = nowIso();
    const row = {
      id, organization_id: org, name, bank_name: bankName,
      account_number_masked: accountNumber, sort_code_masked: sortCode,
      currency: nonEmpty(textOf(input, 'currency')) ?? (organization.base_currency as string | null) ?? 'GBP',
      account_type: accountType, ledger_account_id: ledger, opening_balance: null, opening_balance_date: null,
      is_active: true, created_at: now, updated_at: now,
    };
    const rowAudit = await prepareRowAudit(db, 'bank_accounts', 'insert', null, row, tx);
    const event = await prepareAudit(db, {
      organizationId: org, action: 'bank_account.created', targetTable: 'bank_accounts', targetId: id, after: input,
    }, tx);

    tx.set(orgRow(db.fs, org, 'bank_accounts', id), row);
    identity?.take(tx, id, 'an account with those details already exists');
    rowAudit.write(tx);
    event.write(tx);
    return id;
  });
}

/** `api.merge_counterparties(p_from, p_into)` → p_into. A pointer, never a delete. */
async function merge_counterparties(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db);
  const fromId = arg.str(args, 'p_from');
  const intoId = arg.str(args, 'p_into');
  const [from, into] = await Promise.all([
    locateOrNotFound(db.fs, 'counterparties', fromId),
    locateOrNotFound(db.fs, 'counterparties', intoId),
  ]);
  if (from.orgId !== into.orgId) raise.notFound();
  const org = from.orgId;
  await requirePermission(db, org, 'customers.edit');
  if (fromId === intoId) raise.invalid('a counterparty cannot be merged into itself');

  return runTx(db, async (tx) => {
    const row = await readRow(tx, db.fs, org, 'counterparties', fromId!);
    // Merging is a pointer, not a delete: every invoice and transaction keeps naming the row it was
    // imported against, and the engine follows merged_into_id. Deleting would break the evidence trail.
    if (row.merged_into_id !== null && row.merged_into_id !== undefined) {
      raise.conflict('that counterparty is already merged');
    }
    const stale = await prepareFlagRunsStale(db.fs, tx, org);
    const event = await prepareAudit(db, {
      organizationId: org, action: 'counterparty.merged', targetTable: 'counterparties', targetId: fromId,
      after: { merged_into: intoId },
    }, tx);
    const recalc = await prepareRecalculation(db.fs, org, 'counterparty_merged', fromId, uidOf(db), tx);

    tx.update(orgRow(db.fs, org, 'counterparties', fromId!), { merged_into_id: intoId, is_active: false, updated_at: nowIso() });
    stale.write(tx);
    event.write(tx);
    recalc.write(tx);
    return intoId!;
  });
}

/** `api.remap_account(p_account, p_category)` → p_account (ADR-034). */
async function remap_account(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db);
  const accountId = arg.str(args, 'p_account');
  const category = enumValue(STANDARD_CATEGORY_VALUES, arg.str(args, 'p_category'), 'standard_category_enum');
  const found = await locateOrNotFound(db.fs, 'accounts', accountId);
  const org = found.orgId;
  await requirePermission(db, org, 'financials.edit');

  return runTx(db, async (tx) => {
    const before = await readRow(tx, db.fs, org, 'accounts', accountId!);
    // A seeded account IS its category (ADR-004). Re-categorising one would leave the organization
    // without a target for that category and silently strand every metric that reads it.
    if (before.is_system === true) raise.invalid('a system account cannot be re-categorised');
    if (before.standard_category === category) return accountId!;

    // ADR-034: close the old history row and open a new one, so a descriptor resolved as-of an
    // earlier run still sees the category that produced those numbers.
    const open = await tx.get(orgCollection(db.fs, org, 'account_category_history')
      .where('account_id', '==', accountId).where('valid_to', '==', null));
    const now = nowIso();
    const after = {
      ...before, standard_category: category,
      account_type: standardCategoryAccountType(category as StandardCategory),
      mapping_confidence: 'confirmed', updated_at: now,
    };
    const rowAudit = await prepareRowAudit(db, 'accounts', 'update', before, after, tx);
    const event = await prepareAudit(db, {
      organizationId: org, action: 'account.remapped', targetTable: 'accounts', targetId: accountId,
      before: { standard_category: before.standard_category }, after: { standard_category: category },
    }, tx);
    // A remap changes every metric that reads this account, so the recalculation is not optional.
    const recalc = await prepareRecalculation(db.fs, org, 'account_remapped', accountId, uidOf(db), tx);

    for (const d of open.docs) tx.update(d.ref, { valid_to: now });
    tx.update(orgRow(db.fs, org, 'accounts', accountId!), {
      standard_category: after.standard_category, account_type: after.account_type,
      mapping_confidence: 'confirmed', updated_at: now,
    });
    const historyId = newId();
    tx.set(orgRow(db.fs, org, 'account_category_history', historyId), {
      id: historyId, organization_id: org, account_id: accountId, standard_category: category,
      valid_from: now, valid_to: null, changed_by: uidOf(db), created_at: now,
    });
    rowAudit.write(tx);
    event.write(tx);
    recalc.write(tx);
    return accountId!;
  });
}

/** `api.set_account_loan_security(p_account, p_security)` → p_security (ADR-156). */
async function set_account_loan_security(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db);
  const accountId = arg.str(args, 'p_account');
  const security = arg.str(args, 'p_security');
  const found = await locateOrNotFound(db.fs, 'accounts', accountId);
  const org = found.orgId;
  await requirePermission(db, org, 'financials.edit');
  if (security === null || !['secured', 'unsecured', 'unmarked'].includes(security)) {
    raise.invalid('a loan is secured, unsecured or unmarked');
  }

  return runTx(db, async (tx) => {
    const before = await readRow(tx, db.fs, org, 'accounts', accountId!);
    if (before.standard_category !== 'loan' && before.standard_category !== 'long_term_liability') {
      raise.invalid('only a loan or long-term borrowing account can be marked secured or unsecured');
    }
    const value = security === 'unmarked' ? null : security;
    const previous = (before.loan_security as string | null | undefined) ?? null;
    if (previous === value) return security;

    const now = nowIso();
    const rowAudit = await prepareRowAudit(db, 'accounts', 'update', before, { ...before, loan_security: value, updated_at: now }, tx);
    const event = await prepareAudit(db, {
      organizationId: org, action: 'account.loan_security_changed', targetTable: 'accounts', targetId: accountId,
      before: { loan_security: previous ?? 'unmarked' }, after: { loan_security: security },
    }, tx);
    const recalc = await prepareRecalculation(db.fs, org, 'account_remapped', accountId, uidOf(db), tx);

    tx.update(orgRow(db.fs, org, 'accounts', accountId!), { loan_security: value, updated_at: now });
    rowAudit.write(tx);
    event.write(tx);
    recalc.write(tx);
    return security;
  });
}

/** `api.set_opening_balance(p_account, p_amount, p_date)` → p_account (a bank account). */
async function set_opening_balance(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db);
  const accountId = arg.str(args, 'p_account');
  const found = await locateOrNotFound(db.fs, 'bank_accounts', accountId);
  const org = found.orgId;
  await requirePermission(db, org, 'financials.edit');
  const amount = decimalOf(args.p_amount);
  const date = dateValue(args.p_date);
  if ((amount === null) !== (date === null)) raise.invalid('an opening balance needs both an amount and a date');
  const stored = amount === null ? null : scaled(amount, 2);

  return runTx(db, async (tx) => {
    const before = await readRow(tx, db.fs, org, 'bank_accounts', accountId!);
    const now = nowIso();
    const after = { ...before, opening_balance: stored, opening_balance_date: date, updated_at: now };
    const rowAudit = await prepareRowAudit(db, 'bank_accounts', 'update', before, after, tx);
    const event = await prepareAudit(db, {
      organizationId: org, action: 'bank_account.opening_balance_set', targetTable: 'bank_accounts', targetId: accountId,
      before, after: { opening_balance: amount === null ? null : amount.toString(), opening_balance_date: date },
    }, tx);
    // An opening balance moves every cash figure from that date forward.
    const recalc = await prepareRecalculation(db.fs, org, 'banking_edit', accountId, uidOf(db), tx);

    tx.update(orgRow(db.fs, org, 'bank_accounts', accountId!), { opening_balance: stored, opening_balance_date: date, updated_at: now });
    rowAudit.write(tx);
    event.write(tx);
    recalc.write(tx);
    return accountId!;
  });
}

/**
 * `api.set_opening_balance_flag(p_entry, p_flag)` → how many lines changed: the flag applies to
 * every line of the entry's journal (ADR-047.4, IMP-GL-011).
 */
async function set_opening_balance_flag(db: Db, args: Record<string, unknown>): Promise<number> {
  await rpcThrottle(db);
  const entryId = arg.str(args, 'p_entry');
  const flag = boolValue(args.p_flag);
  const found = await locateOrNotFound(db.fs, 'ledger_entries', entryId);
  const org = found.orgId;
  await requirePermission(db, org, 'financials.edit');

  return runTx(db, async (tx) => {
    const entry = await readRow(tx, db.fs, org, 'ledger_entries', entryId!);
    const journal = (entry.journal_ref as string | null | undefined) ?? null;
    const rows = new Map<string, Row>([[entryId!, entry]]);
    if (journal !== null) {
      const lines = await tx.get(orgCollection(db.fs, org, 'ledger_entries').where('journal_ref', '==', journal));
      for (const d of lines.docs) rows.set(d.id, d.data());
    }
    const now = nowIso();
    const rowAudits = await Promise.all([...rows.values()].map((r) => prepareRowAudit(
      db, 'ledger_entries', 'update', r, { ...r, is_opening_balance: flag, updated_at: now }, tx,
    )));
    const event = await prepareAudit(db, {
      organizationId: org, action: 'ledger.opening_flag_changed', targetTable: 'ledger_entries', targetId: entryId,
      after: { is_opening_balance: flag, lines: rows.size },
    }, tx);
    const recalc = await prepareRecalculation(db.fs, org, 'import_commit', entryId, uidOf(db), tx);

    for (const id of rows.keys()) tx.update(orgRow(db.fs, org, 'ledger_entries', id), { is_opening_balance: flag, updated_at: now });
    for (const a of rowAudits) a.write(tx);
    event.write(tx);
    recalc.write(tx);
    return rows.size;
  });
}

/**
 * `api.supersede_record(p_table, p_record, p_replacement)` → p_replacement. There is no in-place
 * amendment (ADR-026.6): the old row points at its replacement (`app.supersede_row`, with
 * `superseded_at_set`), a `record_status_events` row records it (whose insert flagged running
 * calculations stale), and the figures are recalculated.
 */
async function supersede_record(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db);
  const table = enumValue(FINANCIAL_RECORD_TABLES, arg.str(args, 'p_table'), 'financial_record_table_enum') as OrgTable;
  const recordId = arg.str(args, 'p_record');
  const replacementId = arg.str(args, 'p_replacement');
  const found = await locateOrNotFound(db.fs, table, recordId);
  const org = found.orgId;
  await requirePermission(db, org, 'financials.edit');
  if (!replacementId || !(await orgRow(db.fs, org, table, replacementId).get()).exists) raise.notFound();

  return runTx(db, async (tx) => {
    const snap = await tx.get(orgRow(db.fs, org, table, recordId!));
    const before = snap.exists ? snap.data()! : null;
    if (!before || (before.superseded_by !== null && before.superseded_by !== undefined)) {
      raise.conflict('that record is already superseded or does not exist');
    }
    const now = nowIso();
    const after = { ...before, superseded_by: replacementId, superseded_at: now, updated_at: now };
    const rowAudit = await prepareRowAudit(db, table, 'update', before, after, tx);
    const stale = await prepareFlagRunsStale(db.fs, tx, org);
    const event = await prepareAudit(db, {
      organizationId: org, action: 'record.superseded', targetTable: table, targetId: recordId,
      after: { replacement: replacementId },
    }, tx);
    const recalc = await prepareRecalculation(db.fs, org, 'record_superseded', recordId, uidOf(db), tx);

    tx.update(orgRow(db.fs, org, table, recordId!), { superseded_by: replacementId, superseded_at: now, updated_at: now });
    writeRecordStatusEvent(tx, db.fs, {
      orgId: org, table, recordId: recordId!, event: 'superseded', actorId: uidOf(db), relatedId: replacementId, batchId: null,
    });
    rowAudit.write(tx);
    stale.write(tx);
    event.write(tx);
    recalc.write(tx);
    return replacementId;
  });
}

/**
 * `api.update_counterparty(p_counterparty, p_patch)` → the id. An allow-list, not a merge: a patch
 * can never move `organization_id`, the normalised name uniqueness depends on, or the merge pointer.
 *
 * The SQL's UPDATE always set `name` (to itself when the patch has none), so the
 * `derive_normalized_name` trigger fired on every save: the normalised name is re-derived each time,
 * which is how a held name is taken back by the last record left of its group (ADR-136).
 */
async function update_counterparty(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db);
  const id = arg.str(args, 'p_counterparty');
  const found = await locateOrNotFound(db.fs, 'counterparties', id);
  const org = found.orgId;
  await requirePermission(db, org, 'customers.edit');
  const patch = arg.obj(args, 'p_patch');

  return runTx(db, async (tx) => {
    const before = await readRow(tx, db.fs, org, 'counterparties', id!);
    const name = textOf(patch, 'name') ?? String(before.name);
    if (charLength(name) < 1 || charLength(name) > 300) checkViolation('counterparties', 'counterparties_name_len');
    const kind = textOf(patch, 'kind') === null ? before.kind : enumValue(COUNTERPARTY_KINDS, textOf(patch, 'kind'), 'counterparty_kind_enum');
    const defaultCategory = has(patch, 'default_expense_category')
      ? (textOf(patch, 'default_expense_category') === null
        ? null : enumValue(STANDARD_CATEGORY_VALUES, textOf(patch, 'default_expense_category'), 'standard_category_enum'))
      : (before.default_expense_category ?? null);
    const named = await prepareName(db.fs, tx, {
      orgId: org, table: 'counterparties', constraint: 'counterparties_org_normalized_unique', rowId: id!, name,
      previousNormalized: (before.normalized_name as string | null | undefined) ?? null,
      conflictMessage: `duplicate key value violates unique constraint "counterparties_org_normalized_unique"`,
    });
    const event = await prepareAudit(db, {
      organizationId: org, action: 'counterparty.updated', targetTable: 'counterparties', targetId: id, before, after: patch,
    }, tx);

    tx.update(orgRow(db.fs, org, 'counterparties', id!), {
      name,
      kind,
      default_expense_category: defaultCategory,
      email: textOf(patch, 'email') ?? before.email ?? null,
      notes: has(patch, 'notes') ? textOf(patch, 'notes') : (before.notes ?? null),
      is_active: boolValue(patch.is_active) ?? before.is_active,
      normalized_name: named.normalized,
      updated_at: nowIso(),
    });
    named.write(tx);
    event.write(tx);
    return id!;
  });
}

export const functions: DbFunctions = {
  create_bank_account,
  merge_counterparties,
  remap_account,
  set_account_loan_security,
  set_opening_balance,
  set_opening_balance_flag,
  supersede_record,
  update_counterparty,
};
