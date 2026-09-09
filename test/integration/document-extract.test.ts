import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { enqueueServerJob } from '@/core/db';
import { drainJobs, extractDeps } from '@/modules/jobs';
import { SUBMIT_PAGE_TOOL, type ModelCall, type ModelResponse, type ModelTransport } from '@/modules/ai';
import { loadBatchReview, startImport } from '@/modules/imports';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * Claude-assisted extraction, end to end (IMPORT_ENGINE.md §5.4; ADR-033; ADR-084; CD-11): a
 * text-layer PDF whose layout no grammar knows goes in through the wizard and fails; the reviewer
 * asks for AI reading; the job reads each page through a SCRIPTED model that returns the rows the
 * page really shows; the rows arrive as `inferred`, `needs_review`, `IMP-PDF-001`, per page, and
 * the batch cannot commit until the pages are confirmed and the balances typed.
 */

const RUN = `dx${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.extract.itest`;

let ownerId: string;
let orgId: string;
let bankAccountId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);
const userDb = () => clientFor(ownerId, { email: `owner@${DOMAIN}` });

/** A two-page statement in a layout no §5.3 grammar knows: "When | What | How much | Left". */
async function oddLayoutPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages: string[][] = [
    ['Statement for March 2026', 'When   What   How much   Left', '2026-03-01 TESCO STORES -5.00 995.00', '2026-03-02 SALARY ACME LTD 573.37 1568.37', 'Carried forward 1568.37'],
    ['Brought forward 1568.37', 'When   What   How much   Left', '2026-03-05 BRITISH GAS -67.38 1500.99', 'Closing balance 1500.99'],
  ];
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    lines.forEach((text, i) => page.drawText(text, { x: 50, y: 790 - i * 18, size: 10, font }));
  }
  return doc.save();
}

/** A model that reads the page text it is given and returns the dated lines as rows. */
function scriptedReader(): ModelTransport {
  return async (call: ModelCall): Promise<ModelResponse> => {
    const text = JSON.stringify(call.messages[0]?.content ?? '');
    const pageNumber = Number(/Page (\d+)\./.exec(text)?.[1] ?? '1');
    const inner = /<document_text>([\s\S]*?)<\/document_text>/.exec(text)?.[1] ?? '';
    const lines = inner.replace(/\\n/g, '\n').split('\n');
    const rows = lines.flatMap((line, index) => {
      const m = /^(\d{4}-\d{2}-\d{2}) (.+?) (-?\d+\.\d{2}) (\d+\.\d{2})$/.exec(line.trim());
      return m ? [{ line: index + 1, date: m[1], description: m[2], amount: m[3], balance: m[4] }] : [];
    });
    const closing = /Closing balance (\d+\.\d{2})/.exec(inner)?.[1];
    return {
      content: [{ type: 'tool_use', id: `tu-${pageNumber}`, name: SUBMIT_PAGE_TOOL, caller: { type: 'direct' },
        input: { page: pageNumber, rows, confidence: 'high', notes: [], ...(closing ? { closingBalanceRead: closing } : {}) } } as ModelResponse['content'][number]],
      stopReason: 'tool_use', usage: { inputTokens: 500, outputTokens: 120 }, model: 'scripted',
    };
  };
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Extract ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  bankAccountId = one(`
    insert into public.bank_accounts (organization_id, name, account_type, bank_name, account_number_masked, is_active)
    values ('${orgId}', 'Current', 'current', 'Test Bank', '****1234', true) returning id`);
});

