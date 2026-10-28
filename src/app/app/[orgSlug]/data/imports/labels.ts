import { formatDate } from '@/components/labels';

/**
 * How an import is named on every Data page — the imports list, the review screen and the document
 * library — so one file never reads "committed" on one page and "Imported" on the next.
 */

export const IMPORT_TYPE_LABELS: Readonly<Record<string, string>> = {
  bank_statement: 'Bank statement',
  general_ledger: 'General ledger',
  trial_balance: 'Trial balance',
  pnl_report: 'Profit and loss',
  balance_sheet: 'Balance sheet',
  sales_invoices: 'Sales invoices',
  purchase_invoices: 'Purchase invoices',
  sales_report: 'Sales report',
  purchase_report: 'Purchase report',
  receipts: 'Receipts',
  budget: 'Budget',
};

/** An import's status in the owner's words. "Removed" is a rollback: its rows left the figures. */
export const IMPORT_STATUS_LABELS: Readonly<Record<string, string>> = {
  created: 'Started',
  parsing: 'Reading',
  mapping: 'Reading',
  validating: 'Checking',
  awaiting_review: 'Needs your review',
  committing: 'Importing',
  committed: 'Imported',
  rolled_back: 'Removed',
  rejected: 'Discarded',
  failed: 'Could not be read',
  deferred_upstream: 'Waiting',
};

export function importStatusLabel(status: string): string {
  return IMPORT_STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

export function importTypeLabel(importType: string): string {
  return IMPORT_TYPE_LABELS[importType] ?? importType.replace(/_/g, ' ');
}

/** "1 Jan 2026 – 30 Sep 2026", or one date when a file covers a single day (one invoice). */
export function formatCoverage(start: string | null, end: string | null): string {
  if (start === null && end === null) return '—';
  if (start !== null && start === end) return formatDate(start);
  return `${formatDate(start)} – ${formatDate(end)}`;
}
