import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { cleanUpOwn, onboard, seedUser, signIn, uniqueName } from './fixtures';
import { auditEvents, enableFeatures, orgIdBySlug } from './firestore';

/**
 * Journey 22 — a receipt photo (SOW §8; ADR-150). A photo uploaded as Receipts is stored and WAITS:
 * nothing is read until a reviewer asks. With AI reading switched off the page says so; switched on,
 * the reviewer is asked which expense account the receipts belong to and told plainly that the file
 * itself goes to the AI provider. The reading itself needs a model and is proven with a scripted one
 * in `test/integration/receipt-reading.test.ts`; this journey stops at the button.
 */

const ORG = uniqueName('Receipts Ltd');
test.afterAll(() => cleanUpOwn([ORG], ['j22-owner']));

/** Enough of a JPEG for the magic-byte check. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...new Array(300).fill(9), 0xff, 0xd9]);

test('a receipt photo is stored, waits, and is read only when a reviewer asks', async ({ page }) => {
  await signIn(page, await seedUser('j22-owner'));
  const slug = await onboard(page, ORG);

  await page.goto(`/app/${slug}/data/imports/new`);
  await page.getByLabel(/what kind of file/i).selectOption('receipts');
  await expect(page.getByText(/a photo \(JPEG or PNG, up to 5 MB\)/)).toBeVisible();
  await page.getByLabel(/covers from/i).fill('2026-05-01');
  await page.getByLabel(/covers to/i).fill('2026-05-31');
  await page.getByLabel(/the file/i).setInputFiles({ name: 'till-receipt.jpg', mimeType: 'image/jpeg', buffer: JPEG });
  await page.getByRole('button', { name: /upload and check/i }).click();
  await page.waitForURL(/\/data\/imports\/[0-9a-f-]{36}/, { timeout: 60_000 });

  // Stored and waiting — said in the information tone, not as a failure; and nothing sent anywhere.
  await expect(page.getByText('These receipts are stored and waiting to be read.')).toBeVisible();
  await expect(page.getByText('APX could not read this file.')).toHaveCount(0);
  await expect(page.getByText(/AI reading of documents is switched off/)).toBeVisible();
  const orgId = await orgIdBySlug(slug);
  const sentToAi = async (): Promise<number> =>
    (await auditEvents(orgId)).filter((a) => a.action === 'document.sent_to_ai').length;
  expect(await sentToAi()).toBe(0);

  // Switched on (the platform admin's switch), the reviewer chooses the account and consents.
  await enableFeatures(orgId, { ai_pdf_extraction: true });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Read these receipts with AI' })).toBeVisible();
  const account = page.getByLabel('Expense account these receipts belong to');
  await expect(account).toBeVisible();
  expect(await account.locator('option').count()).toBeGreaterThan(1);
  await expect(page.getByText(/send this receipt file — the photo or PDF itself — to its AI provider/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read receipts with AI' })).toBeVisible();

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
});
