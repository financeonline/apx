import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { loadBatchReview, setStatementBalancesAndRevalidate, startImport } from '@/modules/imports';
import { permissionsFor } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import { orgRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, fs } from './setup';
import { makeOrg, seedBankAccount } from './f-fixtures';
import { where } from './i-fixtures';

/**
 * The import wizard, end to end (IMPORT_ENGINE.md §2–§11).
 *
 * A real bank statement — preamble lines, a header MOTION has to find, money in and out in separate
 * columns — goes in as bytes and comes out as `bank_transactions`, through the same service the
 * upload screen calls. Until this existed there was no way for data to enter the product through
 * the interface at all (ADR-058).
 *
 * The properties under test are the ones the engine's promise rests on:
 *   - every non-empty source line becomes a row, including the ones that will never commit;
 *   - the batch is not committable until every question it raised has been answered;
 *   - committing writes the records and queues a recalculation.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `w${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.wizard.itest.motion`;

let ownerId: string;
let orgId: string;
let bankAccountId: string;

/** How many batches were started from documents with this file name. */
async function batchesFor(filename: string): Promise<number> {
  const docs = await where(orgId, 'source_documents', { original_filename: filename });
  let n = 0;
  for (const d of docs) n += (await where(orgId, 'import_batches', { source_document_id: d.id })).length;
  return n;
}

/** The owner's own client — what every read in the app runs under. */
const userDb = () => clientFor(ownerId, { email: `owner@${DOMAIN}` });

function fixtureFile(name: string, mime = 'text/csv'): File {
  const bytes = readFileSync(`fixtures/imports/${name}`);
  return new File([new Uint8Array(bytes)], name, { type: mime });
}

