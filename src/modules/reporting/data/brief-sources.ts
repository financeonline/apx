import 'server-only';
import type { Db } from '@/db/types';
import { startOfLocalDay, addDays } from '@/core/periods';
import type {
  InterimAccountCoverage, InterimBankRow, InterimInvoiceRow, InterimInvoiceType,
} from '@/modules/financial-engine';
import { ORG_PLACEHOLDER, type BriefActionLine, type BriefAlertLine } from '../domain/brief';
import { readOrganization, readRows, readRowsByIds } from '@/db/app/caller-reads';

/**
 * Reads for the daily and weekly briefs (Phase 17). Nothing here writes, and nothing computes a
 * figure: rows in the shapes the interim calculator and the brief assembler take.
 *
 * Called with either a user's client (a live preview, under RLS) or a job's scoped service client
 * (a stored report). Every query names the organisation explicitly either way, so the job's
 * service client reads one organisation and no other.
 *
 * "Live" rows are the engine's: `record_status = 'accepted' and superseded_by is null`
 * (`app.aggregate_periods`); invoices also exclude `void`.
 */

/**
 * On Firestore a read returns every matching row, so the old 1,000-row paging is gone. To need no
 * composite index, each read filters Firestore on ONE field (a range or an `in`) and applies the
 * rest of the predicate here — `isLive` is the engine's "accepted and not superseded".
 */
const isLive = (row: { record_status?: unknown; superseded_by?: unknown }): boolean =>
  row.record_status === 'accepted' && (row.superseded_by === null || row.superseded_by === undefined);

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export interface OrganisationBasics {
  readonly name: string;
  readonly timezone: string;
  readonly baseCurrency: string;
}

export async function loadOrganisationBasics(db: Db, orgId: string): Promise<OrganisationBasics> {
  const row = (await readOrganization(db, orgId)) as { name: string; timezone: string; base_currency: string } | null;
  return {
    name: row?.name ?? 'Your business',
    timezone: row?.timezone ?? 'Europe/London',
    baseCurrency: row?.base_currency ?? 'GBP',
  };
}

