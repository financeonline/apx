import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seededOrgSlug, sql } from './fixtures';

/**
 * Journey 3, the evidence steps (TEST_STRATEGY.md §12 journey 3; IMPLEMENTATION_PLAN.md Phase 10).
 *
 * The full journey starts at an AI answer, which is Phase 11. Its evidence half does not depend on
 * the analyst at all, and it is the half this phase is the exit gate for: from a number on the
 * screen, the drawer must walk metric → calculation → records → document, and every step must be
 * reachable by clicking rather than by knowing a URL.
 *
 * This runs against the organisation the setup project seeded, whose figures come from a real
 * import through a real calculation run.
 */

test.describe('from a figure to the rows behind it', () => {
  test('a "Why?" link walks metric → calculation → records → document', async ({ page }) => {
    const slug = seededOrgSlug();

    // ---- The figure ---------------------------------------------------------------------------
    await page.goto(`/app/${slug}/home`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Gross profit is DERIVED, so this exercises level 2 as well as levels 1 and 3.
    await page.goto(`/app/${slug}/money/profit-and-loss`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const why = page.getByRole('link', { name: /why\?/i });
    await expect(why.first(), 'every number carries a Why? (§4)').toBeVisible();
    await why.first().click();

    // ---- Level 0 and 1: the statement and the figure -------------------------------------------
    await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /what this figure rests on/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^the figure$/i })).toBeVisible();
    await expect(
      page.getByText(/version .* of the calculation engine/i),
      'the as-of run is stated, because the figure was true as of it',
    ).toBeVisible();

    // ---- Level 3: the rows, and the reconciliation that proves the figure ----------------------
    await expect(
      page.getByText(/which is the figure\./i).first(),
      'the rows behind a number must add up to it (§6)',
    ).toBeVisible();

    // ---- Level 4: the document, reached by picking a row ---------------------------------------
    const source = page.getByRole('link', { name: /source/i });
    await expect(source.first()).toBeVisible();
    await source.first().click();

    await expect(page.getByText(/gl-may\.csv/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /open the source file/i })).toBeVisible();
    await expect(
      page.getByText(/line \d+/i),
      'the reference names the line in the file, not just the file',
    ).toBeVisible();
  });

  test('a derived figure names its parts, and each part opens on its own', async ({ page }) => {
    const slug = seededOrgSlug();

    /*
     * Gross profit by name, not "the first Why? on the page". A derived metric is the whole subject
     * of this test, and a version that skipped itself when it landed on a leaf would pass forever
     * without ever checking anything.
     */
    await page.goto(`/app/${slug}/money/profit-and-loss`);
    // The accessible name carries the figure's plain label (§8.1: "Profit after direct costs").
    await page.getByRole('link', { name: /evidence behind profit after direct costs/i })
      .first().click();
    await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 30_000 });

    await expect(page.getByRole('heading', { name: /how it was worked out/i })).toBeVisible();

    const open = page.getByRole('link', { name: /^open the evidence behind/i });
    await expect(open.first()).toBeVisible();
    const before = page.url();
    await open.first().click();

    // A different bundle, not merely "a bundle url" — we are already on one of those, so matching
    // the shape would pass without the navigation ever happening.
    await page.waitForURL((url) => /\/evidence\/[0-9a-f-]{36}/.test(url.pathname)
      && url.toString() !== before, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /^the figure$/i })).toBeVisible();
    await expect(page.getByText(/which is the figure\./i).first()).toBeVisible();
  });

  /*
   * Isolation case 3 (TEST_STRATEGY.md §4): a bundle id that is not yours is indistinguishable from
   * one that never existed. Both render the one uniform not-found page (SECURITY_MODEL.md §14).
   *
   * The STATUS is 200 rather than 404, and that is worth being precise about: `[orgSlug]/loading.tsx`
   * wraps every page in this family in a Suspense boundary, so the response has already been
   * committed by the time a page calls `notFound()` — it can swap the body and not the status. It
   * is true of every page under `/app/[orgSlug]` and not of this one, and the property that carries
   * the security — that the two answers are identical — is asserted here directly.
   */
  test('a bundle that is not yours is indistinguishable from one that never existed', async ({ page }) => {
    const slug = seededOrgSlug();

    const other = sql(`
      insert into public.evidence_bundles (organization_id, kind, origin_table, created_by_type)
      select id, 'metric', 'metric_snapshots', 'system' from public.organizations
       where slug <> '${slug}' order by created_at desc limit 1
      returning id`);

    const invented = '00000000-0000-4000-8000-000000000000';
    const answers: string[] = [];
    for (const bundleId of [invented, other]) {
      await page.goto(`/app/${slug}/evidence/${bundleId}`);
      answers.push((await page.getByRole('heading').first().textContent()) ?? '');
    }

    expect(answers[0]).toMatch(/could not find that page/i);
    expect(answers[1], 'someone else’s bundle reads exactly as an invented one').toBe(answers[0]);
  });

  /*
   * §11, on the surface most likely to break it.
   *
   * The drawer is the one page in the product with a wide data table on it, and a wide table inside
   * a narrow phone is exactly where a horizontal scroll appears — `TableWrap`'s own overflow rule
   * has been wrong before (ADR-058.12). Checked here rather than in the sweep because the route
   * needs a bundle id, and a bundle id has to be walked to.
   */
  test('the drawer is accessible, and does not scroll sideways on a phone', async ({ page }) => {
    const slug = seededOrgSlug();
    await page.goto(`/app/${slug}/money/profit-and-loss`);
    await page.getByRole('link', { name: /why\?/i }).first().click();
    await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByRole('heading').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(
      serious.map((v) => `${v.id} (${v.impact}) — ${v.nodes[0]?.target.join(' ')}`),
      'the evidence drawer must have no serious or critical accessibility violations',
    ).toEqual([]);

    for (const width of [320, 375, 768]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.getByRole('heading').first()).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `the drawer must not scroll sideways at ${width}px`).toBeLessThanOrEqual(1);
    }
  });
});
