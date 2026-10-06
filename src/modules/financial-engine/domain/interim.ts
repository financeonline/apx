import {
  ZERO, abs, add, compare, isNegative, isPositive, negate, parseMoney, subtract, toMoneyString, type Decimal,
} from '@/core/money';

/**
 * Interim figures — day- and week-level figures from dated records (Phase 17, R17-1b, ADR-141).
 *
 * The monthly engine computes complete months only (ADR-030), and its outputs are versioned and
 * golden-hashed. The owner asked for daily and weekly figures as well, so they are computed HERE,
 * apart from it: nothing the monthly engine produces reads this, and nothing here is stored as a
 * metric snapshot. That keeps every monthly figure — and its golden record — exactly as it was.
 *
 * What may be computed for a window shorter than a month is only what the records themselves date
 * within it:
 *   - CASH: accepted bank transactions by `transaction_date` — money in, money out, net movement.
 *     Transfers between the organisation's own accounts are excluded, as the monthly engine excludes
 *     them (ADR-028: `cash_transfer` only).
 *   - INVOICING: accepted sales and purchase invoices by `issue_date`, net of credit notes.
 *   - COLLECTED / PAID: invoices whose `paid_date` falls in the window — fully paid invoices only,
 *     because a partial payment carries no date.
 *   - FELL DUE: invoices whose `due_date` falls in the window and that still had a balance when the
 *     report was composed.
 * Revenue and profit on the accounting basis are NOT here: a trial balance or P&L report is a
 * month, and dividing it into days would invent figures.
 *
 * Every figure carries the records it is made of (the largest, up to a cap, and the count), so a
 * report can be drilled to the transaction (SOW §14). Pure: rows in, figures out; no clock.
 */

export const INTERIM_RULES_VERSION = 'interim.v1';

/** How many contributing records a figure lists by id. The count is always exact. */
export const INTERIM_RECORD_CAP = 25;

export type IsoDate = string;

export interface InterimWindow {
  readonly start: IsoDate;
  /** Inclusive. */
  readonly end: IsoDate;
}

export interface InterimBankRow {
  readonly id: string;
  readonly bankAccountId: string;
  readonly date: IsoDate;
  /** Signed: positive is money in. */
  readonly amount: string;
  readonly currency: string;
  readonly transferKind: string | null;
  readonly description: string | null;
}

export type InterimInvoiceType = 'sales' | 'purchase' | 'sales_credit_note' | 'purchase_credit_note';

export interface InterimInvoiceRow {
  readonly id: string;
  readonly type: InterimInvoiceType;
  readonly number: string | null;
  readonly counterparty: string | null;
  readonly issueDate: IsoDate;
  readonly dueDate: IsoDate | null;
  readonly paidDate: IsoDate | null;
  readonly total: string;
  readonly balanceDue: string;
  readonly status: 'open' | 'partially_paid' | 'paid' | 'void';
  readonly currency: string;
}

export interface InterimAccountCoverage {
  readonly bankAccountId: string;
  readonly name: string;
  /** The latest date any accepted transaction or statement of this account reaches; NULL: none. */
  readonly latestDate: IsoDate | null;
}

export interface InterimInput {
  readonly window: InterimWindow;
  readonly baseCurrency: string;
  /** Accepted, current bank transactions dated within the window. */
  readonly bank: readonly InterimBankRow[];
  /** Accepted, current, non-void invoices with an issue, due or paid date within the window. */
  readonly invoices: readonly InterimInvoiceRow[];
  /** Every active bank account, with how far its data reaches. */
  readonly accounts: readonly InterimAccountCoverage[];
  /** Whether the organisation has imported any invoice list at all. */
  readonly hasInvoiceData: boolean;
}

export interface InterimRecordRef {
  readonly kind: 'bank' | 'invoice';
  readonly id: string;
  readonly date: IsoDate;
  readonly amount: string;
  readonly label: string;
}

