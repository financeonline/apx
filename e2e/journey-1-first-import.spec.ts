import { expect, test } from '@playwright/test';
import { cleanUpOwn, drainQueue, seedUser, signIn, sql, uniqueName } from './fixtures';

/**
 * Journey 1 — onboarding → first import → dashboard (TEST_STRATEGY.md §12).
 *
 * The journey the whole product exists for, and the one every phase's work has to survive: a person
 * with a file and no data ends the journey looking at their own figures. It is the acceptance test
 * for the import engine, the calculation engine, the health score and Home at once.
 */



const ORG_NAME = uniqueName('Acme Trading');

test.afterAll(() => cleanUpOwn([ORG_NAME], ['journey1-owner']));

test('a new owner uploads a ledger and sees their own figures', async ({ page }) => {
  const owner = seedUser('journey1-owner');
  const orgName = ORG_NAME;

  await signIn(page, owner);

  // ---- Onboarding: create the organisation -------------------------------------------------
  await page.goto('/onboarding');
  await page.getByLabel(/name/i).first().fill(orgName);
  await page.getByRole('button', { name: /create|continue|get started/i }).first().click();
  await page.waitForURL(/\/app\/[^/]+\/departments/, { timeout: 30_000 });

  const slug = page.url().match(/\/app\/([^/]+)\//)?.[1];
  expect(slug, 'the owner lands in their new organisation').toBeTruthy();

  // ---- Home, before any data ----------------------------------------------------------------
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(
    page.getByText(/add your first|no data yet|get started|upload/i).first(),
    'Home says what to do rather than showing zeroes',
  ).toBeVisible();

  // ---- Add data ------------------------------------------------------------------------------
  await page.goto(`/app/${slug}/data/imports/new`);
  await expect(page.getByRole('heading', { name: /add data/i })).toBeVisible();

  await page.getByLabel(/what kind of file/i).selectOption('general_ledger');
  await page.getByLabel(/covers from/i).fill('2026-05-01');
  await page.getByLabel(/covers to/i).fill('2026-05-31');
  await page.getByLabel(/the file/i).setInputFiles({
    name: 'gl-may.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(GL_CSV, 'utf8'),
  });
  await page.getByRole('button', { name: /upload and check/i }).click();


  // ---- Review --------------------------------------------------------------------------------
  await page.waitForURL(/\/data\/imports\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: /gl-may\.csv/i })).toBeVisible();

  // §8: every row is on the screen, including any that will not import.
  await expect(page.getByText(/every row we read/i)).toBeVisible();

  /*
   * The header line is on the screen as a line MOTION read and set aside — nothing from the file is
   * thrown away silently (§5.2, SOW §23) — but it is the column headings, not a row that "cannot
   * import", and it asks the reviewer for nothing (ADR-083). Before that, every CSV import made
   * its reviewer dismiss an "error" that was the header.
   */
  await expect(page.getByText(/cannot import/i)).toHaveCount(0);

  /*
   * §8.2: a file that raises a question cannot commit until it is answered. This is the question,
   * and answering it is what a reviewer does — the button does not exist before then.
   */
  const question = page.getByRole('button', { name: /yes, that is right|save this answer/i });
  for (let remaining = await question.count(); remaining > 0; remaining -= 1) {
    await question.first().click();
    // The answered question disappears; that is the feedback, so wait for it to go rather than for
    // a message the form unmounts before anyone could read.
    await expect(question).toHaveCount(remaining - 1, { timeout: 15_000 });
  }

  // No unreadable row is left undecided, so no "skip" decision is asked for.
  await expect(page.getByRole('button', { name: /^skip \d+ rows?$/i })).toHaveCount(0);

  const commit = page.getByRole('button', { name: /^import \d+ rows?$/i });
  await expect(commit, 'once the questions are answered, Commit is offered').toBeVisible({
    timeout: 15_000,
  });
  await commit.click();
  /*
   * The durable evidence, not the transient message: once a batch commits the screen says so, and
   * every row carries its outcome. A toast would have disappeared by the time anyone looked.
   */
  await expect(page.getByText(/this file has already been imported/i))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Imported$/).first()).toBeVisible();

  // ---- The figures ---------------------------------------------------------------------------
  // The calculation runs on the queue; the cron would pick it up within a minute.
  await drainQueue(page, slug);

  await page.goto(`/app/${slug}/home`);

  console.log('JOBS:', sql(`
    select coalesce(string_agg(j.job_type || '=' || j.status || '/' || coalesce(left(j.last_error,80),'-'), ' ; '), 'none')
      from public.jobs j join public.organizations o on o.id = j.organization_id
     where o.name = '${orgName}'`));
  console.log('SNAPSHOTS:', sql(`
    select count(*)::text from public.metric_snapshots s
      join public.organizations o on o.id = s.organization_id where o.name = '${orgName}'`));
  await expect(
    page.getByText(/business health/i),
    'the health score appears once a complete month exists',
  ).toBeVisible({ timeout: 30_000 });

  /*
   * The engine's own figures for the month the file covered — the whole point of the journey.
   *
   * Asserted against the database as well as the screen, because "the number is on the page" and
   * "the number is right" are different claims, and only the second one matters.
   */
  const may = sql(`
    select coalesce(string_agg(c.metric_key || '=' || s.value::text, ',' order by c.metric_key), 'none')
      from public.metric_current c
      join public.metric_snapshots s
        on s.organization_id = c.organization_id and s.id = c.snapshot_id
      join public.fiscal_periods f
        on f.organization_id = c.organization_id and f.id = c.period_id
      join public.organizations o on o.id = c.organization_id
     where o.name = '${orgName}' and f.period_start = '2026-05-01'
       and c.dimension_type = 'none' and s.value is not null
       and c.metric_key in ('revenue', 'gross_profit', 'operating_expenses', 'net_profit')`);

  expect(may).toBe(
    'gross_profit=31000.000000,net_profit=16000.000000,'
    + 'operating_expenses=15000.000000,revenue=40000.000000',
  );

  // And the same figure, formatted, on the page the owner is looking at.
  await expect(page.getByText('£40,000').first()).toBeVisible();
});

/**
 * A month of ordinary trading, in the shape a small accounting package exports.
 *
 * Inline rather than a fixture file so the journey is readable on its own: what went in is the four
 * lines above the assertion about what came out.
 */
const GL_CSV = [
  'Date,Account Code,Account Name,Description,Debit,Credit',
  '2026-05-10,4000,Sales,Invoice 1001,,25000.00',
  '2026-05-18,4000,Sales,Invoice 1002,,15000.00',
  '2026-05-12,5000,Cost of Sales,Materials,9000.00,',
  '2026-05-25,7000,Payroll,May salaries,12000.00,',
  '2026-05-20,7500,Marketing,Campaign,3000.00,',
].join('\n');
