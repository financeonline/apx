import { expect, test } from '@playwright/test';
import { cleanUpOwn, onboard, seedUser, signIn, sql, uniqueName } from './fixtures';

/**
 * The forecast page (REQ-FC-01/02/05; ADR-099).
 *
 * Two things a wrong build would hide, and this asserts both by clicking:
 *   * an organisation with too little history is told so, and is given no number at all;
 *   * once there is history, every figure says "Forecast", the actual it is compared with is
 *     labelled, and the disclaimer is on the page rather than behind a tooltip (§14, §15).
 */

const ORG = uniqueName('Forecast Ltd');

test.afterAll(() => cleanUpOwn([ORG, `${ORG} Thin`], ['fc-owner', 'fc-thin']));

/** Six steady months, written the way the engine writes them. */
function seedHistory(orgId: string): void {
  const runId = sql(`
    with q as (
      insert into public.calculation_runs
             (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
      select '${orgId}', 'recalc_manual', '1.0.0', p.id, p.id, '2026-08-31', 'succeeded'
        from public.fiscal_periods p
       where p.organization_id = '${orgId}' and p.period_start = '2026-08-01'
      returning id) select * from q`);

  const monthly: Record<string, string> = {
    revenue: '10000', cost_of_sales: '4000', operating_expenses: '3000',
    cash_inflows: '9000', cash_outflows: '7000',
    receivables: '5000', payables: '2000', closing_cash: '20000',
  };

  for (let i = 0; i < 6; i += 1) {
    const start = `2026-${String(8 - i).padStart(2, '0')}-01`;
    const periodId = sql(`
      select id from public.fiscal_periods
       where organization_id = '${orgId}' and period_start = '${start}'`);
    sql(`update public.fiscal_periods set is_complete = true where id = '${periodId}'`);
    for (const [key, value] of Object.entries(monthly)) {
      const snapshotId = sql(`
        with q as (
          insert into public.metric_snapshots
                 (organization_id, calculation_run_id, period_id, metric_key, dimension_type,
                  value, unit, currency, basis, assurance_level, data_quality)
          values ('${orgId}', '${runId}', '${periodId}', '${key}', 'none',
                  ${value}, 'money', 'GBP', 'ledger', 'verified', '{"completeness": 1, "proxy": false, "warnings": [], "missing": []}'::jsonb)
          returning id) select * from q`);
      sql(`
        insert into public.metric_current
               (organization_id, period_id, metric_key, dimension_type, snapshot_id, calculation_run_id)
        values ('${orgId}', '${periodId}', '${key}', 'none', '${snapshotId}', '${runId}')`);
    }
  }
}

test('an organisation with too little history is told so, and given no number', async ({ page }) => {
  const owner = seedUser('fc-thin');
  await signIn(page, owner);
  const slug = await onboard(page, `${ORG} Thin`);

  await page.goto(`/app/${slug}/forecast`);
  await expect(page.getByRole('heading', { name: /what is expected/i })).toBeVisible();
  await expect(page.getByText(/no forecast has been worked out yet/i)).toBeVisible();

  await page.getByRole('button', { name: /try to work one out/i }).click();

  // The attempt says what happened. A tick beside an unchanged empty page would leave the reader
  // unable to tell "not asked yet" from "asked, and there is not enough".
  await expect(page.getByText(/not enough finished history/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText(/at least three finished months/i).first(),
    'and it says what would make a forecast possible',
  ).toBeVisible();
  await expect(page.getByText(/£/), 'and no figure is offered').toHaveCount(0);
});

test('a forecast is shown as an expectation, never as a result', async ({ page }) => {
  const owner = seedUser('fc-owner');
  await signIn(page, owner);
  const slug = await onboard(page, ORG);
  const orgId = sql(`select id from public.organizations where slug = '${slug}'`);
  seedHistory(orgId);

  // Reached from Money, because the primary navigation is fixed at seven items (§3.1, ADR-037).
  await page.goto(`/app/${slug}/money`);
  await page.getByRole('link', { name: /what is expected/i }).click();
  await page.waitForURL(/\/forecast$/);

  await page.getByRole('button', { name: /try to work one out|work it out again/i }).click();
  await expect(page.getByText(/based on the last 6 finished months/i).first()).toBeVisible({ timeout: 30_000 });

  // §14: every figure is labelled, and the actual beside it is labelled differently.
  await expect(page.getByText('Forecast').first()).toBeVisible();
  await expect(page.getByText(/actual aug 2026/i).first()).toBeVisible();

  // §15/§19: words for how much to lean on it, and no invented percentage anywhere.
  await expect(page.getByText(/strong basis/i).first()).toBeVisible();
  await expect(page.getByText(/\d+% confidence/i), 'no fake confidence score').toHaveCount(0);

  // REQ-FC-05: the disclaimer is on the page.
  await expect(page.getByText(/not a guarantee of what will happen/i).first()).toBeVisible();

  // The six headline figures §15 names.
  for (const label of ['Sales', 'Running costs', 'Profit', 'Cash', 'Owed to you', 'You owe']) {
    await expect(page.getByText(label, { exact: true }).first(), label).toBeVisible();
  }

  // The identities hold on the screen: 10,000 revenue − 4,000 costs − 3,000 running = 3,000.
  await expect(page.getByText('£3,000').first()).toBeVisible();

  // Progressive disclosure, and the evidence link behind it (§13, §15).
  await page.getByText(/how was this worked out\?/i).click();
  await expect(page.getByRole('link', { name: /see the figures this rests on/i })).toBeVisible();

  // No database terminology reaches the reader (§15).
  const body = (await page.locator('main').innerText()).toLowerCase();
  for (const term of ['metric_snapshots', 'forecast_values', 'operating_expenses', 'closing_cash', 'select ']) {
    expect(body, term).not.toContain(term);
  }
});