export type InterimStatus = 'calculated' | 'incomplete';

export interface InterimFigure {
  readonly key: InterimFigureKey;
  readonly value: string;
  readonly status: InterimStatus;
  readonly recordCount: number;
  /** The largest contributors by size, at most `INTERIM_RECORD_CAP`. */
  readonly records: readonly InterimRecordRef[];
}

export type InterimFigureKey =
  | 'cash_in' | 'cash_out' | 'net_cash_movement'
  | 'sales_invoiced' | 'purchases_invoiced'
  | 'sales_collected' | 'purchases_paid'
  | 'sales_fell_due_unpaid' | 'purchases_fell_due_unpaid';

export type InterimUnavailable =
  | 'no_bank_accounts'
  | 'no_bank_data_in_window'
  | 'no_invoice_data';

export interface InterimCoverage {
  /** The earliest date every account's data reaches, or NULL when no account has any. */
  readonly bankThrough: IsoDate | null;
  /** Accounts whose data stops before the window ends. */
  readonly accountsShort: readonly { readonly bankAccountId: string; readonly name: string; readonly latestDate: IsoDate | null }[];
  /** Records left out because they are not in the organisation's currency (CD-10: one currency). */
  readonly otherCurrencyRecords: number;
}

export interface InterimFigures {
  readonly version: typeof INTERIM_RULES_VERSION;
  readonly window: InterimWindow;
  readonly currency: string;
  readonly cash: readonly InterimFigure[] | null;
  readonly invoicing: readonly InterimFigure[] | null;
  readonly unavailable: readonly InterimUnavailable[];
  readonly coverage: InterimCoverage;
}

const within = (date: IsoDate | null, window: InterimWindow): boolean =>
  date !== null && date >= window.start && date <= window.end;

interface Part { readonly ref: InterimRecordRef; readonly value: Decimal }

function figure(key: InterimFigureKey, parts: readonly Part[], status: InterimStatus): InterimFigure {
  let total: Decimal = ZERO;
  for (const part of parts) total = add(total, part.value);
  const largest = [...parts]
    // Largest first; ties by date then id, so the same rows always list in the same order.
    .sort((a, b) => compare(abs(b.value), abs(a.value))
      || a.ref.date.localeCompare(b.ref.date) || a.ref.id.localeCompare(b.ref.id))
    .slice(0, INTERIM_RECORD_CAP)
    .map((part) => part.ref);
  return { key, value: toMoneyString(total), status, recordCount: parts.length, records: largest };
}

function bankRef(row: InterimBankRow, amount: Decimal): Part {
  return {
    ref: { kind: 'bank', id: row.id, date: row.date, amount: toMoneyString(amount), label: row.description ?? 'Bank transaction' },
    value: amount,
  };
}

function invoiceRef(row: InterimInvoiceRow, date: IsoDate, amount: Decimal): Part {
  const who = row.counterparty === null ? '' : ` · ${row.counterparty}`;
  const label = `${row.number ?? 'Invoice'}${who}`;
  return { ref: { kind: 'invoice', id: row.id, date, amount: toMoneyString(amount), label }, value: amount };
}