afterAll(() => {
  extractDeps.transport = undefined;
  adminSql(`
    delete from public.organizations where name like 'ITest Extract%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('a PDF the deterministic parser could not read', () => {
  let batchId: string;
  let documentId: string;

  it('is stored and its batch failed, so the reviewer has somewhere to ask for AI reading', async () => {
    const bytes = await oddLayoutPdf();
    const result = await startImport({
      organizationId: orgId, userId: ownerId, requestId: `itest-${RUN}`, db: userDb(),
      file: new File([new Uint8Array(bytes)], 'odd.pdf', { type: 'application/pdf' }), importType: 'bank_statement',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', bankAccountId,
    });
    batchId = result.batchId;
    documentId = result.documentId;
    expect(result.parseFailure).toMatch(/could not find a transaction table/);
    expect(one(`select has_text_layer::text from public.source_documents where id = '${documentId}'`)).toBe('true');
  });

  it('refuses AI reading while the organisation has not enabled it (CD-35)', async () => {
    extractDeps.transport = scriptedReader();
    const jobId = await enqueueServerJob({ userId: ownerId, requestId: `itest-${RUN}` }, {
      organizationId: orgId, jobType: 'document.extract', payload: { document_id: documentId, batch_id: batchId },
    });
    expect(await drainUntilFinished(drainJobs, jobId)).not.toBe('succeeded');
    expect(adminSql(`select last_error from public.jobs where id = '${jobId}'`)).toMatch(/not enabled/);
    expect(adminSql(`select count(*) from public.audit_events where organization_id = '${orgId}' and action = 'document.sent_to_ai'`)).toBe('0');
    adminSql(`update public.jobs set status = 'cancelled' where id = '${jobId}'`);
  });

  it('reads every page as the reviewer, charges each page, and leaves rows that need a human', async () => {
    adminSql(`update public.organizations set features = features || '{"ai_pdf_extraction": true}'::jsonb where id = '${orgId}'`);
    extractDeps.transport = scriptedReader();
    const jobId = await enqueueServerJob({ userId: ownerId, requestId: `itest-${RUN}` }, {
      organizationId: orgId, jobType: 'document.extract', payload: { document_id: documentId, batch_id: batchId },
    });
    expect(await drainUntilFinished(drainJobs, jobId), adminSql(`select coalesce(last_error, '-') from public.jobs where id = '${jobId}'`)).toBe('succeeded');

    const batch = one(`
      select b.extraction_method::text || '|' || b.status::text || '|' || b.pages_extracted || '|' || (b.extraction_stats ->> 'tokens_in') || '|' || (b.extraction_stats -> 'balances_read' ->> 'closing') || '|' || coalesce(b.statement_closing_balance::text, 'null')
        from public.import_batches b where b.id = '${batchId}'`);
    // Two pages read, 1,000 input tokens, the closing balance the model READ kept aside, the gate's column untouched.
    expect(batch).toBe('pdf_claude|awaiting_review|2|1000|1500.99|null');
    expect(adminSql(`select count(*) from public.audit_events where organization_id = '${orgId}' and action = 'document.sent_to_ai' and actor_user_id = '${ownerId}'`)).toBe('1');
    // ADR-033: every page attempt is charged on the organisation's daily counter.
    expect(Number(adminSql(`select coalesce(sum(count), 0) from public.api_rate_limits where actor_user_id = '${orgId}' and bucket = 'ai_extraction_page'`))).toBe(2);

    const review = (await loadBatchReview(userDb(), orgId, batchId))!;
    const rows = review.rows.filter((r) => r.status !== 'skipped');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.sourcePage)).toEqual([1, 1, 2]);
    expect(rows.every((r) => /^page:\d+;line:\d+$/.test(r.sourceRef ?? ''))).toBe(true);
    expect(rows.every((r) => r.issues.some((i) => i.code === 'IMP-PDF-001'))).toBe(true);
    expect(rows.every((r) => r.status === 'warning')).toBe(true);
    // No deterministic balances and nothing typed: the gate blocks commit in its own words.
    expect(review.committable).toBe(false);
    expect(review.batchIssues.map((i) => i.code)).toContain('IMP-BAL-007');
  });

  it('will not commit while a page read by AI is unconfirmed, whatever the browser says', async () => {
    const { error } = await userDb().schema('api').rpc('commit_import_batch', { p_batch: batchId });
    expect(error?.message ?? '').toMatch(/page|confirm|balance/i);
  });
});
