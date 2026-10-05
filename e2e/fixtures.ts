import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

/**
 * Seeding and signing in for the journeys (TEST_STRATEGY.md §12).
 *
 * Every journey creates its own organisation with a run-unique name and removes exactly that
 * (ADR-052.12). A shared seed would make two journeys delete each other's fixtures halfway through,
 * which is how an e2e suite earns a reputation for being flaky and stops being read.
 */

const DB_CONTAINER = process.env.MOTION_DB_CONTAINER ?? 'supabase_db_MOTION';

export function sql(statement: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-c', statement],
    { encoding: 'utf8' },
  ).trim();
}

/** Where the setup project leaves the signed-in state and the organisation it seeded. */
export const AUTH_STATE = 'e2e/.auth/owner.json';
export const SEEDED_ORG = 'e2e/.auth/org.json';

/**
 * The run tag.
 *
 * Read from the environment when present so the setup project and the tests that reuse its
 * organisation agree about what to clean up — separate processes would otherwise each mint their own
 * and the sweep would miss the other's fixtures.
 */
export const RUN_TAG = process.env.E2E_RUN_TAG ?? `e2e${Date.now().toString(36)}`;
export const EMAIL_DOMAIN = `${RUN_TAG}.e2e.motion`;
const PASSWORD = 'Journey-Test-9x!';

export interface SeededUser {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
}

/**
 * A confirmed user with a known password.
 *
 * Created directly rather than through the sign-up flow, except in journey 1 which tests that flow
 * itself: a journey about importing should fail when importing breaks, not when an email confirmation
 * changes.
 */
export function seedUser(localPart: string): SeededUser {
  const email = `${localPart}@${EMAIL_DOMAIN}`;
  const userId = sql(`
    with created as (
      insert into auth.users (
        id, instance_id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data,
        -- GoTrue reads these as NOT NULL text. A hand-inserted row leaves them NULL, and every
        -- sign-in then fails with "Database error querying schema" — which looks like a broken
        -- database and is really a broken fixture.
        confirmation_token, recovery_token, email_change_token_new, email_change,
        email_change_token_current, phone_change, phone_change_token, reauthentication_token
      )
      values (
        gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        '${email}', crypt('${PASSWORD}', gen_salt('bf')),
        now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
        '', '', '', '', '', '', '', ''
      )
      returning id
    )
    select id from created`);
  return { email, password: PASSWORD, userId };
}

export async function signIn(page: Page, user: SeededUser): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  // The app decides where to land — onboarding, an org, or the picker — so wait for any of them.
  await page.waitForURL(/\/(onboarding|app|select-organization|portfolio)/, { timeout: 30_000 });
}

/** An organisation with the caller as owner, created the way the product creates one. */
export function seedOrganization(name: string, ownerId: string): { id: string; slug: string } {
  const row = sql(`
    select set_config('request.jwt.claims',
      json_build_object('sub', '${ownerId}', 'role', 'authenticated',
                        'email', (select email from auth.users where id = '${ownerId}'))::text,
      false);
    with created as (select api.create_organization('${name}') as id)
    select created.id::text || '|' || o.slug
      from created join public.organizations o on o.id = created.id`);
  const last = row.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const [id, slug] = last.split('|');
  return { id: id!, slug: slug! };
}

/**
 * Runs the queue the way the cron does, so figures appear without waiting a minute for a tick.
 *
 * `GET`, with the bearer token the route checks — and it answers 404, not 401, to a caller without
 * one, so a wrong secret shows up here as "not found" rather than as a hang.
 */
/**
 * Runs the queue until an organisation has no work left in it.
 *
 * One drain claims a fixed batch from a queue every journey shares, so calling it a set number of
 * times is a bet that nobody else left work in it — and when the bet loses the journey fails on a
 * missing figure, which looks like a broken dashboard and is a broken fixture. Waiting on the
 * organisation's own jobs is what each caller actually means.
 *
 * `orgSlug` is optional so the callers that only need "run whatever is there" keep working.
 */
