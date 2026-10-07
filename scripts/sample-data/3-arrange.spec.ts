import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Home's headline cards can be put in the reader's own order (the draggable widget grid): with the
 * keyboard (Alt + arrow keys) and the mouse, remembered in the browser for the company, and reset.
 * Outside "Arrange cards" the cards' links work as usual.
 */

const EMAIL = process.env.MOTION_SAMPLE_EMAIL ?? '';
const PASSWORD = process.env.MOTION_SAMPLE_PASSWORD ?? '';
const SLUG = process.env.MOTION_SAMPLE_SLUG ?? 'a-org';

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/(onboarding|app|select-organization|portfolio)/, { timeout: 30_000 });
}

/** Card names in reading order (the grid exposes it through aria-posinset). */
async function readingOrder(page: Page): Promise<string[]> {
  const cards = page.locator('[data-testid="arrangeable-cards"] [data-slot="widget"]');
  const rows = await cards.evaluateAll((els) =>
    els.map((el) => [Number(el.getAttribute('aria-posinset')), el.getAttribute('aria-label') ?? ''] as const));
  return [...rows].sort((a, b) => a[0] - b[0]).map(([, label]) => label);
}

test('arrange Home cards: keyboard, mouse, remembered, reset', async ({ page }) => {
  await signIn(page);
  await page.goto(`/app/${SLUG}/home`);
  await page.evaluate((slug) => localStorage.removeItem(`motion.home.card-order.${slug}`), SLUG);
  await page.reload();

  const grid = page.getByTestId('arrangeable-cards');
  await expect(grid.locator('[data-slot="widget"]')).toHaveCount(6);
  const original = await readingOrder(page);

  // Not arranging: cards are not focusable widgets and "Why?" links work.
  await expect(grid.locator('[data-slot="widget"][tabindex="0"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Arrange cards' }).click();
  await expect(page.getByRole('button', { name: 'Done' })).toHaveAttribute('aria-pressed', 'true');
  // Let the button's colour transition and the cards' entrance finish before measuring contrast.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  await page.waitForTimeout(800);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

  // Keyboard: the first card moves one place on.
  const first = grid.locator(`[data-slot="widget"][aria-label="${original[0]}"]`);
  await first.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => readingOrder(page)).toEqual([original[1], original[0], ...original.slice(2)]);
  await expect(first).toBeFocused();

  // Mouse: drag the last card onto the first slot.
  const last = grid.locator(`[data-slot="widget"][aria-label="${original[5]}"]`);
  const target = grid.locator(`[data-slot="widget"][aria-posinset="1"]`);
  await grid.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(800); // the keyboard move's slide (a JS spring) settles before measuring
  const from = (await last.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(
      from.x + from.width / 2 + ((to.x - from.x) * i) / 20,
      from.y + from.height / 2 + ((to.y - from.y) * i) / 20,
    );
    await page.waitForTimeout(16); // a frame between moves, as a hand makes them
  }
  await page.waitForTimeout(300);
  await page.mouse.up();
  await expect.poll(async () => (await readingOrder(page))[0]).toBe(original[5]);
  const arranged = await readingOrder(page);

  await page.getByRole('button', { name: 'Done' }).click();

  // Remembered for the company, after a reload.
  await page.reload();
  await expect.poll(() => readingOrder(page)).toEqual(arranged);

  // Outside arranging, a card's "Why?" link still opens the evidence.
  await grid.getByRole('link', { name: 'Why?' }).first().click();
  await page.waitForURL(/\/evidence/);
  await page.goBack();

  // Reset puts the default order back, and it stays back.
  await page.getByRole('button', { name: 'Arrange cards' }).click();
  await page.getByRole('button', { name: 'Reset order' }).click();
  await expect.poll(() => readingOrder(page)).toEqual(original);
  await page.reload();
  await expect.poll(() => readingOrder(page)).toEqual(original);
});
