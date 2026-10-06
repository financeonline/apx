import { expect, test } from '@playwright/test';
import {
  cleanUpOwn, drainQueue, GL_CSV, importLedger, seedUser, signIn, sql, uniqueName,
} from './fixtures';

/**
 * Journey 15 — the Command Centre (SOW §18; ADR-112).
 *
 * An owner of two organisations lands on one screen that says which needs attention, and a client
 * of one of them is told nothing about a portfolio at all: the same uniform 404 a stranger gets.
 * Runs as an owner because a platform employee's browser session needs TOTP; the employee boundary
 * is proven at the database and the API in `test/integration/portfolio.test.ts`.
 */

const ORG_A = uniqueName('Centre Alpha');
const ORG_B = uniqueName('Centre Beta');
const SHOTS = 'e2e/.shots';

test.afterAll(() => cleanUpOwn([ORG_A, ORG_B], ['j15-owner', 'j15-client']));

test('an owner of two organisations sees both on the Command Centre; a client sees no portfolio', async ({ page }) => {
  const owner = seedUser('j15-owner');
  const client = seedUser('j15-client');
  await signIn(page, owner);

  // ---- Two organisations, one with figures --------------------------------------------------
  const onboard = async (name: string) => {
    await page.goto('/onboarding');
    await page.getByLabel(/name/i).first().fill(name);
    await page.getByRole('button', { name: /create|continue|get started/i }).first().click();
    await page.waitForURL(/\/app\/[^/]+\/home/, { timeout: 30_000 });
    return page.url().match(/\/app\/([^/]+)\//)![1]!;
  };
  const slugA = await onboard(ORG_A);
  await importLedger(page, slugA, GL_CSV);
  await drainQueue(page, slugA);
  // A second organisation, created by the product's own RPC as this owner: onboarding is a
  // first-organisation form, and the switcher has no "create another" (a settings concern).
  const orgA = sql(`select id from public.organizations where slug = '${slugA}'`);
  const orgB = sql(`select api.create_organization('${ORG_B}')
    from (select set_config('request.jwt.claims', '{"sub":"${owner.userId}","role":"authenticated","aal":"aal1","email":"${owner.email}"}', true) as c) s
    where s.c is not null`);
  const slugB = sql(`select slug from public.organizations where id = '${orgB}'`);

  // A serious alert and an overdue action in A, seeded the way the jobs write them, so the queue
  // has something deterministic to rank.
  const periodA = sql(`select id from public.fiscal_periods where organization_id = '${orgA}' and period_start = '2026-05-01'`);
  sql(`insert into public.actions (organization_id, title, priority, due_date, status, source_type, created_by)
       values ('${orgA}', 'Chase the two largest unpaid invoices', 'high', '2026-01-15', 'open', 'user', '${owner.userId}')`);
  const runA = sql(`with q as (insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
       values ('${orgA}', 'recalc_manual', '1.0.0', '${periodA}', '${periodA}', '2026-06-15', 'succeeded') returning id) select id from q`);
  sql(`insert into public.alerts (organization_id, period_id, rule_key, rule_version, severity, key_kind, calculation_run_id, title, explanation, status, first_seen_at, dedupe_key)
       values ('${orgA}', '${periodA}', 'cash.runway_low', '1', 'critical', 'state', '${runA}', 'Cash runway is under two months', 'Seeded for journey 15.', 'open', now(), 'j15-${slugA}')`);

  // ---- The Command Centre ----------------------------------------------------------------------
  const response = await page.goto('/portfolio');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/1 of 2 clients need attention/i);

  const queue = page.getByRole('region', { name: /clients needing attention/i });
  await expect(queue.getByRole('link', { name: ORG_A, exact: true })).toBeVisible();
  await expect(queue.getByText(/1 critical alert/i)).toBeVisible();
  await expect(queue.getByText(/1 overdue action/i)).toBeVisible();
  await expect(queue.getByRole('link', { name: ORG_B, exact: true })).toHaveCount(0);

  const clients = page.getByRole('region', { name: /every client/i });
  await expect(clients.getByRole('link', { name: ORG_A, exact: true })).toBeVisible();
  await expect(clients.getByRole('link', { name: ORG_B, exact: true })).toBeVisible();
  await expect(clients.getByRole('cell', { name: /not yet scored/i })).toBeVisible();

  await page.screenshot({ path: `${SHOTS}/command-centre-1440.png`, fullPage: true });

  // ---- Advisory opportunities (ADR-148): A's latest month shows campaigns paying back ----------
  sql(`set session_replication_role = replica;
       update public.health_scores set breakdown = coalesce((select jsonb_agg(d) from jsonb_array_elements(breakdown) d where d->>'key' <> 'marketing_efficiency'), '[]'::jsonb)
         || '[{"key":"marketing_efficiency","included":true,"score":80,"rules":[{"rule":"M1","points":20,"result":">= 3x","value":"3.2","skipped_reason":null}]}]'::jsonb
        where id in (select health_score_id from public.health_current where organization_id = '${orgA}')`);
  await page.reload();
  const opportunities = page.getByRole('region', { name: /advisory opportunities/i });
  await expect(opportunities.getByRole('link', { name: ORG_A, exact: true })).toBeVisible();
  await expect(opportunities.getByText('Campaigns paying back', { exact: true })).toBeVisible();
  await expect(opportunities.getByText(/Because: Marketing scores 80/)).toBeVisible();
  await opportunities.getByRole('link', { name: ORG_A, exact: true }).click();
  await page.waitForURL(new RegExp(`/portfolio/clients/${orgA}`));
  const clientOpps = page.getByRole('region', { name: /advisory opportunities/i });
  await clientOpps.getByRole('button', { name: 'Record as an action' }).first().click();
  await expect(clientOpps.getByText(`Added to ${ORG_A}'s Action Centre.`)).toBeVisible({ timeout: 15_000 });
  expect(sql(`select count(*) from public.actions where organization_id = '${orgA}' and source_type = 'health_score' and title = 'Campaigns paying back'`)).toBe('1');
  // ---- The Portfolio Report (ADR-149): on screen and as a PDF -----------------------------------
  await page.goto('/portfolio/report');
  await expect(page.getByRole('heading', { level: 1, name: 'Portfolio Report' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: ORG_A })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: ORG_B })).toBeVisible();
  await expect(page.getByText(/Opportunity: Campaigns paying back/)).toBeVisible();
  const pdf = await page.request.get('/portfolio/report/pdf');
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
  await page.goto('/portfolio');

  // ---- Drill-down: the client brief, then the organisation's own alert page --------------------
  await queue.getByRole('link', { name: /why, and what next/i }).first().click();
  await page.waitForURL(new RegExp(`/portfolio/clients/${orgA}`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(ORG_A);
  await expect(page.getByText(/cash runway is under two months/i)).toBeVisible();
  await page.getByRole('link', { name: /cash runway is under two months/i }).click();
  await page.waitForURL(new RegExp(`/app/${slugA}/insights/alerts/`));

  // ---- Alerts and actions across the portfolio ----------------------------------------------------
  await page.goto('/portfolio/alerts');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/1 alert standing/i);
  await page.goto('/portfolio/actions?view=overdue');
  await expect(page.getByRole('link', { name: /chase the two largest unpaid invoices/i })).toBeVisible();
  await page.goto('/portfolio/analyst');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/adviser analyst/i);
  await expect(page.getByRole('button', { name: /^ask$/i })).toBeVisible();

  // The badge is the server's stored grounding status, never a client-side judgement (ADR-115). No
  // model runs in this environment, so two answered turns are stored the way the server finishes
  // them — one the grounder degraded, one it passed — and the page must label each accordingly.
  const storeTurn = (question: string, grounding: 'passed' | 'degraded') => {
    const answer = JSON.stringify({
      briefing: { mode: 'answer', headline: { text: `${ORG_A} needs attention.`, facts: [] }, clients: [], notes: [], limitations: [] },
      clients: [], refs: [],
    });
    sql(`with q as (insert into public.portfolio_ai_turns (user_id, question, scope_organization_ids, status, answer, grounding_status, prompt_version, finished_at)
         values ('${owner.userId}', '${question}', array['${orgA}']::uuid[], 'answered', '${answer}'::jsonb, '${grounding}', 'adviser-v4.0', now())
         returning id) select id from q`);
  };
  storeTurn('What changed at Alpha this month', 'degraded');
  storeTurn('Which clients need attention', 'passed');
  await page.reload();
  const answerCard = (question: string) => page.locator('section')
    .filter({ has: page.getByRole('heading', { level: 2, name: question, exact: true }) })
    .filter({ hasNot: page.getByRole('heading', { name: /recent answers/i }) });
  await expect(answerCard('What changed at Alpha this month').getByText('Partly grounded', { exact: true })).toBeVisible();
  await expect(answerCard('What changed at Alpha this month').getByText('Grounded', { exact: true })).toHaveCount(0);
  await expect(answerCard('Which clients need attention').getByText('Grounded', { exact: true })).toBeVisible();

  // ---- Small screens: usable, no sideways scrolling --------------------------------------------
  for (const [label, width] of [['375', 375], ['768', 768]] as const) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/portfolio', '/portfolio/alerts', '/portfolio/actions', '/portfolio/analyst', `/portfolio/clients/${orgA}`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} at ${label}px must not scroll sideways`).toBe(0);
    }
    await page.goto('/portfolio');
    await page.screenshot({ path: `${SHOTS}/command-centre-${label}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---- A client of B: no portfolio, and no confirmation that one exists ---------------------------
  sql(`insert into public.organization_memberships (organization_id, user_id, role, status)
       values ('${orgB}', '${client.userId}', 'client', 'active')`);
  await page.context().clearCookies();
  await signIn(page, client);
  expect((await page.goto(`/app/${slugB}/home`))?.status()).toBe(200);
  for (const path of ['/portfolio', '/portfolio/alerts', '/portfolio/actions', '/portfolio/analyst', `/portfolio/clients/${orgB}`, `/portfolio/clients/${orgA}`]) {
    expect((await page.goto(path))?.status(), `${path} is a uniform 404 for a client`).toBe(404);
  }
});