export async function drainQueue(page: Page, orgSlug?: string): Promise<void> {
  const secret = process.env.CRON_SECRET;
  expect(secret, 'CRON_SECRET must be set for the journeys to drain the queue').toBeTruthy();

  const outstanding = (): number => {
    if (orgSlug === undefined) return 0;
    return Number(sql(`
      select count(*) from public.jobs j
       join public.organizations o on o.id = j.organization_id
      where o.slug = '${orgSlug}' and j.status in ('queued', 'running')`).trim() || '0');
  };

  for (let round = 0; round < 12; round += 1) {
    const response = await page.request.get('/api/jobs/run', {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.status(), 'the drain endpoint must accept the cron secret').toBe(200);

    if (orgSlug === undefined) return;
    // A calculation enqueues an alert pass, so "nothing left" is checked after each round rather
    // than assumed after the first.
    if (outstanding() === 0) return;
  }
}

/**
 * Removes exactly what one suite created.
 *
 * NOT everything matching the run tag: every project in a run shares that tag, so a blanket delete
 * in one suite's `afterAll` wipes the organisation another project is still testing against — which
 * is precisely the flakiness this file's own header warns about, and which it then caused
 * (ADR-058.10).
 */
export function cleanUpOwn(orgNames: readonly string[], emailPrefixes: readonly string[]): void {
  if (orgNames.length > 0) {
    const names = orgNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ');
    sql(`delete from public.organizations where name in (${names})`);
  }
  for (const prefix of emailPrefixes) {
    sql(`
      delete from public.platform_users where user_id in
        (select id from auth.users where email = '${prefix}@${EMAIL_DOMAIN}');
      delete from auth.users where email = '${prefix}@${EMAIL_DOMAIN}'`);
  }
}

/**
 * Removes fixtures a killed run left behind.
 *
 * Age-based, and run once at the start by the setup project — never mid-run, where it could delete
 * an organisation another project is using.
 */
export function sweepOldFixtures(): void {
  sql(`
    delete from public.organizations where name like '%e2e%' and created_at < now() - interval '2 hours';
    delete from public.platform_users where user_id in
      (select id from auth.users where email like '%.e2e.motion' and created_at < now() - interval '2 hours');
    delete from auth.users where email like '%.e2e.motion' and created_at < now() - interval '2 hours';`);
}

export function uniqueName(label: string): string {
  return `${label} ${RUN_TAG}-${randomUUID().slice(0, 4)}`;
}

/**
 * The whole of journey 1's import, as a helper.
 *
 * Journey 8 rolls back what journey 1 imported, and duplicating twenty steps to get there is how an
 * e2e suite becomes something nobody edits.
 */
export async function importLedger(
  page: Page,
  slug: string,
  csv: string,
  filename = 'gl.csv',
): Promise<void> {
  await page.goto(`/app/${slug}/data/imports/new`);
  await page.getByLabel(/what kind of file/i).selectOption('general_ledger');
  await page.getByLabel(/covers from/i).fill('2026-05-01');
  await page.getByLabel(/covers to/i).fill('2026-05-31');
  await page.getByLabel(/the file/i).setInputFiles({
    name: filename, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8'),
  });
  await page.getByRole('button', { name: /upload and check/i }).click();
  await page.waitForURL(/\/data\/imports\/[0-9a-f-]{36}/, { timeout: 60_000 });

  const question = page.getByRole('button', { name: /yes, that is right|save this answer/i });
  for (let remaining = await question.count(); remaining > 0; remaining -= 1) {
    await question.first().click();
    await expect(question).toHaveCount(remaining - 1, { timeout: 15_000 });
  }

  const skip = page.getByRole('button', { name: /^skip \d+ rows?$/i });
  if (await skip.count() > 0) {
    await skip.click();
    await expect(skip).toHaveCount(0, { timeout: 15_000 });
  }

  await page.getByRole('button', { name: /^import \d+ rows?$/i }).click();
  await expect(page.getByText(/this file has already been imported/i))
    .toBeVisible({ timeout: 30_000 });
}

/**
 * Adds a bank account through the Banking page, the way an owner does (journey 13's steps).
 */
export async function addBankAccount(page: Page, slug: string, name: string): Promise<void> {
  await page.goto(`/app/${slug}/money/banking`);
  await page.getByLabel(/what do you call this account/i).fill(name);
  await page.getByLabel(/which bank is it with/i).fill('Test Bank');
  await page.getByLabel(/last four digits/i).fill('1234');
  await page.getByRole('button', { name: /add this account/i }).click();
  await expect(page.getByText(/account added/i)).toBeVisible({ timeout: 15_000 });
}

/** Imports a bank statement through the real wizard (journey 13's steps), answering its questions. */
export async function importStatement(
  page: Page, slug: string, csv: string, filename: string, from: string, to: string,
): Promise<void> {
  await page.goto(`/app/${slug}/data/imports/new`);
  await page.getByLabel(/what kind of file/i).selectOption('bank_statement');
  await page.getByLabel(/covers from/i).fill(from);
  await page.getByLabel(/covers to/i).fill(to);
  await page.getByLabel(/the file/i).setInputFiles({ name: filename, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await page.getByRole('button', { name: /upload and check/i }).click();
  await page.waitForURL(/\/data\/imports\/[0-9a-f-]{36}/, { timeout: 60_000 });
  const question = page.getByRole('button', { name: /yes, that is right|save this answer/i });
  for (let remaining = await question.count(); remaining > 0; remaining -= 1) {
    await question.first().click();
    await expect(question).toHaveCount(remaining - 1, { timeout: 15_000 });
  }
  const skip = page.getByRole('button', { name: /^skip \d+ rows?$/i });
  if (await skip.count() > 0) { await skip.click(); await expect(skip).toHaveCount(0, { timeout: 15_000 }); }
  await page.getByRole('button', { name: /^import \d+ rows?$/i }).click();
  await expect(page.getByText(/this file has already been imported/i)).toBeVisible({ timeout: 30_000 });
}

/**
 * The bank statement behind GL_CSV's May (its cash side: in 25,000 and 15,000; out 9,000, 3,000 and
 * 12,000), with a running balance from 10,000. Since Step 0E (H-1) a business with no bank data is
 * not scored on banking at all, so the seeded organisation carries real bank data for the Health
 * history the accessibility sweep reads.
 */
export const STATEMENT_MAY_CSV = [
  'Date,Description,Paid Out,Paid In,Balance',
  '2026-05-10,FPS CREDIT INVOICE 1001,,25000.00,35000.00',
  '2026-05-12,MATERIALS SUPPLIER,9000.00,,26000.00',
  '2026-05-18,FPS CREDIT INVOICE 1002,,15000.00,41000.00',
  '2026-05-20,CAMPAIGN AGENCY,3000.00,,38000.00',
  '2026-05-25,PAYROLL MAY,12000.00,,26000.00',
].join('\n');

/** A month of ordinary trading, in the shape a small accounting package exports. */
export const GL_CSV = [
  'Date,Account Code,Account Name,Description,Debit,Credit',
  '2026-05-10,4000,Sales,Invoice 1001,,25000.00',
  '2026-05-18,4000,Sales,Invoice 1002,,15000.00',
  '2026-05-12,5000,Cost of Sales,Materials,9000.00,',
  '2026-05-25,7000,Payroll,May salaries,12000.00,',
  '2026-05-20,7500,Marketing,Campaign,3000.00,',
].join('\n');

/** Creates the organisation the way onboarding does, and returns its slug. */
export async function onboard(page: Page, orgName: string): Promise<string> {
  await page.goto('/onboarding');
  await page.getByLabel(/business name/i).fill(orgName);
  await page.getByRole('button', { name: /create|continue|get started|set up|save/i }).first().click();
  await page.waitForURL(/\/app\/[^/]+\/home/, { timeout: 30_000 });
  const slug = page.url().match(/\/app\/([^/]+)\//)?.[1];
  expect(slug, 'onboarding lands the owner in their new organisation').toBeTruthy();
  return slug!;
}

/** The organisation the setup project seeded, for the suites that reuse it. */
export function seededOrgSlug(): string {
  const raw = readFileSync(SEEDED_ORG, 'utf8');
  return (JSON.parse(raw) as { slug: string }).slug;
}
