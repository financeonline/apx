import 'server-only';
import { orgRowById } from '@/db/rls';
import type { Db } from '@/db/types';
import { setBatchValidation } from '@/core/db';
import { ConflictError, NotFound, ValidationError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import { parseMoney } from '@/core/money';
import { checkBatch } from '../domain/validate-rows';
import type { BatchIssue } from '../domain/pipeline-types';
import { listBatches, listBatchRows } from '../data/repository';
import { setStatementBalances } from './index';

/**
 * Typed statement balances, and the re-validation that makes them count (IMPORT_ENGINE.md §5.3,
 * §5.4; ADR-033; F-C-03; ADR-085).
 *
 * The parser could not read the printed balances, or the document was read by AI and has none the
 * gate may trust. The reviewer types the two figures from the page; the batch is then judged again
 * — the SAME `checkBatch` the pipeline ran, over the rows that will commit — and the result replaces
 * the batch's balance issues. Reconciled `pdf_text` rows become `verified` at commit; an AI-read
 * batch may commit once its pages are confirmed.
 *
 * One rule is the model's undoing (§5.4): when the typed pair equals what the model READ, and no
 * deterministic capture exists, the batch stays unreconciled and the page-wide tick is withheld —
 * balances copied from the model cannot vouch for rows the model produced.
 */

export type BalanceComparison = 'matches_ai' | 'differs_from_ai' | null;

export interface RevalidationResult {
  readonly reconciled: boolean;
  readonly comparison: BalanceComparison;
  readonly issues: readonly BatchIssue[];
}

const BALANCE_CODES = new Set(['IMP-BAL-006', 'IMP-BAL-007']);

export async function setStatementBalancesAndRevalidate(
  ctx: AccessContext,
  input: { readonly batchId: string; readonly opening: string; readonly closing: string },
): Promise<RevalidationResult> {
  assertCan(ctx, 'imports.review');
  if (!ctx.orgId) throw new NotFound();
  const db: Db = ctx.db;

  const batch = (await listBatches(db, ctx.orgId, { limit: 200, offset: 0 }, ctx.requestId)).find((b) => b.id === input.batchId);
  if (!batch) throw new NotFound();
  if (batch.targetTable !== 'bank_transactions') throw new ValidationError('Only a bank statement has balances to reconcile.');
  if (batch.status !== 'awaiting_review') throw new ConflictError('This batch is not open for review.');

  // 1. The typed pair, through the user-callable function (imports.review, audited as reviewer-entered).
  await setStatementBalances(db, { batchId: input.batchId, opening: input.opening, closing: input.closing }, ctx.requestId);

  // 2. The gate again, over the rows that will commit, in row order.
  const rows = await listBatchRows(db, ctx.orgId, input.batchId, {}, { limit: 5_000, offset: 0 }, ctx.requestId);
  const committable = rows
    .filter((r) => r.status === 'valid' || r.status === 'warning' || (r.status === 'duplicate' && r.reviewerDecision === 'keep'))
    .sort((a, b) => a.rowNumber - b.rowNumber);
  const liability = await liabilityAccount(db, ctx.orgId, batch.bankAccountId);

  const read = batch.extractionStats.balances_read ?? {};
  const copiedFromModel = batch.extractionMethod === 'pdf_claude'
    && read.opening !== undefined && read.closing !== undefined
    && sameMoney(read.opening, input.opening) && sameMoney(read.closing, input.closing);

  let balanceIssues: BatchIssue[];
  if (copiedFromModel) {
    balanceIssues = [{
      code: 'IMP-BAL-007', severity: 'warning',
      message: 'The balances entered are the ones the AI read, so they cannot vouch for the rows it read. The statement stays unreconciled; confirm each row against the page.',
      detail: { matches_ai_reading: true },
    }];
  } else {
    balanceIssues = checkBatch({
      targetTable: 'bank_transactions', importType: batch.importType,
      amounts: committable.map((r) => String(r.mappedData?.amount ?? '0')),
      openingBalance: input.opening, closingBalance: input.closing,
      balanceChain: committable.map((r) => (r.mappedData?.balance_after === undefined ? null : String(r.mappedData.balance_after))),
      liabilityAccount: liability,
    }).filter((i) => BALANCE_CODES.has(i.code));
  }

  // 3. Everything the pipeline found that was not about balances stays; the balance verdict is new.
  const kept = (await currentBatchIssues(db, ctx.orgId, input.batchId, ctx.requestId)).filter((i) => !BALANCE_CODES.has(i.code));
  const issues = [...kept, ...balanceIssues];
  await setBatchValidation(
    { userId: ctx.userId, requestId: ctx.requestId }, ctx.orgId, input.batchId,
    issues, [...(await requiredConfirmations(db, ctx.orgId, input.batchId, ctx.requestId))], { ...batch.rowCounts },
    { opening: input.opening, closing: input.closing },
  );

  const comparison: BalanceComparison = read.opening === undefined && read.closing === undefined
    ? null
    : copiedFromModel ? 'matches_ai' : 'differs_from_ai';
  return { reconciled: !balanceIssues.some((i) => BALANCE_CODES.has(i.code)), comparison, issues };
}

/** Typed against read: the same money, whatever the formatting. */
function sameMoney(a: string, b: string): boolean {
  return parseMoney(a).equals(parseMoney(b));
}

async function liabilityAccount(db: Db, orgId: string, bankAccountId: string | null): Promise<boolean> {
  if (!bankAccountId) return false;
  const type = (await orgRowById<{ account_type?: string }>(db, orgId, 'bank_accounts', bankAccountId))?.account_type;
  return type === 'credit_card' || type === 'loan';
}

async function currentBatchIssues(db: Db, orgId: string, batchId: string, _requestId?: string): Promise<BatchIssue[]> {
  return (await orgRowById<{ batch_issues?: BatchIssue[] }>(db, orgId, 'import_batches', batchId))?.batch_issues ?? [];
}

async function requiredConfirmations(db: Db, orgId: string, batchId: string, _requestId?: string): Promise<string[]> {
  return (await orgRowById<{ required_confirmations?: string[] }>(db, orgId, 'import_batches', batchId))?.required_confirmations ?? [];
}