/** The UTC instants bounding organisation-local days `start`…`end` inclusive: [from, to). */
export function windowInstants(start: string, end: string, timeZone: string): { from: string; to: string } {
  return {
    from: startOfLocalDay(start, timeZone).toISOString(),
    to: startOfLocalDay(addDays(end, 1), timeZone).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Interim inputs
// ---------------------------------------------------------------------------------------------

export async function loadBankRows(
  db: Db, orgId: string, from: string, to: string,
): Promise<InterimBankRow[]> {
  const rows = (await readRows<{
    id: string; bank_account_id: string; transaction_date: string; amount: string | number;
    currency: string; transfer_kind: string | null; description_normalized: string | null;
    record_status: string; superseded_by: string | null;
  }>(db, orgId, 'bank_transactions', (q) => q
    .where('transaction_date', '>=', from)
    .where('transaction_date', '<=', to)))
    .filter(isLive)
    .sort(byId);
  return rows.map((row) => ({
    id: row.id,
    bankAccountId: row.bank_account_id,
    date: row.transaction_date,
    amount: String(row.amount),
    currency: row.currency,
    transferKind: row.transfer_kind,
    description: row.description_normalized,
  }));
}

interface InvoiceDbRow {
  id: string; invoice_type: InterimInvoiceType; invoice_number: string | null; counterparty_id: string | null;
  issue_date: string; due_date: string | null; paid_date: string | null; total_amount: string | number;
  balance_due: string | number; status: InterimInvoiceRow['status']; currency: string;
  record_status: string; superseded_by: string | null;
}

/** Live invoices issued, due or paid on a date from `from` to `to` inclusive. */
export async function loadInvoiceRows(
  db: Db, orgId: string, from: string, to: string,
): Promise<InterimInvoiceRow[]> {
  const byDate = async (column: 'issue_date' | 'due_date' | 'paid_date') => (await readRows<InvoiceDbRow>(
    db, orgId, 'invoices', (q) => q.where(column, '>=', from).where(column, '<=', to),
  )).filter((row) => isLive(row) && row.status !== 'void');

  // Three indexed reads rather than one OR across three columns; an invoice in more than one is
  // kept once.
  const unique = new Map<string, InvoiceDbRow>();
  for (const rows of await Promise.all([byDate('issue_date'), byDate('due_date'), byDate('paid_date')])) {
    for (const row of rows) unique.set(row.id, row);
  }

  const counterpartyIds = [...new Set([...unique.values()].map((row) => row.counterparty_id)
    .filter((id): id is string => id !== null))];
  const names = new Map((await readRowsByIds<{ id: string; name: string }>(db, orgId, 'counterparties', counterpartyIds))
    .map((row) => [row.id, row.name]));

  return [...unique.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((row) => ({
      id: row.id,
      type: row.invoice_type,
      number: row.invoice_number,
      counterparty: row.counterparty_id === null ? null : names.get(row.counterparty_id) ?? null,
      issueDate: row.issue_date,
      dueDate: row.due_date,
      paidDate: row.paid_date,
      total: String(row.total_amount),
      balanceDue: String(row.balance_due),
      status: row.status,
      currency: row.currency,
    }));
}

export async function hasInvoiceData(db: Db, orgId: string): Promise<boolean> {
  // Equality filters only, which Firestore serves without a composite index.
  const rows = await readRows(db, orgId, 'invoices', (q) => q
    .where('record_status', '==', 'accepted').where('superseded_by', '==', null).limit(1));
  return rows.length > 0;
}

/**
 * How far each active bank account's data reaches: the later of its latest live transaction and the
 * end of its latest committed statement (a statement that ends on a quiet day still covers it).
 */
export async function loadAccountCoverage(db: Db, orgId: string): Promise<InterimAccountCoverage[]> {
  const accounts = (await readRows<{ id: string; name: string }>(db, orgId, 'bank_accounts', (q) => q
    .where('is_active', '==', true)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : byId(a, b)));

  return Promise.all(accounts.map(async (account) => {
    // Equality filters in Firestore, the latest date picked here: no composite index.
    const [txns, statements] = await Promise.all([
      readRows<{ transaction_date: string; record_status: string; superseded_by: string | null }>(
        db, orgId, 'bank_transactions', (q) => q.where('bank_account_id', '==', account.id)
          .where('record_status', '==', 'accepted').where('superseded_by', '==', null),
      ),
      readRows<{ period_end: string | null }>(
        db, orgId, 'import_batches', (q) => q.where('bank_account_id', '==', account.id)
          .where('import_type', '==', 'bank_statement').where('status', '==', 'committed'),
      ),
    ]);
    const txn = txns.map((row) => row.transaction_date).sort().pop() ?? null;
    const statement = statements.map((row) => row.period_end)
      .filter((d): d is string => d !== null).sort().pop() ?? null;
    const latest = [txn, statement].filter((d): d is string => d !== null).sort().pop() ?? null;
    return { bankAccountId: account.id, name: account.name, latestDate: latest };
  }));
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

interface AlertDbRow {
  id: string; severity: BriefAlertLine['severity']; title: string; explanation: string;
  recommended_next_step: string | null; status: string; period_id: string | null;
  first_seen_at: string; reopened_at: string | null; status_changed_at: string | null;
}

function alertLine(row: AlertDbRow, at: string, periodLabels: ReadonlyMap<string, string>): BriefAlertLine {
  return {
    id: row.id,
    severity: row.severity,
    title: row.title,
    explanation: row.explanation,
    nextStep: row.recommended_next_step,
    periodLabel: row.period_id === null ? null : periodLabels.get(row.period_id) ?? null,
    at,
    href: `/app/${ORG_PLACEHOLDER}/insights/alerts/${row.id}`,
  };
}

const within = (instant: string | null, from: string, to: string): boolean =>
  instant !== null && Date.parse(instant) >= Date.parse(from) && Date.parse(instant) < Date.parse(to);

export async function loadAlertEvents(
  db: Db, orgId: string, from: string, to: string, periodLabels: ReadonlyMap<string, string>,
): Promise<{ raised: BriefAlertLine[]; resolved: BriefAlertLine[]; standing: BriefAlertLine[] }> {
  // The old OR across two ranges is two single-field range reads, merged; each list in id order.
  const [firstSeen, reopened, resolvedRows, standingRows] = await Promise.all([
    readRows<AlertDbRow>(db, orgId, 'alerts', (q) => q.where('first_seen_at', '>=', from).where('first_seen_at', '<', to)),
    readRows<AlertDbRow>(db, orgId, 'alerts', (q) => q.where('reopened_at', '>=', from).where('reopened_at', '<', to)),
    readRows<AlertDbRow>(db, orgId, 'alerts', (q) => q.where('status_changed_at', '>=', from).where('status_changed_at', '<', to))
      .then((rows) => rows.filter((row) => row.status === 'resolved')),
    readRows<AlertDbRow>(db, orgId, 'alerts', (q) => q.where('status', 'in', ['open', 'acknowledged'])),
  ]);
  const raisedRows = [...new Map([...firstSeen, ...reopened].map((row) => [row.id, row])).values()].sort(byId);
  resolvedRows.sort(byId);
  standingRows.sort(byId);

  return {
    raised: raisedRows.map((row) => alertLine(row,
      within(row.reopened_at, from, to) ? row.reopened_at! : row.first_seen_at, periodLabels)),
    resolved: resolvedRows.map((row) => alertLine(row, row.status_changed_at ?? row.first_seen_at, periodLabels)),
    standing: standingRows.map((row) => alertLine(row, row.reopened_at ?? row.first_seen_at, periodLabels)),
  };
}

interface ActionDbRow {
  id: string; title: string; priority: BriefActionLine['priority']; status: BriefActionLine['status'];
  due_date: string | null; owner_user_id: string | null; created_at: string; completed_at: string | null;
}

function actionLine(row: ActionDbRow, at: string | null): BriefActionLine {
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    status: row.status,
    dueDate: row.due_date,
    assigned: row.owner_user_id !== null,
    at,
    href: `/app/${ORG_PLACEHOLDER}/actions/${row.id}`,
  };
}

export async function loadActionEvents(
  db: Db, orgId: string, from: string, to: string,
): Promise<{ created: BriefActionLine[]; completed: BriefActionLine[]; open: BriefActionLine[] }> {
  const [createdRows, completedRows, openRows] = await Promise.all([
    readRows<ActionDbRow>(db, orgId, 'actions', (q) => q.where('created_at', '>=', from).where('created_at', '<', to)),
    readRows<ActionDbRow>(db, orgId, 'actions', (q) => q.where('completed_at', '>=', from).where('completed_at', '<', to))
      .then((rows) => rows.filter((row) => row.status === 'completed')),
    readRows<ActionDbRow>(db, orgId, 'actions', (q) => q.where('status', 'in', ['open', 'in_progress'])),
  ]);
  for (const rows of [createdRows, completedRows, openRows]) rows.sort(byId);
  return {
    created: createdRows.map((row) => actionLine(row, row.created_at)),
    completed: completedRows.map((row) => actionLine(row, row.completed_at)),
    open: openRows.map((row) => actionLine(row, null)),
  };
}
