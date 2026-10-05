/**
 * What an invoice row needs before it can commit, beyond the columns the file supplied
 * (IMPORT_ENGINE.md §6.1, CD-28, ADR-047.5).
 *
 * Pure: a mapped row in, the same row with `invoice_type`, signs and `status` settled.
 */

import { tryParseDecimal, toMoneyString } from '@/core/money';
import type { InvoiceSide } from './types';

/** `invoice_status_enum`, in the order a reader meets them. */
export const INVOICE_STATUSES = ['open', 'partially_paid', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * The words accounting exports use for each status (Xero, QuickBooks, Sage, FreeAgent, plain
 * spreadsheets). A draft is deliberately absent: it has not been issued, so importing it as open
 * would state revenue nobody invoiced — it is left for `IMP-INV-013` and a human.
 */
const STATUS_WORDS: Readonly<Record<string, InvoiceStatus>> = {
  open: 'open', unpaid: 'open', outstanding: 'open', due: 'open', overdue: 'open',
  'awaiting payment': 'open', sent: 'open', authorised: 'open', authorized: 'open',
  approved: 'open', issued: 'open', posted: 'open', submitted: 'open',
  'partially paid': 'partially_paid', 'part paid': 'partially_paid', partial: 'partially_paid',
  'partly paid': 'partially_paid', 'partially_paid': 'partially_paid',
  paid: 'paid', settled: 'paid', closed: 'paid', 'fully paid': 'paid', 'paid in full': 'paid',
  void: 'void', voided: 'void', cancelled: 'void', canceled: 'void', deleted: 'void',
};

/** The enum value a file's status word means, or null when MOTION does not know the word. */
export function readInvoiceStatus(raw: string): InvoiceStatus | null {
  const key = raw.toLowerCase().replace(/[^a-z_]+/g, ' ').trim();
  return STATUS_WORDS[key] ?? null;
}

const SIGNED_FIELDS = ['subtotal', 'tax_amount', 'total_amount', 'amount_paid'] as const;

/**
 * Sets `invoice_type` from the list's side, turns a negative total into a credit note with all
 * four money fields negated together (CD-28), and reads the status word into the enum.
 *
 * Mutates the row, as the rest of the staging step does. A value it cannot read is left exactly as
 * written, so validation names it rather than this guessing.
 */
export function classifyInvoice(mapped: Record<string, string | null>, side: InvoiceSide): void {
  const total = tryParseDecimal(mapped.total_amount ?? null);
  const creditNote = total !== null && total.isNegative();
  mapped.invoice_type = creditNote ? `${side}_credit_note` : side;

  if (creditNote) {
    for (const field of SIGNED_FIELDS) {
      const amount = tryParseDecimal(mapped[field] ?? null);
      // A zero stays zero: negating it would store "-0.00".
      if (amount !== null) mapped[field] = toMoneyString(amount.isZero() ? amount.abs() : amount.negated());
    }
  }

  const status = mapped.status;
  if (status !== undefined && status !== null && status.trim() !== '') {
    mapped.status = readInvoiceStatus(status) ?? status.trim();
  }
}
