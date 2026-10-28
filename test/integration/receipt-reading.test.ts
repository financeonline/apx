import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { enqueueServerJob } from '@/core/db';
import { drainJobs, extractDeps } from '@/modules/jobs';
import { SUBMIT_RECEIPTS_TOOL, type ModelCall, type ModelResponse, type ModelTransport } from '@/modules/ai';
import { loadBatchReview, startImport } from '@/modules/imports';
import { globalRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, fs, rpc } from './setup';
import { auditsOf, makeOrg, rowOf, rowsOf, systemAccount } from './f-fixtures';

/**
 * Reading receipts with AI, end to end (SOW §8; ADR-150): a receipt photo goes in through the
 * wizard and WAITS; the reviewer names the expense account and asks; the job sends the FILE to a
 * SCRIPTED model, charges its page, and the receipts arrive as rows on that account that need a
 * human — then commit as `inferred` ledger entries, and only once the page is confirmed.
 */

// Each read drains the shared queue, which may hold other suites' jobs too.
vi.setConfig({ testTimeout: 180_000 });

const RUN = `rc${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.receipts.itest.motion`;
let ownerId: string;
let orgId: string;
let expenseAccount: string;
let incomeAccount: string;
const jobOf = async (id: string) => (await globalRow(fs(), 'jobs', id).get()).data() ?? {};
/** Cancels this organisation's queued jobs, as the suite's earlier refusals leave one behind. */
async function cancelQueued(): Promise<void> {
  const snap = await fs().collection('jobs').where('organization_id', '==', orgId).where('status', '==', 'queued').get();
  for (const d of snap.docs) await d.ref.update({ status: 'cancelled' });
}
const userDb = () => clientFor(ownerId, { email: `owner@${DOMAIN}` });