export function computeInterimFigures(input: InterimInput): InterimFigures {
  const { window, baseCurrency } = input;
  const unavailable: InterimUnavailable[] = [];
  let otherCurrency = 0;

  // ---- Coverage: how far each account's data reaches ------------------------------------------
  const short = input.accounts
    .filter((account) => account.latestDate === null || account.latestDate < window.end)
    .map((account) => ({ bankAccountId: account.bankAccountId, name: account.name, latestDate: account.latestDate }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.bankAccountId.localeCompare(b.bankAccountId));
  const reached = input.accounts.map((account) => account.latestDate).filter((d): d is IsoDate => d !== null);
  // Through the earliest date EVERY account reaches; an account with no data at all reaches none.
  const bankThrough = reached.length === 0 || reached.length < input.accounts.length
    ? null
    : [...reached].sort()[0] ?? null;

  // ---- Cash -------------------------------------------------------------------------------------
  let cash: InterimFigure[] | null = null;
  const bankInWindow = input.bank.filter((row) => within(row.date, window));
  if (input.accounts.length === 0) {
    unavailable.push('no_bank_accounts');
  } else if (bankInWindow.length === 0 && short.length === input.accounts.length) {
    // Nothing dated in the window, and no account's data reaches its end: silence, not zero.
    unavailable.push('no_bank_data_in_window');
  } else {
    const inflow: Part[] = [];
    const outflow: Part[] = [];
    const net: Part[] = [];
    for (const row of bankInWindow) {
      if (row.currency !== baseCurrency) { otherCurrency += 1; continue; }
      if (row.transferKind === 'cash_transfer') continue;
      if (isPositive(row.amount)) inflow.push(bankRef(row, parseMoney(row.amount)));
      else if (isNegative(row.amount)) outflow.push(bankRef(row, negate(row.amount)));
      else continue;
      net.push(bankRef(row, parseMoney(row.amount)));
    }
    // A window some account's data does not reach is computed from what is there, and says so.
    const status: InterimStatus = short.length === 0 ? 'calculated' : 'incomplete';
    cash = [
      figure('cash_in', inflow, status),
      figure('cash_out', outflow, status),
      figure('net_cash_movement', net, status),
    ];
  }

  // ---- Invoicing --------------------------------------------------------------------------------
  let invoicing: InterimFigure[] | null = null;
  if (!input.hasInvoiceData) {
    unavailable.push('no_invoice_data');
  } else {
    const salesIssued: Part[] = [];
    const purchasesIssued: Part[] = [];
    const salesPaid: Part[] = [];
    const purchasesPaid: Part[] = [];
    const salesDue: Part[] = [];
    const purchasesDue: Part[] = [];
    for (const row of input.invoices) {
      if (row.status === 'void') continue;
      if (row.currency !== baseCurrency) { otherCurrency += 1; continue; }
      const sales = row.type === 'sales' || row.type === 'sales_credit_note';
      const credit = row.type === 'sales_credit_note' || row.type === 'purchase_credit_note';
      if (within(row.issueDate, window)) {
        const amount = credit ? negate(row.total) : parseMoney(row.total);
        (sales ? salesIssued : purchasesIssued).push(invoiceRef(row, row.issueDate, amount));
      }
      if (credit) continue;
      if (row.status === 'paid' && within(row.paidDate, window) && row.paidDate !== null) {
        (sales ? salesPaid : purchasesPaid).push(invoiceRef(row, row.paidDate, parseMoney(row.total)));
      }
      if (within(row.dueDate, window) && row.dueDate !== null && isPositive(row.balanceDue)
          && (row.status === 'open' || row.status === 'partially_paid')) {
        (sales ? salesDue : purchasesDue).push(invoiceRef(row, row.dueDate, parseMoney(row.balanceDue)));
      }
    }
    invoicing = [
      figure('sales_invoiced', salesIssued, 'calculated'),
      figure('purchases_invoiced', purchasesIssued, 'calculated'),
      figure('sales_collected', salesPaid, 'calculated'),
      figure('purchases_paid', purchasesPaid, 'calculated'),
      figure('sales_fell_due_unpaid', salesDue, 'calculated'),
      figure('purchases_fell_due_unpaid', purchasesDue, 'calculated'),
    ];
  }

  return {
    version: INTERIM_RULES_VERSION,
    window,
    currency: baseCurrency,
    cash,
    invoicing,
    unavailable,
    coverage: { bankThrough, accountsShort: short, otherCurrencyRecords: otherCurrency },
  };
}

/** Change between two windows' values of one figure: the later minus the earlier. */
export function interimChange(later: string, earlier: string): string {
  return toMoneyString(subtract(later, earlier));
}
