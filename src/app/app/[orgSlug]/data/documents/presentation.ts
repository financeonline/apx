import type { BadgeTone } from '@/components/ui/surfaces';

export const DOCUMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  uploaded: 'Uploading', scanning: 'Checking', ready: 'Ready', unreadable: 'Stored only', quarantined: 'Quarantined', deleted: 'Deleted',
};
export const DOCUMENT_STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  uploaded: 'neutral', scanning: 'neutral', ready: 'accent', unreadable: 'warn', quarantined: 'danger', deleted: 'neutral',
};
export const DOCUMENT_KIND_LABELS: Readonly<Record<string, string>> = {
  bank_statement: 'Bank statement', general_ledger: 'Ledger', trial_balance: 'Trial balance', pnl_report: 'P&L report',
  balance_sheet: 'Balance sheet', sales_report: 'Sales report', purchase_report: 'Purchase report', invoice: 'Invoice',
  receipt: 'Receipt', other: 'Other', unknown: 'Not yet known', budget: 'Budget',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
