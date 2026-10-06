import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { GL_CSV, cleanUpOwn, drainQueue, importLedger, onboard, seedUser, signIn, sql, uniqueName } from './fixtures';

/**
 * Journey 21 — Funding Readiness (Phase 16; ADR-145). Off by default: no link and NOT FOUND. Switched
 * on: the month is assessed and shown with the disclaimer first, "Insufficient data" where a score
 * would overstate what is known, the factor cards, what is missing and what to do, and the evidence.
 */

const ORG = uniqueName('Funding Journey');
const OWNER = 'journey21-funding';

test.afterAll(() => cleanUpOwn([ORG], [OWNER]));

test('funding readiness is hidden until switched on, then honest about what it does not know', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, seedUser(OWNER));
  const slug = await onboard(page, ORG);
  await importLedger(page, slug, GL_CSV);
  await drainQueue(page, slug);

  // Off: no link, and the page does not exist.
  await page.goto(`/app/${slug}/home`);
  await expect(page.getByRole('link', { name: 'Funding', exact: true })).toHaveCount(0);
  const off = await page.goto(`/app/${slug}/funding`);
  expect(off?.status()).toBe(404);

  // On (the super admin's switch, as the platform page sets it), then the backfill runs.
  sql(`update public.organizations set features = features || '{"funding_readiness": true}' where slug = '${slug}'`);
  await drainQueue(page, slug);

  await page.goto(`/app/${slug}/home`);
  await page.getByRole('link', { name: 'Funding', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Funding Readiness' })).toBeVisible();
  await expect(page.getByText(/It is not a lender, credit, investment or funding approval rating/)).toBeVisible();
  // No bank account and no balance sheet: cash and debt are unknown, so there is no number.
  await expect(page.getByText('Insufficient data', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Existing debt' })).toBeVisible();
  await expect(page.getByText('Existing debt: Debt could not be established from the available balance-sheet data.')).toBeVisible();
  await expect(page.getByText('Import a trial balance or balance sheet so debt can be established.')).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole('link', { name: 'See the figures behind this assessment' }).click();
  await expect(page).toHaveURL(/\/evidence\/[0-9a-f-]{36}$/);
});
