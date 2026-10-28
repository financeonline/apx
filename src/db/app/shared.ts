import 'server-only';
import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { Permission } from '@/core/permissions';
import { raise } from '../raise';
import { globalRow, newId, nowIso, orgRow, uniqueGuard } from '../schema';
import { readerOf, type Reader } from '../types';
import { hasPermissionOf } from './access';

/**
 * Helpers several areas share, ported from the `app` schema. Each follows the transaction rule
 * (FIRESTORE_DATA_MODEL.md §7): a `prepare*` does every read and returns a `write(tx)` that does
 * only writes, so a caller can gather all its reads first and then write.
 */

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

/**
 * `app.normalize_name`: the comparison key for counterparty, account, product, campaign and channel
 * names — NFC, case-folded (Turkish dotted İ and final sigma handled), runs of whitespace,
 * punctuation and control characters collapsed to one space, trimmed.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/İ/g, 'i̇')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/[\s\p{P}\p{Cc}$+<=>^`|~]+/gu, ' ')
    .trim();
}

/** `app.held_name_key`: the key a name is parked under while its records await an identity decision. */
export const heldNameKey = (key: string, id: string): string => `${key} [held ${id}]`;

/** `app.slugify`: lower-case, runs of anything else to one hyphen, at most 40 characters. */
export function slugify(text: string | null | undefined): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    .replace(/^-+|-+$/g, '');
}

// ── Fiscal periods ───────────────────────────────────────────────────────────────────────────────

/** `app.fiscal_position`: the fiscal year and quarter of a month, given the year's first month. */
export function fiscalPosition(periodStart: string, fyStartMonth: number): { fiscal_year: number; fiscal_quarter: number } {
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  const offset = ((month - fyStartMonth) + 12) % 12;
  return {
    fiscal_year: year - (offset > month - 1 ? 1 : 0),
    fiscal_quarter: Math.floor(offset / 3) + 1,
  };
}

/**
 * A fiscal period's id is derived from its organisation and first day, so the "one period per
 * month" constraint holds by construction and two writers creating the same month create the same
 * document (the SQL `on conflict (organization_id, period_start) do nothing`).
 */
