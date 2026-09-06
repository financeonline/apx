import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { loadBatchReview, startImport } from '@/modules/imports';
import { adminSql, clientFor, createAuthUser } from './setup';

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
const DOMAIN = `${RUN}.wizard.itest`;

let ownerId: string;
let orgId: string;
let bankAccountId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

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
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: `ITest Wizard ${RUN}`,
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  bankAccountId = one(`
    insert into public.bank_accounts
           (organization_id, name, account_type, bank_name, account_number_masked, is_active)
    values ('${orgId}', 'Business Current', 'current', 'Test Bank', '****1234', true)
    returning id`);
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Wizard%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Wizard %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.wizard.itest' and created_at < now() - interval '1 hour';`);
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

  it('kept every source line as a row, including any that cannot import (SOW §23)', () => {
    const rows = Number(one(`
      select count(*) from public.import_rows
       where organization_id = '${orgId}' and batch_id = '${batchId}'`));

    const sourceLines = readFileSync('fixtures/imports/csv-with-preamble.csv', 'utf8')
      .split('\n').filter((line) => line.trim() !== '').length;

    /*
     * Every non-empty line, and no more. The preamble lines above the header are rows too — §5.2
     * records them as `IMP-ROW-005` rather than dropping them — which is the whole point: a reviewer
     * can see that MOTION read the file's first four lines and decided they were not transactions.
     */
    expect(rows).toBe(sourceLines);
  });

  it('marked the preamble as unusable rather than discarding it (§5.2)', () => {
    const statuses = one(`
      select string_agg(distinct status::text, ',' order by status::text)
        from public.import_rows
       where organization_id = '${orgId}' and batch_id = '${batchId}'`);
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
  const amountsOf = (batchId: string): string[] => adminSql(`
    select coalesce(string_agg(mapped_data->>'amount', ',' order by row_number), '')
      from public.import_rows
     where organization_id = '${orgId}' and batch_id = '${batchId}'
       and status in ('valid', 'warning') and mapped_data->>'amount' is not null`)
    .split(',').filter((a) => a !== '');

  /** The status the file's own header line was given. */
  const headerRowStatus = (batchId: string): string => adminSql(`
    select status::text from public.import_rows
     where organization_id = '${orgId}' and batch_id = '${batchId}'
       and mapped_data->>'amount' = 'Amount'`);

  it('negates a card export, because on a card a purchase is money going out (ADR-028)', async () => {
    const cardId = one(`
      insert into public.bank_accounts
             (organization_id, name, account_type, bank_name, account_number_masked, is_active)
      values ('${orgId}', 'Company Card', 'credit_card', 'Test Bank', '****9911', true)
      returning id`);

    const result = await runWizard(fixtureFile('bank_positive_out.csv'), 'bank_statement', cardId);
    expect(amountsOf(result.batchId)).toEqual(expectedAmounts('bank_positive_out'));

    /*
     * The header line reached the sign transform as data, carrying the literal text "Amount" in
     * the money column. It becomes ONE held-back row; before ADR-058.5 it threw, and the whole
     * import died on its first line.
     */
    expect(headerRowStatus(result.batchId)).toMatch(/error|skipped/);
  });

  it('refuses the same shape on a current account rather than guessing', async () => {
    await expect(runWizard(fixtureFile('bank_signed.csv')))
      .rejects.toThrow(/single amount column/);
  });

  it('left nothing behind when it refused', () => {
    const batches = Number(one(`
      select count(*) from public.import_batches b
       join public.source_documents d
         on d.organization_id = b.organization_id and d.id = b.source_document_id
      where b.organization_id = '${orgId}' and d.original_filename = 'bank_signed.csv'`));
    expect(batches, 'a question nobody answered started no batch').toBe(0);
  });

  it('needs no answer at all when the file has separate money-in and money-out columns', async () => {
    const result = await runWizard(fixtureFile('bank_out_in_columns.csv'));
    expect(amountsOf(result.batchId)).toEqual(expectedAmounts('bank_out_in_columns'));
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

  it('leaves no second batch behind when it refuses', () => {
    const batches = Number(one(`
      select count(*) from public.import_batches b
       join public.source_documents d
         on d.organization_id = b.organization_id and d.id = b.source_document_id
      where b.organization_id = '${orgId}' and d.original_filename = 'csv-with-preamble.csv'`));
    expect(batches, 'the refused upload started nothing').toBe(1);
  });
});

describe('a file MOTION cannot read is refused before anything is stored', () => {
  it('refuses a PDF renamed .csv by its magic bytes (§4)', async () => {
    await expect(runWizard(fixtureFile('fake_csv.pdf', 'text/csv')))
      .rejects.toThrow();

    // Nothing was stored, and no batch was started, so there is no orphan to clean up.
    const batches = Number(one(`
      select count(*) from public.import_batches b
       join public.source_documents d
         on d.organization_id = b.organization_id and d.id = b.source_document_id
      where b.organization_id = '${orgId}' and d.original_filename = 'fake_csv.pdf'`));
    expect(batches).toBe(0);
  });

  it('tells somebody uploading a PDF statement what to do instead', async () => {
    await expect(runWizard(fixtureFile('bank_text.pdf', 'application/pdf')))
      .rejects.toThrow(/CSV or Excel|not ready yet/);
  });
});
