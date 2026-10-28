import 'server-only';
import type { DocumentData, DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { Decimal } from '@/core/money/decimal';
import { raise } from '../raise';
import { arg, type DbFunctions } from '../registry';
import { newId, nowIso, orgCollection, orgRow, uniqueGuard } from '../schema';
import { runTx } from '../tx';
import type { Db } from '../types';
import { prepareAudit } from './audit';
import { intOrNull, numericText, textOrNull } from './engine-evidence';
import { getAllChunked, jsonb, uuidOrNull } from './engine-writes';
import { prepareRowAudit } from './platform-row-audit';
import { requireScope, requireServer } from './scope';

/**
 * `api_server.apply_banking_pass` (Phase 13, ADR-101): the calculation run's plan of rule
 * categorisations, transfer pairs and recurring groups, applied with every condition the SQL
 * re-checked — a row a person decided (`category_source = 'user'`) is never touched, a transfer's
 * KIND is derived here from the two accounts and never taken from the plan, a group the detector no
 * longer finds is marked stopped rather than deleted.
 *
 * The SQL took the organisation's advisory lock and applied the whole plan in one transaction. A plan
 * can touch more rows than one Firestore transaction holds, so it is applied in transactions of a
 * bounded size, each RE-READING the rows it changes and re-checking the conditions inside the
 * transaction — so a person re-categorising a row concurrently either wins outright or is seen and
 * respected; it can never be overwritten. What is lost is all-or-nothing across the whole plan: a
 * crash part-way leaves the first part applied, which the next run's pass (computed from the rows as
 * they then are) completes. A plan that fails validation is refused before anything is written.
 *
 * Each `bank_transactions` update also does what its triggers did: `set_updated_at`, the
 * `audit_diff` row event (`db.bank_transactions.update`, whole row before and after), and
 * `app.write_category_history` (the open history row closed, a new one opened).
 */

type Row = Record<string, unknown>;

/** Categorisations per transaction: each is up to four writes (row, history close and open, audit). */
const PER_TX = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const txnRef = (fs: Firestore, orgId: string, id: string): DocumentReference => orgRow(fs, orgId, 'bank_transactions', id);

/** Accepted and current, or nothing — the SQL's `where record_status = 'accepted' and superseded_by is null`. */
function live(snap: FirebaseFirestore.DocumentSnapshot): DocumentData | null {
  if (!snap.exists) return null;
  const d = snap.data()!;
  return d.record_status === 'accepted' && (d.superseded_by ?? null) === null ? d : null;
}

/** The open category_history rows of these transactions (read inside the transaction). */
async function openHistory(fs: Firestore, orgId: string, tx: Transaction, txnIds: readonly string[]): Promise<Map<string, DocumentReference[]>> {
  const out = new Map<string, DocumentReference[]>();
  for (const slice of chunks([...new Set(txnIds)], 30)) {
    const snap = await tx.get(orgCollection(fs, orgId, 'category_history').where('bank_transaction_id', 'in', slice));
    for (const d of snap.docs) {
      if (d.get('valid_to') !== null && d.get('valid_to') !== undefined) continue;
      const id = String(d.get('bank_transaction_id'));
      out.set(id, [...(out.get(id) ?? []), d.ref]);
    }
  }
  return out;
}

interface Change {
  readonly before: DocumentData;
  readonly after: DocumentData;
  /** Set when the change goes through `app.write_category_history`. */
  readonly history?: { category: string | null; isTransfer: boolean; kind: string; source: string };
}

/**
 * Writes a set of bank-transaction updates with their triggers' effects. All reads (the open history
 * rows, the audit's actor type) happen here before the first write.
 */
async function writeChanges(db: Db, orgId: string, tx: Transaction, changes: readonly Change[]): Promise<void> {
  const fs = db.fs;
  const history = await openHistory(fs, orgId, tx, changes.filter((c) => c.history).map((c) => String(c.after.id)));
  const audits = await Promise.all(changes.map((c) => prepareRowAudit(db, 'bank_transactions', 'update', c.before, c.after, tx)));
  const now = nowIso();
  changes.forEach((c, i) => {
    const id = String(c.after.id);
    tx.set(txnRef(fs, orgId, id), c.after);
    if (c.history) {
      for (const ref of history.get(id) ?? []) tx.update(ref, { valid_to: now });
      // A transaction updated twice in one pass gets one history row per update, as the SQL did.
      const hid = newId();
      tx.set(orgRow(fs, orgId, 'category_history', hid), {
        id: hid, organization_id: orgId, bank_transaction_id: id, category_account_id: c.history.category,
        is_transfer: c.history.isTransfer, transfer_kind: c.history.kind, source: c.history.source,
        valid_from: now, valid_to: null, changed_by: null, created_at: now,
      });
      history.set(id, [orgRow(fs, orgId, 'category_history', hid)]);
    }
    audits[i]!.write(tx);
  });
}

function transferKind(outType: string | null, inType: string | null): string {
  // ADR-028, the same derivation as api.mark_transfer: only cash-like ↔ cash-like cancels out of cash.
  const cashLike = (t: string | null) => t === 'current' || t === 'savings';
  if (cashLike(outType) && cashLike(inType)) return 'cash_transfer';
  if (outType === 'credit_card' || inType === 'credit_card') return 'card_repayment';
  if (outType === 'loan' || inType === 'loan') return 'loan_repayment';
  return 'other_transfer';
}

const GROUP_FIELDS = [
  'cadence', 'expected_amount', 'amount_tolerance_ratio', 'first_seen', 'last_seen', 'occurrence_count',
  'next_expected', 'status', 'detector_version',
] as const;

async function applyBankingPass(db: Db, args: Record<string, unknown>): Promise<unknown> {
  requireServer(db);
  const orgId = arg.req(args, 'p_org');
  requireScope(db, orgId);
  const fs = db.fs;
  const runId = uuidOrNull(args.p_run);
  const plan = arg.obj(args, 'p_plan');
  if (runId && !(await orgRow(fs, orgId, 'calculation_runs', runId).get()).exists) raise.notFound();

  const categorisations = (Array.isArray(plan.categorisations) ? plan.categorisations : []) as Row[];
  const pairs = (Array.isArray(plan.pairs) ? plan.pairs : []) as Row[];
  const groups = (Array.isArray(plan.groups) ? plan.groups : []) as Row[];

  // The SQL raised on the first row it would have written with a source other than rule/none, and
  // rolled the whole pass back. Checked up front, so a refused plan writes nothing.
  {
    const ids = categorisations.map((c) => uuidOrNull(c.transactionId)).filter((id): id is string => !!id);
    const snaps = await getAllChunked(fs, ids.map((id) => txnRef(fs, orgId, id)));
    const rows = new Map(snaps.map((s) => [s.id, live(s)]));
    for (const c of categorisations) {
      const row = rows.get(String(uuidOrNull(c.transactionId)));
      if (!row || row.category_source === 'user') continue;
      if (c.categorySource !== 'rule' && c.categorySource !== 'none') {
        raise.invalid('a pass may only write rule or none');
      }
    }
  }

  let categorised = 0;
  let paired = 0;
  let groupCount = 0;
  let membersSet = 0;
  let stopped = 0;

  // ---- Categories: only rows a person has not decided, only when something differs. ----------
  for (const slice of chunks(categorisations, PER_TX)) {
    categorised += await runTx(db, async (tx) => {
      const ids = slice.map((c) => uuidOrNull(c.transactionId));
      const txns = await getAllChunked(fs, ids.filter((id): id is string => !!id).map((id) => txnRef(fs, orgId, id)), tx);
      const byId = new Map(txns.map((s) => [s.id, live(s)]));
      const accountIds = slice.map((c) => uuidOrNull(c.categoryAccountId)).filter((id): id is string => !!id);
      const accounts = await getAllChunked(fs, [...new Set(accountIds)].map((id) => orgRow(fs, orgId, 'accounts', id)), tx);
      const accountExists = new Set(accounts.filter((a) => a.exists).map((a) => a.id));

      const working = new Map<string, DocumentData>();
      const changes: Change[] = [];
      const now = nowIso();
      for (const c of slice) {
        const id = uuidOrNull(c.transactionId);
        const row = id ? (working.get(id) ?? byId.get(id) ?? null) : null;
        if (!row || row.category_source === 'user') continue;
        const category = uuidOrNull(c.categoryAccountId);
        const source = String(c.categorySource);
        // An account this organisation does not have is not written, whatever the plan says.
        if (category !== null && !accountExists.has(category)) continue;
        if ((row.category_account_id ?? null) === category && row.category_source === source) continue;
        const after = { ...row, category_account_id: category, category_source: source, updated_at: now };
        changes.push({ before: row, after, history: { category, isTransfer: Boolean(row.is_transfer), kind: String(row.transfer_kind), source } });
        working.set(id!, after);
      }
      // One write per document: a transaction categorised twice keeps its last state; history and
      // audit are per change, as before.
      await writeChanges(db, orgId, tx, collapse(changes));
      return changes.length;
    });
  }

  // ---- Transfers: both legs unpaired, neither decided by a person; the KIND is derived here. ----
  for (const c of pairs) {
    paired += await runTx(db, async (tx) => {
      const outId = uuidOrNull(c.outflowTransactionId);
      const inId = uuidOrNull(c.inflowTransactionId);
      if (!outId || !inId) return 0;
      const [outSnap, inSnap] = await tx.getAll(txnRef(fs, orgId, outId), txnRef(fs, orgId, inId));
      const out = live(outSnap!);
      const inn = live(inSnap!);
      if (!out || !inn) return 0;
      const outAmount = new Decimal(String(out.amount));
      const inAmount = new Decimal(String(inn.amount));
      if (out.id === inn.id || out.is_transfer || inn.is_transfer
        || out.category_source === 'user' || inn.category_source === 'user'
        || out.bank_account_id === inn.bank_account_id
        || outAmount.gte(0) || inAmount.lte(0) || !outAmount.neg().eq(inAmount)) {
        return 0;
      }
      const [outBank, inBank] = await tx.getAll(
        orgRow(fs, orgId, 'bank_accounts', String(out.bank_account_id)), orgRow(fs, orgId, 'bank_accounts', String(inn.bank_account_id)),
      );
      const kind = transferKind(outBank!.exists ? String(outBank!.get('account_type')) : null, inBank!.exists ? String(inBank!.get('account_type')) : null);
      const category = kind === 'card_repayment' ? 'credit_card' : kind === 'loan_repayment' ? 'loan' : 'transfer';
      // Lowest id wins, the ladder's own tie-break, so the choice is the same on every run.
      const candidates = await tx.get(orgCollection(fs, orgId, 'accounts').where('standard_category', '==', category));
      const account = candidates.docs.map((d) => d.id).sort()[0] ?? null;

      const now = nowIso();
      const leg = (row: DocumentData, partner: string): Change => {
        const after = {
          ...row, transfer_pair_id: partner, transfer_kind: kind, is_transfer: true,
          category_account_id: account ?? row.category_account_id ?? null,
          category_source: account === null ? row.category_source : 'rule', updated_at: now,
        };
        return {
          before: row, after,
          history: { category: account ?? (row.category_account_id ?? null), isTransfer: true, kind, source: 'rule' },
        };
      };
      await writeChanges(db, orgId, tx, [leg(out, inn.id as string), leg(inn, out.id as string)]);
      return 1;
    });
  }

  // ---- Recurring groups: upsert on the stable key; members follow; the rest are stopped. -------
  const touched = new Set<string>();
  for (const c of groups) {
    const bankAccountId = uuidOrNull(c.bankAccountId);
    if (!bankAccountId || !(await orgRow(fs, orgId, 'bank_accounts', bankAccountId).get()).exists) continue;
    const counterpartyKey = textOrNull(c.counterpartyKey);
    const direction = textOrNull(c.direction);
    const values: Row = {
      cadence: textOrNull(c.cadence),
      expected_amount: numericText(c.expectedAmount, 2),
      amount_tolerance_ratio: numericText(c.amountToleranceRatio, 6),
      first_seen: textOrNull(c.firstSeen),
      last_seen: textOrNull(c.lastSeen),
      occurrence_count: intOrNull(c.occurrenceCount),
      next_expected: textOrNull(c.nextExpected),
      status: textOrNull(c.status),
      detector_version: textOrNull(c.detectorVersion),
    };
    const guard = uniqueGuard(fs, { orgId }, 'recurring_groups_identity_unique', [bankAccountId, counterpartyKey, direction]);
    const groupId = await runTx(db, async (tx) => {
      const claim = await guard.read(tx);
      const existing = claim.owner ? await tx.get(orgRow(fs, orgId, 'recurring_payment_groups', claim.owner)) : null;
      const now = nowIso();
      if (existing?.exists) {
        const row = existing.data()!;
        const changed = GROUP_FIELDS.some((f) => (row[f] ?? null) !== (values[f] ?? null));
        if (changed) tx.update(existing.ref, { ...values, updated_at: now });
        return existing.id;
      }
      const id = newId();
      claim.take(tx, id);
      tx.set(orgRow(fs, orgId, 'recurring_payment_groups', id), {
        id, organization_id: orgId, bank_account_id: bankAccountId, counterparty_key: counterpartyKey, direction,
        ...values, created_at: now, updated_at: now,
      });
      return id;
    });
    touched.add(groupId);
    groupCount += 1;

    const members = new Set(((Array.isArray(c.transactionIds) ? c.transactionIds : []) as unknown[]).map((x) => uuidOrNull(x)!));
    // Members joining (any row of the organisation named, as the SQL's `id = any(...)`), then leaving.
    for (const slice of chunks([...members], PER_TX)) {
      membersSet += await runTx(db, async (tx) => {
        const snaps = await getAllChunked(fs, slice.map((id) => txnRef(fs, orgId, id)), tx);
        const changes = snaps.filter((s) => s.exists && (s.get('recurring_group_id') ?? null) !== groupId)
          .map((s) => ({ before: s.data()!, after: { ...s.data()!, recurring_group_id: groupId, updated_at: nowIso() } }));
        await writeChanges(db, orgId, tx, changes);
        return changes.length;
      });
    }
    const current = await orgCollection(fs, orgId, 'bank_transactions').where('recurring_group_id', '==', groupId).select().get();
    const leaving = current.docs.map((d) => d.id).filter((id) => !members.has(id));
    for (const slice of chunks(leaving, PER_TX)) {
      await runTx(db, async (tx) => {
        const snaps = await getAllChunked(fs, slice.map((id) => txnRef(fs, orgId, id)), tx);
        const changes = snaps.filter((s) => s.exists && s.get('recurring_group_id') === groupId)
          .map((s) => ({ before: s.data()!, after: { ...s.data()!, recurring_group_id: null, updated_at: nowIso() } }));
        await writeChanges(db, orgId, tx, changes);
      });
    }
  }

  // A group the detector no longer finds is not deleted — alerts and evidence may cite it — it is
  // marked stopped, which is what a reader should be told about it.
  const live_ = await orgCollection(fs, orgId, 'recurring_payment_groups').where('status', '!=', 'stopped').select().get();
  const toStop = live_.docs.map((d) => d.id).filter((id) => !touched.has(id));
  for (const slice of chunks(toStop, 400)) {
    stopped += await runTx(db, async (tx) => {
      const snaps = await getAllChunked(fs, slice.map((id) => orgRow(fs, orgId, 'recurring_payment_groups', id)), tx);
      const now = nowIso();
      let n = 0;
      for (const s of snaps) {
        if (!s.exists || s.get('status') === 'stopped') continue;
        tx.update(s.ref, { status: 'stopped', updated_at: now });
        n += 1;
      }
      return n;
    });
  }

  const counts = { categorised, paired, groups: groupCount, members_set: membersSet, stopped };
  await runTx(db, async (tx) => {
    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'banking.pass_applied', targetTable: 'calculation_runs', targetId: runId,
      before: null, after: counts, metadata: { versions: jsonb(plan.versions ?? null) },
    }, tx);
    audit.write(tx);
  });
  return counts;
}

/**
 * Several changes to one transaction within one batch become one document write: the first
 * `before`, the last `after`. A history row is kept for the last change (the earlier rows would have
 * been opened and closed within the same instant).
 */
function collapse(changes: readonly Change[]): Change[] {
  const byId = new Map<string, Change>();
  for (const c of changes) {
    const id = String(c.after.id);
    const prior = byId.get(id);
    byId.set(id, prior ? { before: prior.before, after: c.after, history: c.history ?? prior.history } : c);
  }
  return [...byId.values()];
}

export const bankingFunctions: DbFunctions = {
  apply_banking_pass: applyBankingPass,
};