/** Enough of a JPEG for the magic-byte check; the scripted model never decodes it. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...new Array(200).fill(7), 0xff, 0xd9]);

const seen: ModelCall[] = [];
function scriptedReceipts(receipts: unknown[], over: Record<string, unknown> = {}): ModelTransport {
  return async (call: ModelCall): Promise<ModelResponse> => {
    seen.push(call);
    return {
      content: [{ type: 'tool_use', id: 'tu-r', name: SUBMIT_RECEIPTS_TOOL, caller: { type: 'direct' },
        input: { receipts, confidence: 'high', notes: [], ...over } } as ModelResponse['content'][number]],
      stopReason: 'tool_use', usage: { inputTokens: 900, outputTokens: 80 }, model: 'scripted',
    };
  };
}
const TWO = [
  { page: 1, index: 1, date: '2026-03-04', supplier: 'Ryman', description: 'Printer paper', total: '24.99', currency: 'GBP' },
  { page: 1, index: 2, date: '2026-03-09', supplier: 'Pret A Manger', total: '8.40' },
];

async function upload(name: string, importType: 'receipts' | 'general_ledger', variant = 0) {
  // A different last-but-one byte per variant: the same photo twice is (rightly) a duplicate upload.
  const bytes = JPEG.slice();
  bytes[bytes.length - 3] = variant;
  return startImport({
    organizationId: orgId, userId: ownerId, requestId: `itest-${RUN}`, db: userDb(),
    file: new File([bytes], name, { type: 'image/jpeg' }), importType,
    periodStart: '2026-03-01', periodEnd: '2026-03-31', bankAccountId: null,
  });
}
async function read(batchId: string, documentId: string, accountId: string) {
  const jobId = await enqueueServerJob({ userId: ownerId, requestId: `itest-${RUN}` }, {
    organizationId: orgId, jobType: 'document.extract', payload: { document_id: documentId, batch_id: batchId, account_id: accountId },
  });
  // A refused attempt goes back to the queue with a backoff, so the first recorded error is the
  // answer; waiting for a terminal state would only drain other suites' jobs off the shared queue.
  // (An enqueue while a job for the same file is queued merges into it, so "answered" is an attempt
  // made after this call, not any recorded error.)
  const attemptsBefore = Number((await jobOf(jobId)).attempts ?? 0);
  for (let round = 0; round < 12; round += 1) {
    const job = await jobOf(jobId);
    if (job.status !== 'running' && Number(job.attempts ?? 0) > attemptsBefore) break;
    if (['succeeded', 'failed', 'dead', 'deferred_upstream', 'cancelled'].includes(String(job.status))) break;
    await drainJobs(3);
  }
  const job = await jobOf(jobId);
  return { status: String(job.status ?? ''), error: String(job.last_error ?? '') };
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest Docs Receipts ${RUN}`);
  expenseAccount = await systemAccount(orgId, 'operating_expense');
  incomeAccount = await systemAccount(orgId, 'revenue');
});

afterAll(async () => {
  extractDeps.transport = undefined;
  // A refused read goes back to the queue: leave nothing for another suite's worker to pick up.
  const left = await fs().collection('jobs').where('organization_id', '==', orgId).where('status', '==', 'queued').get();
  for (const d of left.docs) await d.ref.update({ status: 'cancelled', updated_at: new Date().toISOString() });
  await deleteOrg(orgId);
});

describe('a receipt photo', () => {
  let batchId: string;
  let documentId: string;

  it('is refused for any import but Receipts, before anything is stored', async () => {
    await expect(upload('till.jpg', 'general_ledger')).rejects.toThrow(/Photos can be imported as receipts or single invoices only/);
    expect(await rowsOf(orgId, 'source_documents')).toHaveLength(0);
  });

  it('is stored as a receipt and waits to be read — nothing is sent anywhere yet', async () => {
    const result = await upload('till.jpg', 'receipts');
    batchId = result.batchId;
    documentId = result.documentId;
    expect(result.parseFailure).toMatch(/Read receipts with AI/);
    const doc = (await rowOf(orgId, 'source_documents', documentId))!;
    expect(`${doc.status}|${doc.document_kind}|${doc.mime_type}`).toBe('ready|receipt|image/jpeg');
    const b = (await rowOf(orgId, 'import_batches', batchId))!;
    expect(`${b.status}|${b.extraction_method}`).toBe('failed|pdf_text');
    expect(await auditsOf(orgId, 'document.sent_to_ai')).toHaveLength(0);
  });

  it('is not read while AI reading is off, nor into an account that is not an expense', async () => {
    extractDeps.transport = scriptedReceipts(TWO);
    expect((await read(batchId, documentId, expenseAccount)).error).toMatch(/not enabled/);
    await cancelQueued();
    const org = (await globalRow(fs(), 'organizations', orgId).get()).data()!;
    await globalRow(fs(), 'organizations', orgId).update({ features: { ...(org.features ?? {}), ai_pdf_extraction: true } });
    expect((await read(batchId, documentId, incomeAccount)).error).toMatch(/expense accounts/);
    await cancelQueued();
    expect(seen).toHaveLength(0);
  });

  it('sends the FILE, charges its page, and leaves receipts on the chosen account that need a human', async () => {
    extractDeps.transport = scriptedReceipts(TWO);
    const { status, error } = await read(batchId, documentId, expenseAccount);
    expect(status, error).toBe('succeeded');
    // The model was handed the image itself, as the consent line says.
    const content = seen.at(-1)!.messages[0]!.content as Array<{ type: string; source?: { media_type?: string } }>;
    expect(content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg' } });
    const [sent] = await auditsOf(orgId, 'document.sent_to_ai');
    expect((sent?.metadata as Record<string, unknown> | undefined)?.file_sent).toBe(true);
    const charged = await fs().collection('api_rate_limits').where('actor_user_id', '==', orgId)
      .where('bucket', '==', 'ai_extraction_page').get();
    expect(charged.docs.reduce((t, d) => t + Number(d.get('count') ?? 0), 0)).toBe(1);
    const b = (await rowOf(orgId, 'import_batches', batchId))!;
    expect(`${b.extraction_method}|${b.status}`).toBe('pdf_claude|awaiting_review');

    const review = (await loadBatchReview(userDb(), orgId, batchId))!;
    const rows = review.rows.filter((r) => r.status !== 'skipped');
    expect(rows.map((r) => [r.sourceRef, r.mappedData?.entry_date, r.mappedData?.description])).toEqual([
      ['page:1;line:1', '2026-03-04', 'Ryman — Printer paper'],
      ['page:1;line:2', '2026-03-09', 'Pret A Manger'],
    ]);
    expect(rows.every((r) => r.mappedData?.account_id === expenseAccount)).toBe(true);
    expect(rows.every((r) => r.issues.some((i) => i.code === 'IMP-PDF-001'))).toBe(true);
    expect(review.committable).toBe(false);
    expect(review.unconfirmedPages).toEqual([1]);
  });

  it('commits as AI-read ledger entries on that account — only after the page is confirmed', async () => {
    const before = await rpc(userDb(), 'commit_import_batch', { p_batch: batchId });
    expect(before.error?.message ?? '').toMatch(/page|confirm/i);
    const confirmed = await rpc(userDb(), 'confirm_pdf_page', { p_batch: batchId, p_page: 1 });
    expect(confirmed.error).toBeNull();
    // The ordinary import confirmation every batch has: the period the file covers (ADR-047.6).
    expect((await loadBatchReview(userDb(), orgId, batchId))!.requiredConfirmations).toEqual(['IMP-RANGE-015']);
    const range = await rpc(userDb(), 'record_batch_confirmation', {
      p_batch: batchId, p_code: 'IMP-RANGE-015', p_value: { period_start: '2026-03-01', period_end: '2026-03-31' },
    });
    expect(range.error).toBeNull();
    const commit = await rpc(userDb(), 'commit_import_batch', { p_batch: batchId });
    expect(commit.error, commit.error?.message).toBeNull();
    const entries = (await rowsOf(orgId, 'ledger_entries')).sort((a, b) => String(a.entry_date).localeCompare(String(b.entry_date)));
    expect(entries.map((e) => `${e.amount}|${e.direction}|${e.account_id}|${e.record_status}`).join(','))
      .toBe(`24.99|debit|${expenseAccount}|accepted,8.40|debit|${expenseAccount}|accepted`);
    // Read by AI, so never more than `inferred` (CD-11), however carefully it was confirmed.
    const mine = await rowsOf(orgId, 'ledger_entries', { import_batch_id: batchId });
    expect([...new Set(mine.map((e) => e.assurance_level))].join(',')).toBe('inferred');
  });
});

describe('what the model may not do', () => {
  it('answer for a page the file does not have: retried, then the batch says it could not be read', async () => {
    const r = await upload('second.jpg', 'receipts', 1);
    extractDeps.transport = scriptedReceipts([{ ...TWO[0], page: 2 }]);
    const { status, error } = await read(r.batchId, r.documentId, expenseAccount);
    expect(status).not.toBe('succeeded');
    expect(error).toMatch(/could not be read by AI/);
  });
});