async function runWizard(file: File, importType = 'bank_statement', account = bankAccountId) {
  return startImport({
    organizationId: orgId,
    userId: ownerId,
    requestId: `itest-${RUN}`,
    /*
     * The CALLER's client, exactly as the page passes `ctx.db`.
     *
     * `api.*` is granted to `authenticated` and not to `service_role` (ADR-043): the user-intent
     * surface is meant to be reached with a user's own token, so RLS and the api functions' own
     * permission checks are the things deciding. A service-role client cannot even see the schema.
     */
    db: clientFor(ownerId, { email: `owner@${DOMAIN}` }),
    file,
    importType: importType as 'bank_statement',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    bankAccountId: importType === 'bank_statement' ? account : null,
  });
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest Wizard ${RUN}`);
  bankAccountId = await seedBankAccount(orgId, { name: 'Business Current', bankName: 'Test Bank', accountNumber: '****1234' });
}, 60_000);

afterAll(async () => {
  const jobs = await fs().collection('jobs').where('organization_id', '==', orgId).get();
  await Promise.all(jobs.docs.map((d) => d.ref.delete()));
  await deleteOrg(orgId);
});

describe('a statement goes in through the wizard', () => {
  let batchId: string;

  it('uploads, parses and validates in one call', async () => {
    const result = await runWizard(fixtureFile('csv-with-preamble.csv'));
    batchId = result.batchId;

    expect(result.documentId).toMatch(/^[0-9a-f-]{36}$/);
    // The header was found past the preamble, so nobody is asked to confirm it (§5.1).
    expect(result.headerConfirmationRequired).toBe(false);
    // The synonym table recognised the statement's columns without a human mapping them (§6.3).
    expect(Object.values(result.columnMap)).toContain('transaction_date');
    expect(Object.values(result.columnMap)).toContain('description');
  });

  it('kept every source line as a row, including any that cannot import (SOW §23)', async () => {
    const rows = (await where(orgId, 'import_rows', { batch_id: batchId })).length;

    const sourceLines = readFileSync('fixtures/imports/csv-with-preamble.csv', 'utf8')
      .split('\n').filter((line) => line.trim() !== '').length;

    /*
     * Every non-empty line, and no more. The preamble lines above the header are rows too — §5.2
     * records them as `IMP-ROW-005` rather than dropping them — which is the whole point: a reviewer
     * can see that MOTION read the file's first four lines and decided they were not transactions.
     */
    expect(rows).toBe(sourceLines);
  });

  it('marked the preamble as unusable rather than discarding it (§5.2)', async () => {
    const statuses = [...new Set((await where(orgId, 'import_rows', { batch_id: batchId })).map((r) => String(r.status)))].sort().join(',');
    // At least one row is not importable, and it is on the screen with its reason.
    expect(statuses).toMatch(/error|warning/);
  });

  it('shows the reviewer what it found, grouped', async () => {
    const review = await loadBatchReview(userDb(), orgId, batchId);
    expect(review).not.toBeNull();
    expect(review!.filename).toBe('csv-with-preamble.csv');
    expect(review!.rows.length).toBeGreaterThan(0);
    // Every issue group carries a count and examples, so a large messy file stays reviewable.
    for (const group of review!.issueGroups) {
      expect(group.rowCount).toBeGreaterThan(0);
      expect(group.examples.length).toBeGreaterThan(0);
    }
  });

  it('says why it cannot be committed, rather than offering a button that fails', async () => {
    const review = await loadBatchReview(userDb(), orgId, batchId);
    if (!review!.committable) {
      expect(review!.blockingReason, 'a blocked batch always says why').not.toBeNull();
      expect(review!.blockingReason!.length).toBeGreaterThan(10);
    }
  });
});

/**
 * The single-signed-column statement (§6.4, ADR-028, catalogue item 6).
 *
 * `bank_positive_out.csv` and `bank_signed.csv` are byte-identical in shape and opposite in
 * meaning: one column of signed amounts, where a purchase is positive on a card and negative on a
 * current account. Nothing in the file says which, so reading it under the wrong convention turns
 * every payment into a receipt. §6.4 gives a default for card and loan accounts only.
 */
describe('a statement with one signed amount column', () => {
  const expectedAmounts = (fixture: string): string[] => JSON.parse(
    readFileSync(`fixtures/imports/${fixture}.expected.json`, 'utf8'),
  ).amountsAfterTransform as string[];

  /*
   * The amounts of the rows that would actually commit.
   *
   * §5.2 makes EVERY non-empty source line a row, the header line included, so this filters by
   * status rather than taking the column wholesale — and `headerRow` below asserts that the header
   * line is one of the ones held back, rather than quietly becoming a transaction.
   */
  const amountsOf = async (batchId: string): Promise<string[]> => (await where(orgId, 'import_rows', { batch_id: batchId }))
    .filter((r) => (r.status === 'valid' || r.status === 'warning') && r.mapped_data?.amount != null)
    .sort((a, b) => Number(a.row_number) - Number(b.row_number))
    .map((r) => String(r.mapped_data.amount));

  /** The status the file's own header line was given. */
  const headerRowStatus = async (batchId: string): Promise<string> => (await where(orgId, 'import_rows', { batch_id: batchId }))
    .filter((r) => r.mapped_data?.amount === 'Amount').map((r) => String(r.status)).join(',');

  it('negates a card export, because on a card a purchase is money going out (ADR-028)', async () => {
    const cardId = await seedBankAccount(orgId, { name: 'Company Card', type: 'credit_card', bankName: 'Test Bank', accountNumber: '****9911' });

    const result = await runWizard(fixtureFile('bank_positive_out.csv'), 'bank_statement', cardId);
    expect(await amountsOf(result.batchId)).toEqual(expectedAmounts('bank_positive_out'));

    /*
     * The header line reached the sign transform as data, carrying the literal text "Amount" in
     * the money column. It becomes ONE held-back row; before ADR-058.5 it threw, and the whole
     * import died on its first line.
     */
    expect(await headerRowStatus(result.batchId)).toMatch(/error|skipped/);
  });

  it('refuses the same shape on a current account rather than guessing', async () => {
    await expect(runWizard(fixtureFile('bank_signed.csv')))
      .rejects.toThrow(/single amount column/);
  });

  it('left nothing behind when it refused', async () => {
    const batches = await batchesFor('bank_signed.csv');
    expect(batches, 'a question nobody answered started no batch').toBe(0);
  });

  it('needs no answer at all when the file has separate money-in and money-out columns', async () => {
    const result = await runWizard(fixtureFile('bank_out_in_columns.csv'));
    expect(await amountsOf(result.batchId)).toEqual(expectedAmounts('bank_out_in_columns'));
  });
});

describe('the same file twice is caught before it is parsed (§2.5)', () => {
  it('blocks the identical file and points at the earlier import', async () => {
    /*
     * A SHA-256 match is not a "possible duplicate" needing a reviewer's judgement — it is the same
     * bytes, and importing them twice could only ever be a mistake. The row-level duplicate check
     * (§9) is for a DIFFERENT file whose rows overlap, which is the case that needs a decision.
     */
    await expect(runWizard(fixtureFile('csv-with-preamble.csv')))
      .rejects.toThrow(/already been uploaded/);
  });

  it('leaves no second batch behind when it refuses', async () => {
    const batches = await batchesFor('csv-with-preamble.csv');
    expect(batches, 'the refused upload started nothing').toBe(1);
  });
});

describe('a file MOTION cannot read is refused before anything is stored', () => {
  it('refuses a PDF renamed .csv by its magic bytes (§4)', async () => {
    // The bytes are a PDF; the NAME says CSV. The extension and the bytes disagree, and the bytes win.
    const renamed = new File([new Uint8Array(readFileSync('fixtures/imports/fake_csv.pdf'))], 'fake_csv.csv', { type: 'text/csv' });
    await expect(runWizard(renamed)).rejects.toThrow(/not a CSV file/);

    // Nothing was stored, and no batch was started, so there is no orphan to clean up.
    expect(await batchesFor('fake_csv.csv')).toBe(0);
  });

});

/**
 * PDF statements (IMPORT_ENGINE.md §5.3, §5.5; ADR-033; ADR-083). The deterministic parser was built
 * and tested on its own; this is the wizard USING it: a text-layer statement becomes a `pdf_text`
 * batch whose rows point at their page and line, a scan is stored and refused with the §5.5
 * sentence, and a text PDF with no table is stored and its batch failed with the reason.
 */
describe('a PDF statement goes in through the same wizard', () => {
  const pdf = (name: string) => fixtureFile(name, 'application/pdf');

  it('reads a text-layer statement into a pdf_text batch with its printed balances', async () => {
    const result = await startImport({
      organizationId: orgId, userId: ownerId, requestId: `itest-${RUN}`, db: userDb(),
      file: pdf('bank_text.pdf'), importType: 'bank_statement',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', bankAccountId,
    });
    expect(result.parseFailure).toBeUndefined();
    expect(result.columns).toEqual(['Date', 'Description', 'Paid out', 'Paid in', 'Balance']);

    const b = (await orgRow(fs(), orgId, 'import_batches', result.batchId).get()).data()!;
    expect(`${b.extraction_method}|${b.status}|${b.statement_opening_balance ?? '-'}|${b.statement_closing_balance ?? '-'}`)
      .toBe('pdf_text|awaiting_review|1000.00|7320.14');

    const review = (await loadBatchReview(userDb(), orgId, result.batchId))!;
    // 28 transactions and 7 lines of page furniture, every one of them kept (SOW §23).
    const distribution = review.rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    const odd = review.rows.filter((r) => !['valid', 'warning', 'skipped'].includes(r.status)).slice(0, 2).map((r) => `${r.sourceRef} ${r.status} raw=${JSON.stringify(r.rawData).slice(0, 120)} mapped=${JSON.stringify(r.mappedData).slice(0, 120)} issues=${JSON.stringify(r.issues).slice(0, 300)}`);
    expect(review.rows.length, JSON.stringify(distribution)).toBe(36);
    expect(review.rows.filter((r) => r.status === 'valid' || r.status === 'warning').length, `${JSON.stringify(distribution)} ${odd.join(' | ')}`).toBe(28);
    expect(review.rows.every((r) => /^page:\d+;line:\d+$/.test(r.sourceRef ?? ''))).toBe(true);
    // The balances reconcile and the page chain holds, so no gate fires (§5.3).
    const first = review.rows.filter((r) => r.status !== 'skipped').slice(0, 3).map((r) => JSON.stringify(r.mappedData));
    expect(review.batchIssues.map((i) => i.code), `${JSON.stringify(review.batchIssues)} rows=${first.join(' | ')}`).not.toContain('IMP-BAL-006');
    expect(review.batchIssues.map((i) => i.code)).not.toContain('IMP-BAL-007');
  });

  it('stores a scanned statement, opens no batch, and says what to do instead (§5.5)', async () => {
    await expect(runWizard(pdf('bank_scanned.pdf'))).rejects.toThrow(/scanned image/);
    const [doc] = await where(orgId, 'source_documents', { original_filename: 'bank_scanned.pdf' });
    expect(`${doc?.status}|${doc?.has_text_layer ?? 'null'}`).toBe('unreadable|false');
    expect(await batchesFor('bank_scanned.pdf')).toBe(0);
  });

  it('stores a text PDF with no transaction table and fails its batch with the reason (§5.3)', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    ['Dear customer,', 'Thank you for banking with us.', 'Your statement is attached separately.']
      .forEach((text, i) => page.drawText(text, { x: 60, y: 780 - i * 20, size: 11, font }));
    const bytes = await doc.save();
    const file = new File([new Uint8Array(bytes)], 'letter.pdf', { type: 'application/pdf' });

    const result = await runWizard(file);
    expect(result.parseFailure).toMatch(/could not find a transaction table/);
    const b = (await orgRow(fs(), orgId, 'import_batches', result.batchId).get()).data()!;
    expect(`${b.status}|${b.extraction_method}|${(b.error_summary as { message?: string } | null)?.message ?? '-'}`)
      .toMatch(/^failed\|pdf_text\|APX could not find a transaction table/);
    expect((await orgRow(fs(), orgId, 'source_documents', result.documentId).get()).get('status')).toBe('ready');
  });

  it('lets a reviewer type the printed balances and judges the statement again (§5.3, ADR-085)', async () => {
    const result = await startImport({
      organizationId: orgId, userId: ownerId, requestId: `itest-${RUN}`, db: userDb(),
      file: pdf('bank_text_multiline.pdf'), importType: 'bank_statement',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', bankAccountId,
    });
    const ctx: AccessContext = {
      userId: ownerId, orgId, orgSlug: null, effectiveRole: 'owner', permissions: permissionsFor('owner'), actorType: 'user',
      db: userDb(), requestId: `itest-${RUN}`, now: () => new Date(), organizationStatus: 'active',
    };
    const before = (await loadBatchReview(userDb(), orgId, result.batchId))!;
    const captured = before.typedBalances;
    // Whatever the parser captured, the reviewer's figures replace them and the gate runs again.
    const wrong = await setStatementBalancesAndRevalidate(ctx, { batchId: result.batchId, opening: '1.00', closing: '2.00' });
    expect(wrong.reconciled).toBe(false);
    expect((await loadBatchReview(userDb(), orgId, result.batchId))!.batchIssues.map((i) => i.code)).toContain('IMP-BAL-006');
    if (captured.opening && captured.closing) {
      const right = await setStatementBalancesAndRevalidate(ctx, { batchId: result.batchId, opening: captured.opening, closing: captured.closing });
      expect(right.reconciled).toBe(true);
      expect((await loadBatchReview(userDb(), orgId, result.batchId))!.batchIssues.map((i) => i.code)).not.toContain('IMP-BAL-006');
    }
  });
});
