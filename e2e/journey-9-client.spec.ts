import { expect, test } from '@playwright/test';
import {
  GL_CSV, cleanUpOwn, drainQueue, importLedger, onboard, seedUser, signIn, sql, uniqueName,
} from './fixtures';

/**
 * Journey 9 — the client experience (TEST_STRATEGY.md §12 journey 9; EVIDENCE_MODEL.md §10, CD-17).
 *
 * A client is somebody the business shows its numbers to and not its paperwork. The journey's
 * evidence half is this phase's exit gate: "opens evidence to records level; document level locked"
 * — and locked has to mean a sentence explaining the boundary, not an empty panel that reads as
 * missing data.
 */

const ORG_NAME = uniqueName('Client View Ltd');

test.afterAll(() => cleanUpOwn([ORG_NAME], ['journey9-owner', 'journey9-client']));

test('a client reaches the records behind a figure, and stops at the document', async ({ page }) => {
  const owner = seedUser('journey9-owner');
  const client = seedUser('journey9-client');

  // ---- An organisation with real figures in it ------------------------------------------------
  await signIn(page, owner);
  const slug = await onboard(page, ORG_NAME);
  await importLedger(page, slug, GL_CSV, 'gl-may.csv');
  await drainQueue(page);
  await drainQueue(page);

  await page.goto(`/app/${slug}/home`);
  await expect(page.getByText('£40,000').first()).toBeVisible({ timeout: 30_000 });

  // The owner adds the client. Done in SQL because inviting and accepting is journey 4's subject,
  // and this journey is about what the client can then see.
  const orgId = sql(`select id from public.organizations where slug = '${slug}'`);
  sql(`insert into public.organization_memberships (organization_id, user_id, role, status)
       values ('${orgId}', '${client.userId}', 'client', 'active')`);

  // ---- The client's own session ---------------------------------------------------------------
  await page.context().clearCookies();
  await signIn(page, client);

  await page.goto(`/app/${slug}/home`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // §376: no Data menu for a client.
  await expect(page.getByRole('link', { name: /add data/i })).toHaveCount(0);

  // ---- Levels 0 to 3: everything a client may see ---------------------------------------------
  const why = page.getByRole('link', { name: /why\?/i });
  await expect(why.first(), 'a client sees the evidence affordance too').toBeVisible();
  await why.first().click();
  await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 30_000 });

  await expect(page.getByRole('heading', { name: /^the figure$/i })).toBeVisible();
  await expect(
    page.getByText(/which is the figure\./i).first(),
    'the rows reconcile for a client exactly as they do for an owner',
  ).toBeVisible();

  // ---- Level 4: locked, and said so ------------------------------------------------------------
  await page.getByRole('link', { name: /source/i }).first().click();
  await expect(
    page.getByText(/source documents are available to owners and admins/i),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole('button', { name: /open the source file/i }),
    'there is no button to press, not a button that fails',
  ).toHaveCount(0);
});
