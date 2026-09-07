import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seededOrgSlug, sql } from './fixtures';

/**
 * The Monthly Management Report on screen and as a PDF (ADR-024; plan Phase 13).
 *
 * Runs against the organisation the setup project seeded, whose figures come from a real import
 * through a real calculation run — so "the report agrees with Home" is checked against numbers a
 * person could have produced rather than against a fixture.
 */

test.describe('the monthly report', () => {
  test('opens from the list and shows the same figures Home does', async ({ page }) => {
    const slug = seededOrgSlug();

    await page.goto(`/app/${slug}/home`);
    const homeRevenue = await page.getByText('£40,000').first().textContent();
    expect(homeRevenue).toContain('£40,000');

    await page.goto(`/app/${slug}/reports`);
    await expect(page.getByRole('heading', { name: /monthly management report/i })).toBeVisible();

    await page.getByRole('link', { name: /open the report/i }).first().click();
    await page.waitForURL(/\/reports\/monthly\/[0-9a-f-]{36}/, { timeout: 30_000 });

    await expect(page.getByRole('heading', { name: /the headline numbers/i })).toBeVisible();
    await expect(
      page.getByText('£40,000').first(),
      'the report prints the figure the screen shows',
    ).toBeVisible();
    await expect(
      page.getByText(/figures as calculated on/i),
      'a printed page says which run produced it',
    ).toBeVisible();
  });

  test('produces a PDF, and opening it is a deliberate second step', async ({ page }) => {
    const slug = seededOrgSlug();
    await page.goto(`/app/${slug}/reports`);
    await page.getByRole('link', { name: /open the report/i }).first().click();
    await page.waitForURL(/\/reports\/monthly\/([0-9a-f-]{36})/, { timeout: 30_000 });
    const periodId = /\/reports\/monthly\/([0-9a-f-]{36})/.exec(page.url())![1]!;

    await page.getByRole('button', { name: /produce a pdf/i }).click();
    await expect(page.getByText(/we are producing the pdf/i)).toBeVisible({ timeout: 30_000 });

    // The job is queued, not run inline: the button asks, the worker renders.
    expect(
      Number(sql(`
        select count(*) from public.jobs j
         join public.organizations o on o.id = j.organization_id
        where o.slug = '${slug}' and j.job_type = 'report.render'
          and j.payload->>'periodId' = '${periodId}'`).trim()),
      'a render was queued',
    ).toBeGreaterThan(0);
  });

  test('is accessible and does not scroll sideways on a phone', async ({ page }) => {
    const slug = seededOrgSlug();
    await page.goto(`/app/${slug}/reports`);
    await page.getByRole('link', { name: /open the report/i }).first().click();
    await page.waitForURL(/\/reports\/monthly\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByRole('heading').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id} — ${v.nodes[0]?.target.join(' ')}`),
      'the report must have no serious or critical accessibility violations',
    ).toEqual([]);

    for (const width of [320, 375, 768]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.getByRole('heading').first()).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `the report must not scroll sideways at ${width}px`).toBeLessThanOrEqual(1);
    }
  });
});
