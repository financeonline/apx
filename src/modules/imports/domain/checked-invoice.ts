import { z } from 'zod';
import type { ParsedTable, TargetField } from './pipeline-types';

/**
 * One invoice whose fields a reviewer checked against the document (ADR-175).
 *
 * The browser reads a photo, scan or PDF of a single invoice (OCR, or the PDF's own text) and fills
 * the form; the reviewer corrects it and ticks that every field matches the invoice. What arrives
 * here is therefore the reviewer's statement, not the reader's guess — and it becomes a one-row table
 * that goes through exactly the same pipeline, checks and review screen as a CSV invoice list.
 */

const money = z.string().trim()
  .transform((v) => v.replace(/[£€$,\s]/g, ''))
  .refine((v) => /^-?\d+(\.\d{1,2})?$/.test(v), 'Write the amount as a number, for example 1250.00');
const optionalMoney = z.string().trim().transform((v) => v.replace(/[£€$,\s]/g, ''))
  .refine((v) => v === '' || /^-?\d+(\.\d{1,2})?$/.test(v), 'Write the amount as a number, for example 250.00');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date');

export const CheckedInvoiceInput = z.object({
  invoiceNumber: z.string().trim().min(1, 'Type the invoice number').max(60),
  counterparty: z.string().trim().min(1, 'Type the name on the invoice').max(200),
  issueDate: isoDate,
  dueDate: isoDate.or(z.literal('')),
  subtotal: optionalMoney,
  taxAmount: optionalMoney,
  total: money,
  currency: z.string().trim().toUpperCase().regex(/^([A-Z]{3})?$/, 'A currency is three letters, such as GBP'),
  description: z.string().trim().max(500),
  /** The reviewer's tick: every field was compared with the invoice. Nothing is imported without it. */
  checked: z.literal(true, { error: 'Tick the box to confirm you have checked every field against the invoice' }),
});
export type CheckedInvoiceInput = z.infer<typeof CheckedInvoiceInput>;

/** The table the pipeline reads, with its map given rather than proposed: the columns are ours. */
export function checkedInvoiceTable(
  invoice: CheckedInvoiceInput, side: 'sales' | 'purchase',
): { table: ParsedTable; columnMap: Record<string, TargetField> } {
  const party = side === 'sales' ? 'Customer' : 'Supplier';
  const columns = ['Invoice number', party, 'Issue date', 'Due date', 'Subtotal', 'Tax amount', 'Total amount', 'Currency', 'Description'];
  const blank = (v: string) => (v === '' ? null : v);
  return {
    table: {
      columns,
      rows: [{
        rowNumber: 1,
        sourceRef: 'invoice:checked',
        cells: [
          invoice.invoiceNumber, invoice.counterparty, invoice.issueDate, blank(invoice.dueDate),
          blank(invoice.subtotal), blank(invoice.taxAmount), invoice.total, blank(invoice.currency), blank(invoice.description),
        ],
      }],
      warnings: [],
    },
    columnMap: {
      'Invoice number': 'invoice_number',
      [party]: side === 'sales' ? 'customer' : 'supplier',
      'Issue date': 'issue_date',
      'Due date': 'due_date',
      Subtotal: 'subtotal',
      'Tax amount': 'tax_amount',
      'Total amount': 'total_amount',
      Currency: 'currency',
      Description: 'description',
    },
  };
}
