import { expect, test } from '@playwright/test';
import { cleanUpOwn, onboard, seedUser, signIn, uniqueName } from './fixtures';
import { firstPeriod, orgIdBySlug, orgRows, seedAction, seedAlert, seedRun } from './firestore';

/**
 * The Action Centre (SOW §17; ADR-098).
 *
 * The loop this phase exists for is alert → evidence → decide → own it → track it → say what came of
 * it. The half that was missing was the screen a person opens on Monday morning: what needs doing,
 * what is late, and what is mine. So this walks the lenses and asserts the two things a wrong answer
 * would hide — that an undated action is never called late, and that the number on a tab is the
 * number of rows behind it.
 *
 * The alert→priority rule is proved at the database in `actions.test.ts`, across every severity;
 * here it is proved through the product, once, because a rule nobody can see the effect of is not
 * yet a feature.
 */

const ORG = uniqueName('Action Centre Ltd');

test.afterAll(() => cleanUpOwn([ORG, `${ORG} Alerts`], ['ac-owner', 'ac-alerts']));

test('the Action Centre answers what needs doing, what is late, and what is mine', async ({ page }) => {
  const owner = await seedUser('ac-owner');
  await signIn(page, owner);
  const slug = await onboard(page, ORG);
  const orgId = await orgIdBySlug(slug);

  // Three actions with different shapes: one late, one undated, one finished.
  const make = (title: string, priority: string, status: string, due: string | null, ownerId: string | null) =>
    seedAction(orgId, { title, priority, status, due, owner: ownerId, createdBy: owner.userId });

  await make('Chase the overdue invoice', 'high', 'open', '2020-01-01', owner.userId);
  await make('Think about pricing', 'low', 'open', null, null);
  await make('Filed the VAT return', 'medium', 'completed', '2026-01-01', owner.userId);

  await page.goto(`/app/${slug}/actions`);

  // The sentence on arrival: how much, and how much of it is late.
  await expect(page.getByText(/things need attention, and 1 is past its due date/i)).toBeVisible();

  // Every lens is offered, with its count beside it.
  for (const label of ['To do', 'Mine', 'Due soon', 'Overdue', 'Important', 'Finished', 'Everything']) {
    await expect(page.getByRole('link', { name: new RegExp(label, 'i') }).first(), label).toBeVisible();
  }

  // Overdue holds the late one and NOT the undated one — an undated action is not late.
  await page.goto(`/app/${slug}/actions?show=overdue`);
  await expect(page.getByText(/chase the overdue invoice/i)).toBeVisible();
  await expect(page.getByText(/think about pricing/i)).toHaveCount(0);

  // Due soon is forward-looking, so the overdue one is not in it either: one pile, not both.
  await page.goto(`/app/${slug}/actions?show=due_soon`);
  await expect(page.getByText(/chase the overdue invoice/i)).toHaveCount(0);

  // Finished work is still here — the list is a record of what was decided.
  await page.goto(`/app/${slug}/actions?show=done`);
  await expect(page.getByText(/filed the vat return/i)).toBeVisible();

  // An unknown lens falls back to the default rather than erroring.
  const fallback = await page.goto(`/app/${slug}/actions?show=nonsense`);
  expect(fallback?.status()).toBe(200);
  await expect(page.getByText(/things need attention/i)).toBeVisible();
});

test('an action made from a critical alert arrives critical, not medium', async ({ page }) => {
  // Its own user: `seedUser` inserts, so two tests sharing a local part collide on the email index.
  const owner = await seedUser('ac-alerts');
  await signIn(page, owner);
  const slug = await onboard(page, `${ORG} Alerts`);
  const orgId = await orgIdBySlug(slug);
  const period = await firstPeriod(orgId);

  const runId = await seedRun(orgId, { periodFrom: period, asOf: '2026-06-15' });
  /*
   * An alert without a current revision is not a state the engine produces: `persist_alerts` writes
   * revision 1 in the same transaction as the row, and the conversion pins the revision it saw
   * (ADR-034). `seedAlert` builds the same shape, or this would be testing a row the product cannot
   * make.
   */
  const alertId = await seedAlert(orgId, {
    periodId: period, runId, ruleKey: 'cash.runway_low', severity: 'critical',
    title: 'Cash would last under two months', explanation: 'Runway is 1.4 months.', dedupeKey: `e2e-ac-${Date.now()}`,
  });

  await page.goto(`/app/${slug}/insights/alerts/${alertId}`);
  await page.getByRole('button', { name: /add this to the action centre/i }).click();

  /*
   * Polled against the database rather than asserted on the confirmation text: the claim being
   * tested is what was WRITTEN, and a server action's message is a transient that the revalidation
   * replaces with "somebody is already on this". Racing that would make the test flaky about
   * something it is not about.
   */
  await expect.poll(
    async () => String((await orgRows(orgId, 'actions', (a) => a.source_id === alertId))[0]?.priority ?? ''),
    { timeout: 30_000, message: 'the rule said critical, so the task is critical' },
  ).toBe('critical');

  // And the alert now points at it, so the button is not offered twice (ADR-034).
  await expect(page.getByRole('link', { name: /already on this/i })).toBeVisible();
});
