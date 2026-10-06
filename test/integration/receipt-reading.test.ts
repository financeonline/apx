import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueServerJob } from '@/core/db';
import { drainJobs, extractDeps } from '@/modules/jobs';
import { SUBMIT_RECEIPTS_TOOL, type ModelCall, type ModelResponse, type ModelTransport } from '@/modules/ai';
import { loadBatchReview, startImport } from '@/modules/imports';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * Reading receipts with AI, end to end (SOW §8; ADR-150): a receipt photo goes in through the
 * wizard and WAITS; the reviewer names the expense account and asks; the job sends the FILE to a
 * SCRIPTED model, charges its page, and the receipts arrive as rows on that account that need a
 * human — then commit as `inferred` ledger entries, and only once the page is confirmed.
 */

const RUN = `rc${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.receipts.itest`;
let ownerId: string;
let orgId: string;
let expenseAccount: string;
let incomeAccount: string;
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).split('\n')[0]?.trim() ?? '';
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
  const status = await drainUntilFinished(drainJobs, jobId);
  return { status, error: adminSql(`select coalesce(last_error, '') from public.jobs where id = '${jobId}'`).trim() };
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Receipts ${RUN}` });
  if (created.error) throw new Error(created.error.message);
  orgId = created.data as unknown as string;
  expenseAccount = one(`select id from public.accounts where organization_id = '${orgId}' and standard_category = 'operating_expense' and is_system limit 1`);
  incomeAccount = one(`select id from public.accounts where organization_id = '${orgId}' and standard_category = 'revenue' and is_system limit 1`);
});

afterAll(() => {
  extractDeps.transport = undefined;
  adminSql(`delete from public.organizations where name like 'ITest Receipts%${RUN}';
            delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('a receipt photo', () => {
  let batchId: string;
  let documentId: string;

  it('is refused for any import but Receipts, before anything is stored', async () => {
    await expect(upload('till.jpg', 'general_ledger')).rejects.toThrow(/Photos can be imported as receipts only/);
    expect(one(`select count(*) from public.source_documents where organization_id = '${orgId}'`)).toBe('0');
  });

  it('is stored as a receipt and waits to be read — nothing is sent anywhere yet', async () => {
    const result = await upload('till.jpg', 'receipts');
    batchId = result.batchId;
    documentId = result.documentId;
    expect(result.parseFailure).toMatch(/Read receipts with AI/);
    expect(one(`select status::text || '|' || document_kind::text || '|' || mime_type from public.source_documents where id = '${documentId}'`)).toBe('ready|receipt|image/jpeg');
    expect(one(`select status::text || '|' || extraction_method::text from public.import_batches where id = '${batchId}'`)).toBe('failed|pdf_text');
    expect(one(`select count(*) from public.audit_events where organization_id = '${orgId}' and action = 'document.sent_to_ai'`)).toBe('0');
  });

  it('is not read while AI reading is off, nor into an account that is not an expense', async () => {
    extractDeps.transport = scriptedReceipts(TWO);
    expect((await read(batchId, documentId, expenseAccount)).error).toMatch(/not enabled/);
    adminSql(`update public.jobs set status = 'cancelled' where organization_id = '${orgId}' and status = 'queued'`);
    adminSql(`update public.organizations set features = features || '{"ai_pdf_extraction": true}'::jsonb where id = '${orgId}'`);
    expect((await read(batchId, documentId, incomeAccount)).error).toMatch(/expense accounts/);
    adminSql(`update public.jobs set status = 'cancelled' where organization_id = '${orgId}' and status = 'queued'`);
    expect(seen).toHaveLength(0);
  });

  it('sends the FILE, charges its page, and leaves receipts on the chosen account that need a human', async () => {
    extractDeps.transport = scriptedReceipts(TWO);
    const { status, error } = await read(batchId, documentId, expenseAccount);
    expect(status, error).toBe('succeeded');
    // The model was handed the image itself, as the consent line says.
    const content = seen.at(-1)!.messages[0]!.content as Array<{ type: string; source?: { media_type?: string } }>;
    expect(content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg' } });
    expect(one(`select metadata ->> 'file_sent' from public.audit_events where organization_id = '${orgId}' and action = 'document.sent_to_ai'`)).toBe('true');
    expect(Number(adminSql(`select coalesce(sum(count), 0) from public.api_rate_limits where actor_user_id = '${orgId}' and bucket = 'ai_extraction_page'`))).toBe(1);
    expect(one(`select extraction_method::text || '|' || status::text from public.import_batches where id = '${batchId}'`)).toBe('pdf_claude|awaiting_review');

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
    const before = await userDb().schema('api').rpc('commit_import_batch', { p_batch: batchId });
    expect(before.error?.message ?? '').toMatch(/page|confirm/i);
    const confirmed = await userDb().schema('api').rpc('confirm_pdf_page', { p_batch: batchId, p_page: 1 });
    expect(confirmed.error).toBeNull();
    // The ordinary import confirmation every batch has: the period the file covers (ADR-047.6).
    expect((await loadBatchReview(userDb(), orgId, batchId))!.requiredConfirmations).toEqual(['IMP-RANGE-015']);
    const range = await userDb().schema('api').rpc('record_batch_confirmation', {
      p_batch: batchId, p_code: 'IMP-RANGE-015', p_value: { period_start: '2026-03-01', period_end: '2026-03-31' },
    });
    expect(range.error).toBeNull();
    const commit = await userDb().schema('api').rpc('commit_import_batch', { p_batch: batchId });
    expect(commit.error, commit.error?.message).toBeNull();
    expect(adminSql(`select string_agg(amount::text || '|' || direction::text || '|' || account_id::text || '|' || record_status::text, ',' order by entry_date)
      from public.ledger_entries where organization_id = '${orgId}'`).trim())
      .toBe(`24.99|debit|${expenseAccount}|accepted,8.40|debit|${expenseAccount}|accepted`);
    // Read by AI, so never more than `inferred` (CD-11), however carefully it was confirmed.
    expect(adminSql(`select string_agg(distinct assurance_level::text, ',') from public.ledger_entries where import_batch_id = '${batchId}'`).trim()).toBe('inferred');
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
