import { expect, test } from '@playwright/test';
import { cleanUpOwn, onboard, seedUser, signIn, uniqueName, type SeededUser } from './fixtures';
import { addMembership, orgIdBySlug } from './firestore';

/**
 * The route → RBAC status matrix (ROUTE_ARCHITECTURE.md §11; ADR-091).
 *
 * §11's footnote is specific: *"403* = page renders the friendly permission-denied state
 * (UX_ARCHITECTURE.md §7.4) with HTTP 403; the organization's existence is already known to these
 * users, so 403 does not leak anything."* Nothing asserted it, and the product did neither: a page
 * that called `assertCan` threw into the error boundary — 500, and "Something went wrong on our
 * side" — and a page that called `notFound()` answered 404.
 *
 * What is under test is the pair of distinctions the matrix draws, because each one is a decision
 * about what a reader is told:
 *   - a member who lacks a PERMISSION gets 403 and is told who to ask;
 *   - a caller with no standing in the organisation, and a resource id that is not theirs, get 404
 *     and are told nothing at all (SECURITY_MODEL.md §14).
 */

const ORG_NAME = uniqueName('Authz Ltd');

let owner: SeededUser;
let client: SeededUser;
let stranger: SeededUser;
let org: { id: string; slug: string };

/**
 * The organisation is made the way a customer makes one — through the onboarding form — because
 * `api.create_organization` is where the slug, the chart of accounts and the period window come
 * from, and a fixture that inserted a row directly would be testing against an organisation the
 * product cannot produce.
 */
test.beforeAll(async ({ browser }) => {
  owner = await seedUser('authz-owner');
  client = await seedUser('authz-client');
  stranger = await seedUser('authz-stranger');

  const page = await browser.newPage();
  await signIn(page, owner);
  const slug = await onboard(page, ORG_NAME);
  await page.close();

  org = { slug, id: await orgIdBySlug(slug) };
  await addMembership(org.id, client.userId, 'client');
});

test.afterAll(() => cleanUpOwn([ORG_NAME], ['authz-owner', 'authz-client', 'authz-stranger']));

test.describe.serial('what each caller is told when a page says no', () => {
  test('a client is refused with 403 and the denied state, never a server error', async ({ page }) => {

    await signIn(page, client);

    // Home is open to every role that resolves, including a client.
    expect((await page.goto(`/app/${org.slug}/home`))?.status()).toBe(200);

    // §11: 403* for a client on the import surface and on the governance pages.
    for (const path of ['data/imports', 'data/imports/new', 'settings/team', 'settings/danger', 'settings/audit']) {
      const response = await page.goto(`/app/${org.slug}/${path}`);
      expect(response?.status(), `${path} must answer 403`).toBe(403);
      await expect(
        page.getByRole('heading', { name: /you do not have access to this page/i }),
        `${path} must render the §7.4 denied state`,
      ).toBeVisible();
      // The denied state says who to ask and nothing about what is on the page.
      await expect(page.getByText(/something went wrong on our side/i)).toHaveCount(0);
      await expect(page.getByText(/reference for support/i)).toHaveCount(0);
    }

    /*
     * What-if is the other shape of the same rule (RBAC_MATRIX.md §5, ADR-100): a client MAY read
     * scenarios — they are statements about figures a client already sees — but may not work one
     * out. So the page answers 200 and the control is HIDDEN, not disabled. (This organisation has
     * no forecast, so the page is on its empty state; the sentence naming who CAN work one out is
     * on the branch that needs a forecast, and the refusal itself is proven against every role in
     * `test/integration/scenarios.test.ts`.)
     */
    expect((await page.goto(`/app/${org.slug}/what-if`))?.status()).toBe(200);
    await expect(page.getByRole('button', { name: /^work it out$/i })).toHaveCount(0);
  });

  test('an owner is not refused the same pages', async ({ page }) => {
    await signIn(page, owner);
    for (const path of ['data/imports', 'settings/team', 'settings/danger']) {
      expect((await page.goto(`/app/${org.slug}/${path}`))?.status(), path).toBe(200);
    }
  });

  test('a stranger gets 404 for the same organisation — never 403, which would confirm it exists', async ({ page }) => {

    await signIn(page, stranger);
    for (const path of ['home', 'data/imports', 'settings/team']) {
      expect((await page.goto(`/app/${org.slug}/${path}`))?.status(), path).toBe(404);
    }
  });

  test('a document id keeps its 404 for a client: the matrix asks for 404 there, not 403', async ({ page }) => {

    await signIn(page, client);
    const invented = '00000000-0000-4000-8000-000000000000';
    expect((await page.goto(`/app/${org.slug}/data/documents/${invented}`))?.status()).toBe(404);
    expect((await page.goto(`/app/${org.slug}/data/documents`))?.status()).toBe(404);
  });

  test('an API route answers 403 with a plain message, not a page and not a 200', async ({ page }) => {

    await signIn(page, client);
    const response = await page.request.get(`/api/exports/ledger?org=${org.slug}`);
    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
    // No stack, no SQL, no permission name a customer has no use for.
    expect(JSON.stringify(body)).not.toMatch(/at\s+\w+\s+\(|select |pg_|postgres/i);
  });
});
