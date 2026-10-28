import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { cleanUpOwn, onboard, seedUser, signIn, sql, uniqueName } from './fixtures';

/**
 * The what-if page (REQ-SC-01…10; ADR-100; remediated per `PHASE_12_REMEDIATION.md`).
 *
 * What a wrong build would hide, and this asserts by clicking:
 *   * an organisation with no forecast is told what it needs first, and is given no form to fail at;
 *   * a scenario MOTION cannot work out is refused in the error tone, with the change and the reason
 *     named, and nothing saved — both when nothing has been saved yet and, the case the audit found
 *     broken, when an earlier scenario is already on the page: that earlier scenario must stay
 *     labelled as the last SAVED one and never be presented as the answer to the refused request;
 *   * a scenario shows BASELINE beside SCENARIO with the assumptions printed, in the organisation's
 *     own currency, carrying the forecast's basis word and the notes its figures carried (§12).
 *
 * The organisation is Indian-rupee and its figures carry a data-quality warning, so the currency
 * and warning paths are proven on the page and not only in the service.
 */

const ORG = uniqueName('WhatIf Ltd');

test.afterAll(() => cleanUpOwn([ORG, `${ORG} Thin`], ['wi-owner', 'wi-thin']));

/**
 * Six steady months, written the way the engine writes them — in INR, every figure flagged as a
 * cash-basis estimate, and deliberately WITHOUT the `expense_by_category` breakdown, so a
 * percentage of wages has nothing to be a percentage of and is refused.
 */
