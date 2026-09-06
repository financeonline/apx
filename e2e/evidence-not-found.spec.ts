import { expect, test } from '@playwright/test';
import { seededOrgSlug } from './fixtures';

/**
 * The 404 contract of the tenant shell (`ROUTE_ARCHITECTURE.md` §230; TEST_STRATEGY.md §4 case 3;
 * SECURITY_MODEL.md §14).
 *
 * Two things have to be true at once, and only one of them is visible on the screen:
 *
 *   1. the ANSWER is uniform — "not yours" and "never existed" are the same page, so a stranger
 *      cannot enumerate what exists by reading the difference;
 *   2. the STATUS is 404 — because a monitor, a crawler, a link checker and an error budget all
 *      read the status and never the page, and a 200 tells every one of them the page was fine.
 *
 * The second was silently untrue for every route under `/app/[orgSlug]` until this test existed. A
 * segment-level `loading.tsx` wraps a page in a Suspense boundary, so the response is committed
 * before the page can call `notFound()`: it could swap the body and not the status. It is why there
 * is no `loading.tsx` in this family, and why a page that needs one must put `<Suspense>` inside
 * itself, BELOW its not-found decisions (ADR-059.8).
 */

const INVENTED = '00000000-0000-4000-8000-000000000000';

test.describe('a page that is not found says so, in the status as well as the body', () => {
  test('every id-addressed route answers 404 for an id that is not there', async ({ page }) => {
    const slug = seededOrgSlug();

    const routes = [
      `evidence/${INVENTED}`,
      `insights/alerts/${INVENTED}`,
      `customers/${INVENTED}`,
      `data/imports/${INVENTED}`,
    ];

    for (const route of routes) {
      const response = await page.goto(`/app/${slug}/${route}`);
      expect(response?.status(), `/app/<org>/${route} must answer 404`).toBe(404);
      await expect(
        page.getByRole('heading', { name: /could not find that page/i }),
        `${route} must render the one uniform not-found page`,
      ).toBeVisible();
    }
  });

  test('an organisation that is not yours answers 404 too, from the shell itself', async ({ page }) => {
    const response = await page.goto('/app/not-an-organisation-that-exists/home');
    expect(response?.status()).toBe(404);
  });

  test('a route with no page at all answers the same way', async ({ page }) => {
    const response = await page.goto(`/app/${seededOrgSlug()}/no-such-section`);
    expect(response?.status()).toBe(404);
  });
});
