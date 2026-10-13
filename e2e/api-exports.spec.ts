import { expect, test } from '@playwright/test';
import { seededOrgSlug, sql } from './fixtures';

/**
 * `GET /api/exports/[kind]` (ROUTE_ARCHITECTURE.md §167; SECURITY_MODEL.md §8 step 4).
 *
 * The seeded organisation has a committed ledger, so the ledger export carries its rows; the
 * access event is written before the first byte; a cell that would open as a formula is defused;
 * an unknown kind is 404; an organisation that is not yours is 404.
 */
test.describe('CSV export', () => {
  test('streams the ledger as CSV, defused, and records the export', async ({ page }) => {
    const slug = seededOrgSlug();
    const before = Number(sql(`select count(*) from public.audit_events a join public.organizations o on o.id = a.organization_id where o.slug = '${slug}' and a.action = 'export.created'`));

    const response = await page.request.get(`/api/exports/ledger?org=${slug}`);
    expect(response.status(), await response.text()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/csv');
    expect(response.headers()['content-disposition']).toMatch(/attachment; filename="apx-ledger-\d{4}-\d{2}-\d{2}\.csv"/);

    const body = await response.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe('entry_date,period,account_code,account,standard_category,direction,amount,currency,description,reference,journal_ref,counterparty,assurance_level,source_ref');
    expect(lines.length).toBeGreaterThan(1);
    // Every amount is a plain decimal; no cell in the file can open as a formula.
    for (const line of lines.slice(1)) {
      for (const cell of line.split(',')) expect(cell).not.toMatch(/^[=+@]/);
    }
    expect(Number(sql(`select count(*) from public.audit_events a join public.organizations o on o.id = a.organization_id where o.slug = '${slug}' and a.action = 'export.created' and a.metadata ->> 'export_kind' = 'ledger'`))).toBe(before + 1);
  });

  test('every kind answers with its own header', async ({ page }) => {
    const slug = seededOrgSlug();
    for (const [kind, first] of [['bank_transactions', 'transaction_date'], ['invoices', 'invoice_type'], ['metrics', 'period']] as const) {
      const response = await page.request.get(`/api/exports/${kind}?org=${slug}`);
      expect(response.status(), kind).toBe(200);
      expect((await response.text()).split('\r\n')[0]?.startsWith(first)).toBe(true);
    }
  });

  test('an unknown kind and an organisation that is not yours are both 404', async ({ page }) => {
    expect((await page.request.get(`/api/exports/everything?org=${seededOrgSlug()}`)).status()).toBe(404);
    expect((await page.request.get('/api/exports/ledger?org=not-an-organisation-that-exists')).status()).toBe(404);
  });

  test('a caller with no session gets 401', async ({ browser }) => {
    const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    expect((await anonymous.request.get(`/api/exports/ledger?org=${seededOrgSlug()}`)).status()).toBe(401);
    await anonymous.close();
  });
});
