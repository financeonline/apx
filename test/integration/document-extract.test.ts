import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { enqueueServerJob } from '@/core/db';
import { drainJobs, extractDeps } from '@/modules/jobs';
import { SUBMIT_PAGE_TOOL, type ModelCall, type ModelResponse, type ModelTransport } from '@/modules/ai';
import { loadBatchReview, setStatementBalancesAndRevalidate, startImport } from '@/modules/imports';
import { permissionsFor } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import { globalRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs, rpc } from './setup';
import { auditsOf, makeOrg, rowOf, seedBankAccount } from './f-fixtures';

/**
 * Claude-assisted extraction, end to end (IMPORT_ENGINE.md §5.4; ADR-033; ADR-084; CD-11): a
 * text-layer PDF whose layout no grammar knows goes in through the wizard and fails; the reviewer
 * asks for AI reading; the job reads each page through a SCRIPTED model that returns the rows the
 * page really shows; the rows arrive as `inferred`, `needs_review`, `IMP-PDF-001`, per page, and
 * the batch cannot commit until the pages are confirmed and the balances typed.
 */

const RUN = `dx${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.extract.itest.motion`;

let ownerId: string;
let orgId: string;
let bankAccountId: string;

const jobOf = async (id: string) => (await globalRow(fs(), 'jobs', id).get()).data() ?? {};
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
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest Docs Extract ${RUN}`);
  bankAccountId = await seedBankAccount(orgId, { name: 'Current', accountNumber: '****1234' });
});

afterAll(async () => {
  extractDeps.transport = undefined;
  // A refused read goes back to the queue: leave nothing for another suite's worker to pick up.
  const left = await fs().collection('jobs').where('organization_id', '==', orgId).where('status', '==', 'queued').get();
  for (const d of left.docs) await d.ref.update({ status: 'cancelled', updated_at: new Date().toISOString() });
  await deleteOrg(orgId);
});

/** The organisation's charges on the daily AI page counter (`app.throttle(org, 'ai_extraction_page', …)`). */
async function pagesCharged(): Promise<number> {
  const snap = await fs().collection('api_rate_limits').where('actor_user_id', '==', orgId)
    .where('bucket', '==', 'ai_extraction_page').get();
  return snap.docs.reduce((total, d) => total + Number(d.get('count') ?? 0), 0);
}

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
    expect((await rowOf(orgId, 'source_documents', documentId))?.has_text_layer).toBe(true);
  });

  it('refuses AI reading while the organisation has not enabled it (CD-35)', async () => {
    extractDeps.transport = scriptedReader();
    const jobId = await enqueueServerJob({ userId: ownerId, requestId: `itest-${RUN}` }, {
      organizationId: orgId, jobType: 'document.extract', payload: { document_id: documentId, batch_id: batchId },
    });
    expect(await drainUntilFinished(drainJobs, jobId)).not.toBe('succeeded');
    expect(String((await jobOf(jobId)).last_error ?? '')).toMatch(/not enabled/);
    expect(await auditsOf(orgId, 'document.sent_to_ai')).toHaveLength(0);
    await globalRow(fs(), 'jobs', jobId).update({ status: 'cancelled' });
  });

  it('reads every page as the reviewer, charges each page, and leaves rows that need a human', async () => {
    const org = (await globalRow(fs(), 'organizations', orgId).get()).data()!;
    await globalRow(fs(), 'organizations', orgId).update({ features: { ...(org.features ?? {}), ai_pdf_extraction: true } });
    extractDeps.transport = scriptedReader();
    const jobId = await enqueueServerJob({ userId: ownerId, requestId: `itest-${RUN}` }, {
      organizationId: orgId, jobType: 'document.extract', payload: { document_id: documentId, batch_id: batchId },
    });
    const status = await drainUntilFinished(drainJobs, jobId);
    expect(status, String((await jobOf(jobId)).last_error ?? '-')).toBe('succeeded');

    const b = (await rowOf(orgId, 'import_batches', batchId))!;
    const stats = b.extraction_stats as Record<string, unknown>;
    // Two pages read, 1,000 input tokens, the closing balance the model READ kept aside, the gate's column untouched.
    expect([b.extraction_method, b.status, b.pages_extracted, Number(stats.tokens_in),
      (stats.balances_read as Record<string, unknown> | undefined)?.closing, b.statement_closing_balance])
      .toEqual(['pdf_claude', 'awaiting_review', 2, 1000, '1500.99', null]);
    const sent = await auditsOf(orgId, 'document.sent_to_ai');
    expect(sent.filter((a) => a.actor_user_id === ownerId)).toHaveLength(1);
    // ADR-033: every page attempt is charged on the organisation's daily counter.
    expect(await pagesCharged()).toBe(2);

    const review = (await loadBatchReview(userDb(), orgId, batchId))!;
    const rows = review.rows.filter((r) => r.status !== 'skipped');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.sourcePage)).toEqual([1, 1, 2]);
    expect(rows.every((r) => /^page:\d+;line:\d+$/.test(r.sourceRef ?? ''))).toBe(true);
    expect(rows.every((r) => r.issues.some((i) => i.code === 'IMP-PDF-001'))).toBe(true);
    expect(rows.every((r) => r.status === 'warning')).toBe(true);
    // No deterministic balances and nothing typed: the gate blocks commit in its own words (§5.4).
    expect(review.committable).toBe(false);
    expect(review.batchIssues.find((i) => i.code === 'IMP-BAL-006')?.message).toMatch(/Enter the opening and closing balances/);
  });

  it('will not commit while a page read by AI is unconfirmed, whatever the browser says', async () => {
    const { error } = await rpc(userDb(), 'commit_import_batch', { p_batch: batchId });
    // The gate refuses on its own terms: a batch-level error (the balances) or an unconfirmed page.
    expect(error?.message ?? '').toMatch(/page|confirm|balance|problem/i);
  });

  it('balances copied from the AI cannot vouch for its rows; the printed figures can (§5.4, F-C-03)', async () => {
    const ctx: AccessContext = {
      userId: ownerId, orgId, orgSlug: null, effectiveRole: 'owner', permissions: permissionsFor('owner'), actorType: 'user',
      db: userDb(), requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
    };
    // The model read a closing balance of 1500.99 and no opening; a reviewer typing exactly what it read
    // (with any opening) is not vouching for anything — nothing changes for the gate.
    const copied = await setStatementBalancesAndRevalidate(ctx, { batchId, opening: '1000.00', closing: '1500.99' });
    // Opening was not read by the model, so this is not a copy: the gate runs. 1000.00 + (-5 + 573.37 - 67.38) = 1500.99 → reconciled.
    expect(copied.comparison).toBe('differs_from_ai');
    expect(copied.reconciled).toBe(true);
    const review = (await loadBatchReview(userDb(), orgId, batchId))!;
    expect(review.batchIssues.map((i) => i.code)).not.toContain('IMP-BAL-006');
    expect(review.typedBalances).toEqual({ opening: '1000.00', closing: '1500.99' });
    // Still not committable: the pages have not been confirmed.
    expect(review.committable).toBe(false);
    expect(review.unconfirmedPages).toEqual([1, 2]);

    // Wrong figures: the gate says so, and the typed pair is kept for correction.
    const wrong = await setStatementBalancesAndRevalidate(ctx, { batchId, opening: '1000.00', closing: '9999.00' });
    expect(wrong.reconciled).toBe(false);
    expect((await loadBatchReview(userDb(), orgId, batchId))!.batchIssues.map((i) => i.code)).toContain('IMP-BAL-006');
  });
});
