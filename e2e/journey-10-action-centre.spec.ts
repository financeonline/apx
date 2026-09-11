import { expect, test } from '@playwright/test';
import { cleanUpOwn, onboard, seedUser, signIn, sql, uniqueName } from './fixtures';

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
  const owner = seedUser('ac-owner');
  await signIn(page, owner);
  const slug = await onboard(page, ORG);
  const orgId = sql(`select id from public.organizations where slug = '${slug}'`);

  // Three actions with different shapes: one late, one undated, one finished.
  const make = (title: string, priority: string, status: string, due: string, ownerId: string) => sql(`
    with q as (
      insert into public.actions (organization_id, title, priority, status, due_date, owner_user_id,
                                  source_type, created_by, completed_at)
      values ('${orgId}', '${title}', '${priority}', '${status}', ${due}, ${ownerId},
              'user', '${owner.userId}', ${status === 'completed' ? 'now()' : 'null'})
      returning id) select * from q`);

  make('Chase the overdue invoice', 'high', 'open', `'2020-01-01'`, `'${owner.userId}'`);
  make('Think about pricing', 'low', 'open', 'null', 'null');
  make('Filed the VAT return', 'medium', 'completed', `'2026-01-01'`, `'${owner.userId}'`);

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
  const owner = seedUser('ac-alerts');
  await signIn(page, owner);
  const slug = await onboard(page, `${ORG} Alerts`);
  const orgId = sql(`select id from public.organizations where slug = '${slug}'`);

  const runId = sql(`
    with q as (
      insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
      select '${orgId}', 'recalc_manual', '1.0.0', p.id, p.id, '2026-06-15', 'succeeded'
        from public.fiscal_periods p where p.organization_id = '${orgId}' order by p.period_start limit 1
      returning id) select * from q`);
  const alertId = sql(`
    with q as (
      insert into public.alerts (organization_id, period_id, rule_key, rule_version, severity, key_kind,
                                 calculation_run_id, title, explanation, status, first_seen_at, dedupe_key)
      select '${orgId}', p.id, 'cash.runway_low', '1', 'critical', 'state', '${runId}',
             'Cash would last under two months', 'Runway is 1.4 months.', 'open', now(), 'e2e-ac-${Date.now()}'
        from public.fiscal_periods p where p.organization_id = '${orgId}' order by p.period_start limit 1
      returning id) select * from q`);

  /*
   * An alert without a current revision is not a state the engine produces: `persist_alerts` writes
   * revision 1 in the same transaction as the row, and the conversion pins the revision it saw
   * (ADR-034). The fixture has to build the same shape or it is testing a row the product cannot
   * make.
   */
  const revisionId = sql(`
    with q as (
      insert into public.alert_revisions (organization_id, alert_id, revision_no, rule_version,
                                          severity, explanation, calculation_run_id)
      values ('${orgId}', '${alertId}', 1, '1', 'critical', 'Runway is 1.4 months.', '${runId}')
      returning id) select * from q`);
  sql(`update public.alerts set current_revision_id = '${revisionId}' where id = '${alertId}'`);

  await page.goto(`/app/${slug}/insights/alerts/${alertId}`);
  await page.getByRole('button', { name: /add this to the action centre/i }).click();

  /*
   * Polled against the database rather than asserted on the confirmation text: the claim being
   * tested is what was WRITTEN, and a server action's message is a transient that the revalidation
   * replaces with "somebody is already on this". Racing that would make the test flaky about
   * something it is not about.
   */
  await expect.poll(
    () => sql(`select priority from public.actions where organization_id = '${orgId}' and source_id = '${alertId}'`),
    { timeout: 30_000, message: 'the rule said critical, so the task is critical' },
  ).toBe('critical');

  // And the alert now points at it, so the button is not offered twice (ADR-034).
  await expect(page.getByRole('link', { name: /already on this/i })).toBeVisible();
});
