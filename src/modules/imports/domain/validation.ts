import { z } from 'zod';

/**
 * Import input validation. As elsewhere, the database re-checks every one of these rules; this layer
 * exists to give a reviewer a field-level message instead of a SQLSTATE.
 */

export const StartImportBatchInput = z
  .object({
    documentId: z.string().uuid(),
    importType: z.enum([
      'general_ledger', 'trial_balance', 'pnl_report', 'balance_sheet', 'bank_statement',
      'sales_invoices', 'purchase_invoices', 'sales_report', 'purchase_report', 'receipts', 'budget',
    ]),
    bankAccountId: z.string().uuid().optional(),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    balanceBasis: z.enum(['cumulative', 'movement']).optional(),
    /** How the wizard read the file (ADR-083). `pdf_claude` is the server's alone. */
    extractionMethod: z.enum(['csv', 'xlsx', 'pdf_text']).optional(),
  })
  .refine((v) => v.importType !== 'bank_statement' || v.bankAccountId !== undefined, {
    message: 'Choose which bank account this statement belongs to',
    path: ['bankAccountId'],
  })
  .refine((v) => v.importType === 'bank_statement' || v.bankAccountId === undefined, {
    message: 'Only a bank statement belongs to a bank account',
    path: ['bankAccountId'],
  })
  .refine(
    (v) => v.periodStart === undefined || v.periodEnd === undefined || v.periodEnd >= v.periodStart,
    { message: 'The end of the range cannot be before its start', path: ['periodEnd'] },
  );
export type StartImportBatchInput = z.infer<typeof StartImportBatchInput>;

/**
 * A reviewer's decision on one row.
 *
 * The reason is required for the two decisions that overrule what validation concluded — keeping a
 * row flagged as a duplicate, and skipping a row that validated cleanly. Those are exactly the two a
 * later reader will need explained. The database enforces the same rule; this copy is what puts the
 * message next to the right field.
 */
export const RowDecisionSchema = z.object({
  rowId: z.string().uuid(),
  decision: z.enum(['none', 'keep', 'skip', 'fixed']),
  reason: z.string().trim().min(1).max(500).nullable().default(null),
  /** What validation said about this row, so the reason requirement can be checked client-side. */
  currentStatus: z.enum([
    'pending', 'valid', 'warning', 'error', 'duplicate', 'skipped', 'committed', 'rejected',
  ]).optional(),
});

export const DecideImportRowsInput = z.object({
  batchId: z.string().uuid(),
  decisions: z.array(RowDecisionSchema).min(1).max(500),
}).superRefine((value, ctx) => {
  value.decisions.forEach((d, index) => {
    const needsReason =
      (d.decision === 'keep' && d.currentStatus === 'duplicate') ||
      (d.decision === 'skip' && d.currentStatus === 'valid');
    if (needsReason && !d.reason) {
      ctx.addIssue({
        code: 'custom',
        path: ['decisions', index, 'reason'],
        message: d.decision === 'keep'
          ? 'Say why this duplicate should be kept'
          : 'Say why this row should be skipped',
      });
    }
  });
});
export type DecideImportRowsInput = z.infer<typeof DecideImportRowsInput>;

export const SaveImportMappingInput = z.object({
  batchId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).default('Saved mapping'),
  headerSignature: z.string().min(1),
  columnMap: z.record(z.string(), z.string()).default({}),
  transforms: z.record(z.string(), z.unknown()).default({}),
  accountMap: z.record(z.string(), z.string()).default({}),
  balanceBasis: z.enum(['cumulative', 'movement']).optional(),
  balanceSign: z.enum(['natural', 'reporting']).optional(),
});
export type SaveImportMappingInput = z.infer<typeof SaveImportMappingInput>;

export const SetStatementBalancesInput = z.object({
  batchId: z.string().uuid(),
  opening: z.string().regex(/^-?\d{1,16}(\.\d{1,2})?$/).nullable(),
  closing: z.string().regex(/^-?\d{1,16}(\.\d{1,2})?$/).nullable(),
});
export type SetStatementBalancesInput = z.infer<typeof SetStatementBalancesInput>;
