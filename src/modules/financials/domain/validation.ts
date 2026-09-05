/**
 * Input validation for the financial write surface.
 *
 * These schemas are the FIRST of three checks, not the only one. The database re-validates every
 * one of these rules inside the `api.*` function, because a direct PostgREST call never passes
 * through this file (SECURITY_MODEL.md §5). What they buy is a precise, field-level error for a
 * person filling in a form, instead of a SQLSTATE.
 */
import { z } from 'zod';
import { STANDARD_CATEGORIES } from './types';

export const StandardCategorySchema = z.enum(STANDARD_CATEGORIES);

/**
 * Money arriving from a form. Accepted as a string and checked against the shape
 * `NUMERIC(18,2)` can actually hold, so an over-precise or out-of-range figure is rejected here
 * rather than silently rounded by Postgres (ADR-006).
 */
export const MoneyStringSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,16}(\.\d{1,2})?$/, 'Enter an amount with at most two decimal places');

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD')
  .refine((value) => {
    // `2026-02-30` matches the pattern but is not a date. Compare the round trip rather than
    // trusting Date's silent rollover.
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const parsed = new Date(Date.UTC(y, m - 1, d));
    return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
  }, 'That date does not exist');

export const RemapAccountInput = z.object({
  accountId: z.string().uuid(),
  standardCategory: StandardCategorySchema,
});
export type RemapAccountInput = z.infer<typeof RemapAccountInput>;

export const UpdateCounterpartyInput = z.object({
  counterpartyId: z.string().uuid(),
  name: z.string().trim().min(1).max(300).optional(),
  kind: z.enum(['customer', 'supplier', 'both', 'unknown']).optional(),
  defaultExpenseCategory: StandardCategorySchema.nullable().optional(),
  email: z.string().email().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCounterpartyInput = z.infer<typeof UpdateCounterpartyInput>;

export const MergeCounterpartiesInput = z
  .object({ fromId: z.string().uuid(), intoId: z.string().uuid() })
  .refine((v) => v.fromId !== v.intoId, {
    message: 'A customer cannot be merged into itself',
    path: ['intoId'],
  });
export type MergeCounterpartiesInput = z.infer<typeof MergeCounterpartiesInput>;

export const CreateBankAccountInput = z.object({
  name: z.string().trim().min(1).max(200),
  bankName: z.string().trim().min(1).max(200),
  // Masked at rest: the last four digits are all any metric needs, and all we are willing to hold.
  accountNumberMasked: z.string().trim().max(8).optional(),
  sortCodeMasked: z.string().trim().max(10).optional(),
  currency: z.string().length(3).default('GBP'),
  accountType: z.enum(['current', 'savings', 'credit_card', 'loan', 'other']).default('current'),
  ledgerAccountId: z.string().uuid().nullable().optional(),
});
export type CreateBankAccountInput = z.infer<typeof CreateBankAccountInput>;

export const SetOpeningBalanceInput = z
  .object({
    bankAccountId: z.string().uuid(),
    amount: MoneyStringSchema.nullable(),
    date: IsoDateSchema.nullable(),
  })
  .refine((v) => (v.amount === null) === (v.date === null), {
    message: 'An opening balance needs both an amount and a date',
    path: ['date'],
  });
export type SetOpeningBalanceInput = z.infer<typeof SetOpeningBalanceInput>;

export const SupersedeRecordInput = z.object({
  table: z.enum(['ledger_entries', 'bank_transactions', 'invoices', 'period_balances']),
  recordId: z.string().uuid(),
  replacementId: z.string().uuid(),
});
export type SupersedeRecordInput = z.infer<typeof SupersedeRecordInput>;

/** A page of records. Bounded so one call can never ask the database for an unbounded scan. */
export const PageInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type PageInput = z.infer<typeof PageInput>;
