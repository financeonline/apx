import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { cleanUpOwn, onboard, seedUser, signIn, sql, uniqueName } from './fixtures';

/**
 * The what-if page (REQ-SC-01…10; ADR-100).
 *
 * Three things a wrong build would hide, and this asserts all three by clicking:
 *   * an organisation with no forecast is told what it needs first, and is given no form to fail at;
 *   * MOTION refuses what it cannot work out, names the field that stopped it, and saves nothing —
 *     it never quietly answers a different question by reading a blank box as zero (§4, §9);
 *   * a scenario shows BASELINE beside SCENARIO, with the assumptions printed on the page and the
 *     figures never presented as results (§14, §16).
 */

const ORG = uniqueName('WhatIf Ltd');

test.afterAll(() => cleanUpOwn([ORG, `${ORG} Thin`], ['wi-owner', 'wi-thin']));

/** Six steady months, written the way the engine writes them, plus the category breakdown. */
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

    const write = (key: string, value: string, dimensionKey: string | null) => {
      const dimensionType = dimensionKey === null ? 'none' : 'standard_category';
      const dim = dimensionKey === null ? 'null' : `'${dimensionKey}'`;
      const snapshotId = sql(`
        with q as (
          insert into public.metric_snapshots
                 (organization_id, calculation_run_id, period_id, metric_key, dimension_type,
                  dimension_key, value, unit, currency, basis, assurance_level, data_quality)
          values ('${orgId}', '${runId}', '${periodId}', '${key}', '${dimensionType}',
                  ${dim}, ${value}, 'money', 'GBP', 'ledger', 'verified',
                  '{"completeness": 1, "proxy": false, "warnings": [], "missing": []}'::jsonb)
          returning id) select * from q`);
      sql(`
        insert into public.metric_current
               (organization_id, period_id, metric_key, dimension_type, dimension_key,
                snapshot_id, calculation_run_id)
        values ('${orgId}', '${periodId}', '${key}', '${dimensionType}', ${dim},
                '${snapshotId}', '${runId}')`);
    };

    for (const [key, value] of Object.entries(monthly)) write(key, value, null);
    // The engine's own breakdown of running costs, which a percentage assumption reads (§3).
    write('expense_by_category', '2000', 'payroll');
    write('expense_by_category', '500', 'marketing');
  }
}

test('an organisation with no forecast is told what it needs first', async ({ page }) => {
  const owner = seedUser('wi-thin');
  await signIn(page, owner);
  const slug = await onboard(page, `${ORG} Thin`);

  await page.goto(`/app/${slug}/what-if`);
  await expect(page.getByRole('heading', { name: /what if things change/i })).toBeVisible();
  await expect(page.getByText(/nothing to compare against yet/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /go to the forecast/i })).toBeVisible();
  // No form is offered, because every answer given to it would fail at the end.
  await expect(page.getByRole('button', { name: /^work it out$/i })).toHaveCount(0);
});

test('a person asks what would happen, and is answered — or told why not', async ({ page }) => {
  const owner = seedUser('wi-owner');
  await signIn(page, owner);
  const slug = await onboard(page, ORG);
  const orgId = sql(`select id from public.organizations where slug = '${slug}'`);
  seedHistory(orgId);

  // The forecast a what-if changes has to exist first.
  await page.goto(`/app/${slug}/forecast`);
  await page.getByRole('button', { name: /try to work one out|work it out again/i }).click();
  await expect(page.getByText(/based on the last 6 finished months/i).first())
    .toBeVisible({ timeout: 30_000 });

  // Reached from the forecast, because the primary navigation is fixed at seven items (§3.1).
  await page.getByRole('link', { name: /try a what-if/i }).click();
  await page.waitForURL(/\/what-if$/);
  await expect(page.getByRole('heading', { name: /what if things change/i })).toBeVisible();

  /*
   * The form is eight collapsible questions with their own inputs and selects — the densest set
   * of controls in the product, and the one place a missing label would hide. The accessibility
   * sweep cannot reach it, because the organisation it runs over has no forecast.
   */
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // ---------------------------------------------------------------------------------------------
  // First, the thing MOTION will not do: a price change with no answer about the number of sales.
  // ---------------------------------------------------------------------------------------------
  const pricing = page.locator('details', { hasText: /what if you change your prices/i });
  await page.getByLabel(/what shall we call this/i).fill('Impossible');
  await pricing.locator('summary').click();
  await pricing.getByRole('checkbox', { name: /include this change/i }).check();
  await page.locator('#pricing_change\\.pricePercent').fill('5');
  await page.locator('#pricing_change\\.volumePercent').fill('');
  await page.getByRole('button', { name: /^work it out$/i }).click();

  // A named objection, not a generic failure — and above all not a silent zero (§4, §9).
  await expect(page.getByText(/need fixing|must be a number/i).first())
    .toBeVisible({ timeout: 30_000 });
  expect(
    sql(`select count(*) from public.scenario_runs where organization_id = '${orgId}'`),
    'nothing was saved under a name whose answer MOTION refused',
  ).toBe('0');

  // ---------------------------------------------------------------------------------------------
  // Then the thing it will do.
  // ---------------------------------------------------------------------------------------------
  await page.reload();
  const sales = page.locator('details', { hasText: /what if sales change/i });
  await page.getByLabel(/what shall we call this/i).fill('Sales up 10%');
  await sales.locator('summary').click();
  await sales.getByRole('checkbox', { name: /include this change/i }).check();
  await page.locator('#revenue_change\\.value').fill('10');
  await page.getByRole('button', { name: /^work it out$/i }).click();
  await expect(page.getByText(/worked out and saved/i)).toBeVisible({ timeout: 30_000 });

  // §14: BASELINE beside SCENARIO, both labelled, neither mistakable for the other.
  await expect(page.getByText('If this happens').first()).toBeVisible();
  await expect(page.getByText(/expected now/i).first()).toBeVisible();

  // §16: the disclaimer is on the page, and it separates a scenario from a forecast in words.
  await expect(page.getByText(/not results and not a forecast/i)).toBeVisible();
  await expect(page.getByText(/\d+% confidence/i), 'no invented confidence score').toHaveCount(0);

  // The figures: 11,000 sales and 4,000 operating profit (11,000 − 4,000 − 3,000).
  await expect(page.getByText('£11,000').first()).toBeVisible();
  await expect(page.getByText('£4,000').first()).toBeVisible();

  // §3: the assumptions are printed in words, not hidden behind the figures.
  await expect(page.getByText(/sales up by 10%/i)).toBeVisible();
  await expect(page.getByText(/direct costs unchanged/i)).toBeVisible();

  // The six figures §5 names.
  for (const label of ['Revenue', 'Running costs', 'Operating profit', 'Cash at the end', 'Owed to you', 'Owed by you']) {
    await expect(page.getByText(label, { exact: true }).first(), label).toBeVisible();
  }

  // §14: progressive disclosure, and the evidence behind it (§16).
  await page.getByText(/how was this worked out\?/i).click();
  await expect(page.getByRole('link', { name: /see the figures this rests on/i })).toBeVisible();

  // §17: an integration point with the Action Centre, and nothing created on the user's behalf.
  await expect(page.getByRole('link', { name: /record it in your actions/i })).toBeVisible();

  // §15: no database terminology reaches the reader.
  const body = (await page.locator('main').innerText()).toLowerCase();
  for (const term of ['scenario_values', 'forecast_values', 'metric_snapshots', 'operating_expenses', 'cost_of_sales', 'select ']) {
    expect(body, term).not.toContain(term);
  }
});