function seedHistory(orgId: string): void {
  sql(`update public.organizations set base_currency = 'INR' where id = '${orgId}'`);
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
                  ${value}, 'money', 'INR', 'bank', 'estimated',
                  '{"completeness": 1, "proxy": true, "warnings": ["cash_basis_proxy"], "missing": []}'::jsonb)
          returning id) select * from q`);
      sql(`
        insert into public.metric_current
               (organization_id, period_id, metric_key, dimension_type, snapshot_id, calculation_run_id)
        values ('${orgId}', '${periodId}', '${key}', 'none', '${snapshotId}', '${runId}')`);
    }
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

test('a person asks what would happen, and is answered — or told exactly why not', async ({ page }) => {
  const owner = seedUser('wi-owner');
  await signIn(page, owner);
  const slug = await onboard(page, ORG);
  const orgId = sql(`select id from public.organizations where slug = '${slug}'`);
  seedHistory(orgId);
  const saved = () => sql(`select count(*) from public.scenario_runs where organization_id = '${orgId}'`);

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
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  const wages = () => page.locator('details', { hasText: /what if wages change/i });
  // Scoped to `main`: Next's route announcer is also `role="alert"`, and a bare lookup finds both.
  const refusal = () => page.locator('main').getByRole('alert');

  // ---------------------------------------------------------------------------------------------
  // 1. Refused for a missing figure, before anything has been saved (§7).
  // ---------------------------------------------------------------------------------------------
  await page.getByLabel(/what shall we call this/i).fill('Wages pct');
  await wages().locator('summary').click();
  await wages().getByRole('checkbox', { name: /include this change/i }).check();
  await page.locator('#payroll_change\\.value').fill('10');
  await page.getByRole('button', { name: /^work it out$/i }).click();

  // The error tone, the change that failed, the real reason, and the statement that nothing was
  // saved — and NOT the success message. The audit found the earlier build saying "the reasons are
  // below" in the success tone with no reasons anywhere (HIGH-1).
  await expect(refusal()).toBeVisible({ timeout: 30_000 });
  await expect(refusal()).toContainText(/nothing was saved/i);
  await expect(refusal()).toContainText(/wages/i);
  await expect(refusal()).toContainText(/does not know what this has been running at/i);
  await expect(page.getByText(/worked out and saved/i)).toHaveCount(0);
  await expect(page.getByText(/reasons are below/i)).toHaveCount(0);
  await expect(page.getByText(/last saved scenario/i), 'nothing to show as saved yet').toHaveCount(0);
  expect(saved(), 'nothing was saved').toBe('0');

  // ---------------------------------------------------------------------------------------------
  // 2. Refused for an answer MOTION cannot read: a price change with no volume answer (§4, §9).
  // ---------------------------------------------------------------------------------------------
  await page.reload();
  const pricing = page.locator('details', { hasText: /what if you change your prices/i });
  await page.getByLabel(/what shall we call this/i).fill('Impossible');
  await pricing.locator('summary').click();
  await pricing.getByRole('checkbox', { name: /include this change/i }).check();
  await page.locator('#pricing_change\\.pricePercent').fill('5');
  await page.locator('#pricing_change\\.volumePercent').fill('');
  await page.getByRole('button', { name: /^work it out$/i }).click();
  await expect(page.getByText(/need fixing|must be a number/i).first()).toBeVisible({ timeout: 30_000 });
  expect(saved()).toBe('0');

  // ---------------------------------------------------------------------------------------------
  // 3. The thing it will do.
  // ---------------------------------------------------------------------------------------------
  await page.reload();
  const sales = page.locator('details', { hasText: /what if sales change/i });
  await page.getByLabel(/what shall we call this/i).fill('Sales up 10%');
  await sales.locator('summary').click();
  await sales.getByRole('checkbox', { name: /include this change/i }).check();
  await page.locator('#revenue_change\\.value').fill('10');
  await page.getByRole('button', { name: /^work it out$/i }).click();
  await expect(page.getByText(/worked out and saved/i)).toBeVisible({ timeout: 30_000 });
  expect(saved()).toBe('1');

  // §14: BASELINE beside SCENARIO, both labelled, neither mistakable for the other; and the section
  // is labelled as the last SAVED scenario, with its date.
  await expect(page.getByText(/last saved scenario/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sales up 10%' })).toBeVisible();
  await expect(page.getByText('If this happens').first()).toBeVisible();
  await expect(page.getByText(/expected now/i).first()).toBeVisible();

  // §16: the disclaimer is on the page, and it separates a scenario from a forecast in words.
  await expect(page.getByText(/not results and not a forecast/i)).toBeVisible();
  await expect(page.getByText(/\d+% confidence/i), 'no invented confidence score').toHaveCount(0);

  // The organisation's currency, on the figures AND on the assumptions (MEDIUM-3).
  await expect(page.getByText('₹11,000').first()).toBeVisible();
  await expect(page.getByText('₹4,000').first()).toBeVisible();
  await expect(page.getByText(/£/), 'no pound sign anywhere for a rupee organisation').toHaveCount(0);

  // §12: how much to lean on it, in the forecast's words, and the note its figures carried
  // (MEDIUM-2) — no percentage anywhere. Six months would be a STRONG basis, but every figure here
  // is an `estimated` cash-basis proxy, and Phase 11's rule pulls the basis down to LIMITED for
  // that (ADR-099) — which is precisely the disclosure this section exists to carry.
  const basis = page.getByTestId('scenario-basis');
  await expect(basis).toContainText(/limited basis/i);
  await expect(basis).toContainText(/some of the figures behind them are estimates/i);
  await expect(basis).toContainText(/estimated from bank activity/i);

  // §3: the assumptions are printed in words, not hidden behind the figures.
  await expect(page.getByText(/sales up by 10%/i)).toBeVisible();
  await expect(page.getByText(/direct costs unchanged/i)).toBeVisible();

  // The six figures §5 names.
  for (const label of ['Sales', 'Running costs', 'Profit', 'Cash', 'Owed to you', 'You owe']) {
    await expect(page.getByText(label, { exact: true }).first(), label).toBeVisible();
  }

  // §14: progressive disclosure, and the evidence behind it (§16).
  await page.getByText(/how was this worked out\?/i).click();
  await expect(page.getByRole('link', { name: /see the figures this rests on/i })).toBeVisible();

  // §17: an integration point with the Action Centre, and nothing created on the user's behalf.
  await expect(page.getByRole('link', { name: /record it in your actions/i })).toBeVisible();

  // ---------------------------------------------------------------------------------------------
  // 4. Refused AGAIN, now that a scenario is saved — the exact state the audit found misleading.
  // ---------------------------------------------------------------------------------------------
  await page.getByLabel(/what shall we call this/i).fill('Wages pct');
  await wages().locator('summary').click();
  await wages().getByRole('checkbox', { name: /include this change/i }).check();
  await page.locator('#payroll_change\\.value').fill('10');
  await page.getByRole('button', { name: /^work it out$/i }).click();

  await expect(refusal()).toBeVisible({ timeout: 30_000 });
  await expect(refusal()).toContainText(/nothing was saved/i);
  await expect(refusal()).toContainText(/does not know what this has been running at/i);
  // This is the assertion that fails on the audited build: the success text must not appear, the
  // saved section must still be the EARLIER scenario and say so, and "Wages pct" must appear
  // nowhere as a heading.
  await expect(page.getByText(/worked out and saved/i)).toHaveCount(0);
  await expect(page.getByText(/last saved scenario/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sales up 10%' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wages pct' })).toHaveCount(0);
  expect(saved(), 'still exactly the one that succeeded').toBe('1');

  // ---------------------------------------------------------------------------------------------
  // 5. "Can we afford it?" (SOW §12; ADR-146). Cash opens on ₹20,000 and rises by ₹2,000 a month;
  //    one month of money out is ₹7,000. A one-off ₹15,000 leaves exactly ₹7,000 at the lowest.
  //    Worked out when asked, and nothing is saved.
  // ---------------------------------------------------------------------------------------------
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('15,000');
  await page.getByRole('button', { name: 'Check' }).click();
  const result = page.getByRole('region', { name: 'Affordability result' });
  await expect(result.getByText('Affordable', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(result).toContainText('Lowest cash after it: ₹7,000.00');
  await expect(result).toContainText('One month of normal money out: ₹7,000.00');
  await expect(result.getByRole('row')).toHaveCount(4);

  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('16,000');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('region', { name: 'Affordability result' }).getByText('Tight', { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('1,50');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText(/enter an amount more than zero/i)).toBeVisible({ timeout: 30_000 });
  expect(saved(), 'a check saves nothing').toBe('1');

  // §15: no database terminology reaches the reader.
  const body = (await page.locator('main').innerText()).toLowerCase();
  for (const term of ['scenario_values', 'forecast_values', 'metric_snapshots', 'operating_expenses', 'cost_of_sales', 'cash_basis_proxy', 'select ']) {
    expect(body, term).not.toContain(term);
  }
});
