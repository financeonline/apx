import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { startOfLocalDay, addDays } from '@/core/periods';
import type {
  InterimAccountCoverage, InterimBankRow, InterimInvoiceRow, InterimInvoiceType,
} from '@/modules/financial-engine';
import { ORG_PLACEHOLDER, type BriefActionLine, type BriefAlertLine } from '../domain/brief';

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

/** PostgREST's default page; anything that could exceed it is read in pages. */
const PAGE = 1000;

async function readAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw toMotionError(error);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export interface OrganisationBasics {
  readonly name: string;
  readonly timezone: string;
  readonly baseCurrency: string;
}

export async function loadOrganisationBasics(db: SupabaseClient, orgId: string): Promise<OrganisationBasics> {
  const { data, error } = await db
    .from('organizations').select('name, timezone, base_currency').eq('id', orgId).maybeSingle();
  if (error) throw toMotionError(error);
  const row = data as { name: string; timezone: string; base_currency: string } | null;
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
  db: SupabaseClient, orgId: string, from: string, to: string,
): Promise<InterimBankRow[]> {
  const rows = await readAll<{
    id: string; bank_account_id: string; transaction_date: string; amount: string | number;
    currency: string; transfer_kind: string | null; description_normalized: string | null;
  }>((a, b) => db
    .from('bank_transactions')
    .select('id, bank_account_id, transaction_date, amount, currency, transfer_kind, description_normalized')
    .eq('organization_id', orgId)
    .eq('record_status', 'accepted')
    .is('superseded_by', null)
    .gte('transaction_date', from)
    .lte('transaction_date', to)
    .order('id')
    .range(a, b));
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

const INVOICE_SELECT =
  'id, invoice_type, invoice_number, counterparty_id, issue_date, due_date, paid_date, total_amount, balance_due, status, currency';

interface InvoiceDbRow {
  id: string; invoice_type: InterimInvoiceType; invoice_number: string | null; counterparty_id: string | null;
  issue_date: string; due_date: string | null; paid_date: string | null; total_amount: string | number;
  balance_due: string | number; status: InterimInvoiceRow['status']; currency: string;
}

/** Live invoices issued, due or paid on a date from `from` to `to` inclusive. */
export async function loadInvoiceRows(
  db: SupabaseClient, orgId: string, from: string, to: string,
): Promise<InterimInvoiceRow[]> {
  const byDate = (column: 'issue_date' | 'due_date' | 'paid_date') => readAll<InvoiceDbRow>((a, b) => db
    .from('invoices')
    .select(INVOICE_SELECT)
    .eq('organization_id', orgId)
    .eq('record_status', 'accepted')
    .is('superseded_by', null)
    .neq('status', 'void')
    .gte(column, from)
    .lte(column, to)
    .order('id')
    .range(a, b));

  // Three indexed reads rather than one OR across three columns; an invoice in more than one is
  // kept once.
  const unique = new Map<string, InvoiceDbRow>();
  for (const rows of await Promise.all([byDate('issue_date'), byDate('due_date'), byDate('paid_date')])) {
    for (const row of rows) unique.set(row.id, row);
  }

  const counterpartyIds = [...new Set([...unique.values()].map((row) => row.counterparty_id)
    .filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  for (let i = 0; i < counterpartyIds.length; i += 200) {
    const { data, error } = await db.from('counterparties').select('id, name')
      .eq('organization_id', orgId).in('id', counterpartyIds.slice(i, i + 200));
    if (error) throw toMotionError(error);
    for (const row of (data ?? []) as Array<{ id: string; name: string }>) names.set(row.id, row.name);
  }

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

export async function hasInvoiceData(db: SupabaseClient, orgId: string): Promise<boolean> {
  const { data, error } = await db.from('invoices').select('id')
    .eq('organization_id', orgId).eq('record_status', 'accepted').is('superseded_by', null).limit(1);
  if (error) throw toMotionError(error);
  return (data ?? []).length > 0;
}

/**
 * How far each active bank account's data reaches: the later of its latest live transaction and the
 * end of its latest committed statement (a statement that ends on a quiet day still covers it).
 */
export async function loadAccountCoverage(db: SupabaseClient, orgId: string): Promise<InterimAccountCoverage[]> {
  const { data, error } = await db.from('bank_accounts').select('id, name')
    .eq('organization_id', orgId).eq('is_active', true).order('name').order('id');
  if (error) throw toMotionError(error);
  const accounts = (data ?? []) as Array<{ id: string; name: string }>;

  return Promise.all(accounts.map(async (account) => {
    const [latestTxn, latestStatement] = await Promise.all([
      db.from('bank_transactions').select('transaction_date')
        .eq('organization_id', orgId).eq('bank_account_id', account.id)
        .eq('record_status', 'accepted').is('superseded_by', null)
        .order('transaction_date', { ascending: false }).limit(1),
      db.from('import_batches').select('period_end')
        .eq('organization_id', orgId).eq('bank_account_id', account.id)
        .eq('import_type', 'bank_statement').eq('status', 'committed')
        .not('period_end', 'is', null)
        .order('period_end', { ascending: false }).limit(1),
    ]);
    if (latestTxn.error) throw toMotionError(latestTxn.error);
    if (latestStatement.error) throw toMotionError(latestStatement.error);
    const txn = (latestTxn.data?.[0] as { transaction_date?: string } | undefined)?.transaction_date ?? null;
    const statement = (latestStatement.data?.[0] as { period_end?: string } | undefined)?.period_end ?? null;
    const latest = [txn, statement].filter((d): d is string => d !== null).sort().pop() ?? null;
    return { bankAccountId: account.id, name: account.name, latestDate: latest };
  }));
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

const ALERT_SELECT =
  'id, severity, title, explanation, recommended_next_step, status, period_id, first_seen_at, reopened_at, status_changed_at';

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
  db: SupabaseClient, orgId: string, from: string, to: string, periodLabels: ReadonlyMap<string, string>,
): Promise<{ raised: BriefAlertLine[]; resolved: BriefAlertLine[]; standing: BriefAlertLine[] }> {
  const [raisedRows, resolvedRows, standingRows] = await Promise.all([
    readAll<AlertDbRow>((a, b) => db.from('alerts').select(ALERT_SELECT)
      .eq('organization_id', orgId)
      .or(`and(first_seen_at.gte.${from},first_seen_at.lt.${to}),and(reopened_at.gte.${from},reopened_at.lt.${to})`)
      .order('id').range(a, b)),
    readAll<AlertDbRow>((a, b) => db.from('alerts').select(ALERT_SELECT)
      .eq('organization_id', orgId).eq('status', 'resolved')
      .gte('status_changed_at', from).lt('status_changed_at', to)
      .order('id').range(a, b)),
    readAll<AlertDbRow>((a, b) => db.from('alerts').select(ALERT_SELECT)
      .eq('organization_id', orgId).in('status', ['open', 'acknowledged'])
      .order('id').range(a, b)),
  ]);

  return {
    raised: raisedRows.map((row) => alertLine(row,
      within(row.reopened_at, from, to) ? row.reopened_at! : row.first_seen_at, periodLabels)),
    resolved: resolvedRows.map((row) => alertLine(row, row.status_changed_at ?? row.first_seen_at, periodLabels)),
    standing: standingRows.map((row) => alertLine(row, row.reopened_at ?? row.first_seen_at, periodLabels)),
  };
}

const ACTION_SELECT = 'id, title, priority, status, due_date, owner_user_id, created_at, completed_at';

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
  db: SupabaseClient, orgId: string, from: string, to: string,
): Promise<{ created: BriefActionLine[]; completed: BriefActionLine[]; open: BriefActionLine[] }> {
  const [createdRows, completedRows, openRows] = await Promise.all([
    readAll<ActionDbRow>((a, b) => db.from('actions').select(ACTION_SELECT)
      .eq('organization_id', orgId).gte('created_at', from).lt('created_at', to).order('id').range(a, b)),
    readAll<ActionDbRow>((a, b) => db.from('actions').select(ACTION_SELECT)
      .eq('organization_id', orgId).eq('status', 'completed')
      .gte('completed_at', from).lt('completed_at', to).order('id').range(a, b)),
    readAll<ActionDbRow>((a, b) => db.from('actions').select(ACTION_SELECT)
      .eq('organization_id', orgId).in('status', ['open', 'in_progress']).order('id').range(a, b)),
  ]);
  return {
    created: createdRows.map((row) => actionLine(row, row.created_at)),
    completed: completedRows.map((row) => actionLine(row, row.completed_at)),
    open: openRows.map((row) => actionLine(row, null)),
  };
}
