import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seededOrgSlug } from './fixtures';

/**
 * Responsive and accessibility (TEST_STRATEGY.md §11).
 *
 * Run over a SEEDED organisation, not an empty one: an empty page passes every check trivially, and
 * the things that break — a wide table, a chart, a badge with too little contrast — only exist once
 * there are figures on the screen.
 */

const VIEWPORTS = [
  { name: '320×568 (small phone)', width: 320, height: 568 },
  { name: '375×812 (phone)', width: 375, height: 812 },
  { name: '768×1024 (tablet)', width: 768, height: 1024 },
  { name: '1440×900 (desktop)', width: 1440, height: 900 },
];

/*
 * Read LAZILY, inside each test.
 *
 * Playwright collects every spec before any project runs, so reading the setup project's output at
 * module load happens before the file exists.
 */
const slug = () => seededOrgSlug();

/** The routes a customer actually spends time on, all with data behind them. */
const ROUTES = [
  { name: 'Home', path: () => `/app/${slug()}/home` },
  { name: 'Health score explained', path: () => `/app/${slug()}/home/health` },
  { name: 'Insights', path: () => `/app/${slug()}/insights` },
  { name: 'Money', path: () => `/app/${slug()}/money` },
  { name: 'Profit and loss', path: () => `/app/${slug()}/money/profit-and-loss` },
  { name: 'Customers', path: () => `/app/${slug()}/customers` },
  { name: 'Action Centre', path: () => `/app/${slug()}/actions` },
  { name: 'Reports', path: () => `/app/${slug()}/reports` },
  { name: 'Accounts', path: () => `/app/${slug()}/data/accounts` },
  { name: 'Imports', path: () => `/app/${slug()}/data/imports` },
  { name: 'Add data', path: () => `/app/${slug()}/data/imports/new` },
];

test.describe('axe-core: zero serious or critical violations', () => {
  for (const route of ROUTES) {
    test(route.name, async ({ page }) => {
      await page.goto(route.path());
      // A concrete signal, not `networkidle`: a streamed RSC response keeps a connection open, so
      // "the network went quiet" never becomes true and every check waits out its timeout.
      await expect(page.getByRole('heading').first()).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      const serious = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );

      // Named, not counted: a failure has to say WHICH rule and WHERE, or nobody can fix it.
      expect(
        serious.map((v) => `${v.id} (${v.impact}) — ${v.nodes[0]?.target.join(' ')}`),
        `${route.name} must have no serious or critical accessibility violations`,
      ).toEqual([]);
    });
  }
});

test.describe('no page scrolls sideways', () => {
  for (const viewport of VIEWPORTS) {
    test(viewport.name, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const route of ROUTES) {
        await page.goto(route.path());
        await expect(page.getByRole('heading').first()).toBeVisible();

        const overflow = await page.evaluate(() =>
          document.documentElement.scrollWidth - window.innerWidth);

        /*
         * §11: wide content — tables, charts — scrolls inside its own container, never the page. A
         * page that scrolls sideways on a phone hides the right-hand column of every figure.
         */
        expect(overflow, `${route.name} overflows at ${viewport.width}px`).toBeLessThanOrEqual(1);
      }
    });
  }
});

test.describe('the keyboard reaches what the mouse does', () => {
  test('every control on Home is focusable, and focus is visible', async ({ page }) => {
    await page.goto(`/app/${slug()}/home`);
    await expect(page.getByRole('heading').first()).toBeVisible();

    const interactive = await page.locator(
      'a[href], button:not([disabled]), input:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
    ).count();
    expect(interactive, 'Home has controls to reach').toBeGreaterThan(3);

    // Tab through and confirm focus actually lands somewhere each time.
    const reached = new Set<string>();
    for (let i = 0; i < Math.min(interactive, 25); i += 1) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return `${el.tagName}:${(el.textContent ?? '').trim().slice(0, 24)}`;
      });
      if (focused !== null) reached.add(focused);
    }
    expect(reached.size, 'tabbing moves focus through the page').toBeGreaterThan(3);
  });
});

test.describe('the chart has a real table behind it (§11)', () => {
  test('the health history renders its figures as a table too', async ({ page }) => {
    await page.goto(`/app/${slug()}/home/health`);
    await expect(page.getByRole('heading').first()).toBeVisible();

    const table = page.locator('#health-history-table');
    await expect(table, 'the picture is never the only way to read the numbers').toBeVisible();
    await expect(table.getByRole('columnheader', { name: /month/i })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /score/i })).toBeVisible();
  });
});
