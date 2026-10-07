import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sql } from '../../e2e/fixtures';

/**
 * Walks every page of the sample business (loaded by 1-seed) as its owner: each page answers, shows
 * no error screen, has no serious or critical accessibility violation, and is captured as a
 * screenshot (logs/sample-data/screens). Then the features are exercised with the sample figures.
 */

const EMAIL = process.env.MOTION_SAMPLE_EMAIL ?? '';
const PASSWORD = process.env.MOTION_SAMPLE_PASSWORD ?? '';
const SLUG = process.env.MOTION_SAMPLE_SLUG ?? 'a-org';
const SHOTS = 'logs/sample-data/screens';

const PAGES = [
  'home', 'home/health', 'departments', 'insights', 'money', 'money/profit-and-loss', 'money/cash', 'money/receivables',
  'money/payables', 'money/banking', 'money/banking/transactions', 'money/budget', 'customers', 'customers/sales',
  'customers/marketing', 'customers/products', 'customers/held', 'actions', 'engagement', 'notifications', 'reports',
  'reports/custom/new', 'analyst', 'forecast', 'what-if', 'funding', 'data/imports', 'data/imports/new',
  'data/documents', 'data/accounts', 'settings', 'settings/team', 'settings/audit',
];

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/(onboarding|app|select-organization|portfolio)/, { timeout: 30_000 });
}

async function visit(page: Page, url: string, name: string) {
  const response = await page.goto(url);
  expect(response?.status(), `${url} answers`).toBeLessThan(400);
  await expect(page.locator('main'), `${url} renders its page`).toBeVisible();
  await expect(page.getByText(/something went wrong|application error/i), `${url} shows no error screen`).toHaveCount(0);
  // Contrast is measured on the settled page, after entrance animations (ADR-152).
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`), `${url} accessibility`).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.describe.configure({ mode: 'serial' });

test('every page of the sample business, as its owner', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page);
  for (const p of PAGES) await visit(page, `/app/${SLUG}/${p}`, p.replace(/\//g, '_'));
  // A few detail pages, reached the way a person reaches them.
  const customer = sql(`select c.id from public.counterparties c join public.organizations o on o.id = c.organization_id where o.slug = '${SLUG}' and c.name = 'Acme Cafés Ltd'`).trim();
  await visit(page, `/app/${SLUG}/customers/${customer}`, 'customer_acme');
  const sep = sql(`select p.id from public.fiscal_periods p join public.organizations o on o.id = p.organization_id where o.slug = '${SLUG}' and p.period_start = '2026-09-01'`).trim();
  await visit(page, `/app/${SLUG}/evidence?metric=revenue&period=${sep}`, 'evidence_revenue_sep');
  await visit(page, `/app/${SLUG}/reports/monthly/${sep}`, 'report_monthly_sep');
  for (const p of ['portfolio', 'portfolio/alerts', 'portfolio/actions', 'portfolio/analyst', 'portfolio/report']) await visit(page, `/${p}`, p.replace(/\//g, '_'));
});

test('the features, with the sample figures', async ({ page }) => {
  await signIn(page);
  const app = (p: string) => `/app/${SLUG}/${p}`;

  // Home: a Health Score for September from eight areas' rules, and the moving figures.
  await page.goto(app('home'));
  await expect(page.getByText(/Based on \d of 8 areas|out of 100|\b\d{2}\b/).first()).toBeVisible();
  // Budget against actual for September.
  await page.goto(app('money/budget'));
  await expect(page.getByText('Revenue', { exact: true }).first()).toBeVisible();
  // Funding Readiness: switched on for the sample; disclaimer first, then a score or "Insufficient data".
  await page.goto(app('funding'));
  await expect(page.getByText(/not a lender, credit, investment or funding approval rating/)).toBeVisible();
  await expect(page.getByText(/out of 100|Insufficient data/).first()).toBeVisible();
  // Can we afford it? £10,000 once, against the sample's cash forecast.
  await page.goto(app('what-if?afford_amount=10000&afford_recurrence=one_off&afford_start=1'));
  await expect(page.getByRole('region', { name: 'Affordability result' }).getByText(/^(Affordable|Tight|Not affordable)$/)).toBeVisible();
  // Reports: the scheduled briefs exist and open.
  await page.goto(app('reports'));
  await expect(page.getByRole('heading', { name: 'Daily Executive Brief' })).toBeVisible();
  // The Command Centre: both companies, opportunities section, and the portfolio report as a PDF.
  await page.goto('/portfolio');
  await expect(page.getByRole('region', { name: /every client/i }).getByRole('link', { name: 'a', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: /every client/i }).getByRole('link', { name: 'b', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Advisory opportunities' })).toBeVisible();
  const pdf = await page.request.get('/portfolio/report/pdf');
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
});
