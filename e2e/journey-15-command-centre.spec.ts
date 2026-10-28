import { expect, test } from '@playwright/test';
import {
  cleanUpOwn, drainQueue, GL_CSV, importLedger, seedUser, signIn, uniqueName,
} from './fixtures';
import {
  addAssignment, addMembership, addPlatformUser, backend, callAs, orgIdBySlug, orgRows, periodOf, seedAction, seedAlert,
  seedRun,
} from './firestore';

/**
 * Journey 15 — the Command Centre (SOW §18; ADR-112, as amended 2026-10-14).
 *
 * The Command Centre is APX staff only (owner, 2026-10-14: "only the app owner can see everything";
 * ADR-112 addendum). A company owner of two organisations is told nothing about a portfolio — the
 * uniform 404 at every `/portfolio` URL, and no Command Centre on the organisation picker. A
 * Financial Analyst (platform `employee`) assigned to both lands on one screen that says which needs
 * attention; and a client of one of them gets the same uniform 404 a stranger gets. The super admin's
 * view, and every boundary at the database and the API, are proven in
 * `test/integration/portfolio*.test.ts` — there is one super admin (ADR-159), and a journey never
 * signs in as a real account.
 */

const ORG_A = uniqueName('Centre Alpha');
const ORG_B = uniqueName('Centre Beta');
const SHOTS = 'e2e/.shots';

test.afterAll(() => cleanUpOwn([ORG_A, ORG_B], ['j15-owner', 'j15-adviser', 'j15-client']));

const PORTFOLIO_PATHS = ['/portfolio', '/portfolio/alerts', '/portfolio/actions', '/portfolio/analyst', '/portfolio/report'];