export function periodId(orgId: string, periodStart: string): string {
  const h = createHash('sha256').update(`fiscal_period:${orgId}:${periodStart}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function monthEnd(start: string): string {
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${start.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

function addMonth(start: string): string {
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

export interface PreparedPeriods {
  /** period_start → period id, for every month in the range. */
  readonly ids: ReadonlyMap<string, string>;
  /** How many months did not exist yet. */
  readonly created: number;
  write(tx: Transaction): void;
}

/**
 * `app.ensure_periods(org, from, to)` and the `app.period_assign` trigger: makes sure every month
 * from `from` to `to` has a fiscal period, and returns their ids. Reads first; `write` creates the
 * missing months.
 */
export async function preparePeriods(
  fs: Firestore, orgId: string, from: string, to: string, tx?: Transaction,
): Promise<PreparedPeriods> {
  const r = readerOf(tx);
  const org = await r.get(globalRow(fs, 'organizations', orgId));
  const fyMonth = org.exists ? Number(org.get('fiscal_year_start_month')) : NaN;
  if (!org.exists || !Number.isFinite(fyMonth)) raise.notFound();

  const starts: string[] = [];
  for (let s = monthStart(from); s <= monthStart(to); s = addMonth(s)) starts.push(s);
  const refs = starts.map((s) => orgRow(fs, orgId, 'fiscal_periods', periodId(orgId, s)));
  const snaps = await Promise.all(refs.map((ref) => r.get(ref)));
  const missing = starts.filter((_, i) => !snaps[i]!.exists);
  const now = nowIso();
  return {
    ids: new Map(starts.map((s) => [s, periodId(orgId, s)])),
    created: missing.length,
    write(t) {
      for (const s of missing) {
        const pos = fiscalPosition(s, fyMonth);
        const y = s.slice(0, 4);
        t.set(orgRow(fs, orgId, 'fiscal_periods', periodId(orgId, s)), {
          id: periodId(orgId, s), organization_id: orgId, period_start: s, period_end: monthEnd(s),
          fiscal_year: pos.fiscal_year, fiscal_quarter: pos.fiscal_quarter,
          label: `${MONTHS[Number(s.slice(5, 7)) - 1]} ${y}`,
          is_complete: false, is_locked: false, created_at: now, updated_at: now,
        });
      }
    },
  };
}

/** `ensure_periods` outside a transaction; returns how many months it created. */
export async function ensurePeriods(fs: Firestore, orgId: string, from: string, to: string): Promise<number> {
  return fs.runTransaction(async (tx) => {
    const p = await preparePeriods(fs, orgId, from, to, tx);
    p.write(tx);
    return p.created;
  });
}

// ── Notifications and record history ─────────────────────────────────────────────────────────────

/**
 * `app.notify`: tells one person something happened — unless they are the one who did it, or they
 * do not hold the permission the thing is about.
 */
export async function prepareNotify(
  fs: Firestore,
  input: {
    orgId: string; userId: string | null; actorId: string | null; permission: Permission;
    kind: string; title: string; body: string | null; href: string | null;
  },
  r: Reader = readerOf(),
): Promise<{ write(tx: Transaction): void }> {
  const skip = { write() {} };
  if (!input.userId || input.userId === input.actorId) return skip;
  if (!(await hasPermissionOf(fs, input.userId, input.orgId, input.permission, r))) return skip;
  const id = newId();
  return {
    write(tx) {
      tx.set(orgRow(fs, input.orgId, 'notifications', id), {
        id, organization_id: input.orgId, user_id: input.userId, kind: input.kind,
        title: input.title.slice(0, 200), body: input.body ? input.body.slice(0, 1000) : null,
        href: input.href, read_at: null, created_at: nowIso(),
      });
    },
  };
}

/** `app.record_status_event`: one entry in a financial record's status history. */
export function writeRecordStatusEvent(
  tx: Transaction, fs: Firestore,
  e: {
    orgId: string; table: string; recordId: string; event: string; actorId: string | null;
    relatedId?: string | null; batchId?: string | null;
  },
): string {
  const id = newId();
  tx.set(orgRow(fs, e.orgId, 'record_status_events', id), {
    id, organization_id: e.orgId, record_table: e.table, record_id: e.recordId, event: e.event,
    related_record_id: e.relatedId ?? null, import_batch_id: e.batchId ?? null,
    actor_user_id: e.actorId, at: nowIso(),
  });
  return id;
}

// ── The standard chart ───────────────────────────────────────────────────────────────────────────

export const STANDARD_CATEGORIES = [
  'revenue', 'other_income', 'cost_of_sales', 'operating_expense', 'payroll', 'marketing',
  'interest_expense', 'tax_expense', 'depreciation', 'other_expense', 'cash', 'receivables',
  'inventory', 'other_current_asset', 'fixed_asset', 'other_asset', 'payables', 'credit_card',
  'loan', 'tax_liability', 'other_current_liability', 'long_term_liability', 'equity', 'drawings',
  'transfer', 'uncategorised',
] as const;
export type StandardCategory = (typeof STANDARD_CATEGORIES)[number];

/** `app.standard_category_label`. */
export const STANDARD_CATEGORY_LABEL: Record<StandardCategory, string> = {
  revenue: 'Revenue', other_income: 'Other Income', cost_of_sales: 'Cost of Sales',
  operating_expense: 'Operating Expenses', payroll: 'Payroll', marketing: 'Marketing',
  interest_expense: 'Interest Expense', tax_expense: 'Tax Expense', depreciation: 'Depreciation',
  other_expense: 'Other Expenses', cash: 'Cash', receivables: 'Accounts Receivable',
  inventory: 'Inventory', other_current_asset: 'Other Current Assets', fixed_asset: 'Fixed Assets',
  other_asset: 'Other Assets', payables: 'Accounts Payable', credit_card: 'Credit Cards', loan: 'Loans',
  tax_liability: 'Tax Liabilities', other_current_liability: 'Other Current Liabilities',
  long_term_liability: 'Long-Term Liabilities', equity: 'Equity', drawings: 'Drawings',
  transfer: 'Transfers', uncategorised: 'Uncategorised',
};

/** `public.standard_category_account_type`. `transfer` and `uncategorised` are assets on purpose. */
export function standardCategoryAccountType(c: StandardCategory): 'income' | 'expense' | 'asset' | 'liability' | 'equity' {
  if (c === 'revenue' || c === 'other_income') return 'income';
  if (['cost_of_sales', 'operating_expense', 'payroll', 'marketing', 'interest_expense', 'tax_expense',
    'depreciation', 'other_expense'].includes(c)) return 'expense';
  if (['payables', 'credit_card', 'loan', 'tax_liability', 'other_current_liability', 'long_term_liability'].includes(c)) return 'liability';
  if (c === 'equity' || c === 'drawings') return 'equity';
  return 'asset';
}

/**
 * `app.seed_standard_chart(org)` for a NEW organisation: one system account per standard category,
 * each holding its `accounts_org_normalized_unique` guard. Write-only — a new organisation has no
 * accounts to read.
 */
export function writeStandardChart(tx: Transaction, fs: Firestore, orgId: string): number {
  const now = nowIso();
  for (const c of STANDARD_CATEGORIES) {
    const id = newId();
    const name = STANDARD_CATEGORY_LABEL[c];
    const normalized = normalizeName(name);
    tx.set(orgRow(fs, orgId, 'accounts', id), {
      id, organization_id: orgId, code: null, name, normalized_name: normalized,
      account_type: standardCategoryAccountType(c), standard_category: c, is_system: true,
      is_active: true, source: 'seeded', external_ref: null, mapping_confidence: 'confirmed',
      loan_security: null, created_at: now, updated_at: now,
    });
    tx.set(uniqueGuard(fs, { orgId }, 'accounts_org_normalized_unique', [normalized]).ref, {
      owner_id: id, constraint: 'accounts_org_normalized_unique', created_at: now,
    });
  }
  return STANDARD_CATEGORIES.length;
}