test('an employee assigned two organisations sees both on the Command Centre; their owner and a client see no portfolio', async ({ page }) => {
  const owner = await seedUser('j15-owner');
  const adviser = await seedUser('j15-adviser');
  const client = await seedUser('j15-client');
  // A Financial Analyst: a platform employee, signed in with a password like everyone else (ADR-161).
  await addPlatformUser(adviser.userId, 'employee');
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
  // A second organisation, created by the product's own function as this owner: onboarding is a
  // first-organisation form, and the switcher has no "create another" (a settings concern).
  const orgA = await orgIdBySlug(slugA);
  const orgB = await callAs<string>(owner.userId, 'create_organization', { p_name: ORG_B });
  const { setup } = await backend();
  const slugB = String((await setup.fs().collection('organizations').doc(orgB).get()).get('slug'));

  // A serious alert and an overdue action in A, seeded the way the jobs write them, so the queue
  // has something deterministic to rank.
  const periodA = await periodOf(orgA, '2026-05-01');
  await seedAction(orgA, {
    title: 'Chase the two largest unpaid invoices', priority: 'high', due: '2026-01-15', status: 'open', createdBy: owner.userId,
  });
  const runA = await seedRun(orgA, { periodFrom: periodA, asOf: '2026-06-15' });
  await seedAlert(orgA, {
    periodId: periodA, runId: runA, ruleKey: 'cash.runway_low', severity: 'critical',
    title: 'Cash runway is under two months', explanation: 'Seeded for journey 15.', dedupeKey: `j15-${slugA}`,
  });

  // ---- The owner of both: no Command Centre, and nothing that says one exists --------------------
  for (const path of [...PORTFOLIO_PATHS, `/portfolio/clients/${orgA}`]) {
    expect((await page.goto(path))?.status(), `${path} is a uniform 404 for a company owner`).toBe(404);
  }
  // Two organisations put the owner on the picker, which offers the Command Centre to staff only.
  await page.goto('/select-organization');
  await expect(page.getByRole('heading', { level: 1, name: /choose an organisation/i })).toBeVisible();
  await expect(page.getByRole('link', { name: ORG_A })).toBeVisible();
  await expect(page.getByRole('link', { name: /command centre/i })).toHaveCount(0);

  // ---- The Financial Analyst assigned to both ----------------------------------------------------
  await addAssignment(orgA, adviser.userId);
  await addAssignment(orgB, adviser.userId);
  await page.context().clearCookies();
  await signIn(page, adviser);

  // ---- The Command Centre ----------------------------------------------------------------------
  const response = await page.goto('/portfolio');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/1 of 2 clients need attention/i);

  const queue = page.getByRole('region', { name: /clients needing attention/i });
  // The whole card opens the client; its one link is "Why, and what next", so the name is a heading.
  await expect(queue.getByRole('heading', { name: ORG_A, exact: true })).toBeVisible();
  await expect(queue.getByText(/1 critical alert/i)).toBeVisible();
  await expect(queue.getByText(/1 overdue action/i)).toBeVisible();
  await expect(queue.getByRole('heading', { name: ORG_B, exact: true })).toHaveCount(0);

  const clients = page.getByRole('region', { name: /every client/i });
  await expect(clients.getByRole('link', { name: ORG_A, exact: true })).toBeVisible();
  await expect(clients.getByRole('link', { name: ORG_B, exact: true })).toBeVisible();
  await expect(clients.getByRole('cell', { name: /not yet scored/i })).toBeVisible();

  await page.screenshot({ path: `${SHOTS}/command-centre-1440.png`, fullPage: true });

  // ---- Advisory opportunities (ADR-148): A's latest month shows campaigns paying back ----------
  // Written straight onto A's current scores: a health score is immutable to the product, and there
  // are no triggers to step around now — the document simply says what the engine would have.
  {
    const { schema } = await backend();
    const marketing = {
      key: 'marketing_efficiency', included: true, score: 80,
      rules: [{ rule: 'M1', points: 20, result: '>= 3x', value: '3.2', skipped_reason: null }],
    };
    for (const current of await orgRows(orgA, 'health_current')) {
      const ref = schema.orgRow(setup.fs(), orgA, 'health_scores', String(current.health_score_id));
      const breakdown = ((await ref.get()).get('breakdown') ?? []) as Array<{ key?: unknown }>;
      await ref.update({ breakdown: [...breakdown.filter((d) => d.key !== 'marketing_efficiency'), marketing] });
    }
  }
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
  expect((await orgRows(orgA, 'actions', (a) => a.source_type === 'health_score' && a.title === 'Campaigns paying back')).length).toBe(1);
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
  const storeTurn = async (question: string, grounding: 'passed' | 'degraded') => {
    const { schema } = await backend();
    const answer = {
      briefing: { mode: 'answer', headline: { text: `${ORG_A} needs attention.`, facts: [] }, clients: [], notes: [], limitations: [] },
      clients: [], refs: [],
    };
    // The document `portfolio_ai_start_turn` creates once `portfolio_ai_finish_turn` has answered it
    // (src/db/api_server/ai.ts), with every field present.
    const id = schema.newId();
    const now = schema.nowIso();
    await schema.globalRow(setup.fs(), 'portfolio_ai_turns', id).set({
      id, user_id: adviser.userId, question, scope_organization_ids: [orgA], status: 'answered', answer,
      grounding_status: grounding, model: null, prompt_version: 'adviser-v4.0', input_tokens: null,
      output_tokens: null, created_at: now, finished_at: now,
    });
  };
  await storeTurn('What changed at Alpha this month', 'degraded');
  await storeTurn('Which clients need attention', 'passed');
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
  await addMembership(orgB, client.userId, 'client');
  await page.context().clearCookies();
  await signIn(page, client);
  expect((await page.goto(`/app/${slugB}/home`))?.status()).toBe(200);
  for (const path of [...PORTFOLIO_PATHS, `/portfolio/clients/${orgB}`, `/portfolio/clients/${orgA}`]) {
    expect((await page.goto(path))?.status(), `${path} is a uniform 404 for a client`).toBe(404);
  }
});
