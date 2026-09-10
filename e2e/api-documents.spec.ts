import { expect, test } from '@playwright/test';
import { seededOrgSlug, sql } from './fixtures';

/** The document library (ROUTE_ARCHITECTURE.md §127–128; ADR-087). */
test.describe('documents', () => {
  test('lists the seeded file, opens it, and refuses to delete a file an import rests on', async ({ page }) => {
    const slug = seededOrgSlug();
    await page.goto(`/app/${slug}/data/documents`);
    await expect(page.getByRole('heading', { name: /^documents$/i })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'gl-may.csv' }).first();
    await expect(row).toBeVisible();
    // A committed import rests on it: no Delete control is offered (and the function would refuse).
    await expect(row.getByRole('button', { name: /^delete$/i })).toHaveCount(0);

    await row.getByRole('link', { name: 'gl-may.csv' }).click();
    await expect(page.getByRole('heading', { name: 'gl-may.csv' })).toBeVisible();
    await expect(page.getByText(/imports from this file/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /download gl-may\.csv/i })).toBeVisible({ timeout: 15_000 });

    const documentId = sql(`select d.id from public.source_documents d join public.organizations o on o.id = d.organization_id where o.slug = '${slug}' and d.original_filename = 'gl-may.csv' order by d.created_at desc limit 1`);
    expect(sql(`select count(*) from public.audit_events a join public.organizations o on o.id = a.organization_id where o.slug = '${slug}' and a.action = 'document.downloaded' and a.target_id = '${documentId}'`)).not.toBe('0');
  });

  test('an invented document is 404', async ({ page }) => {
    const response = await page.goto(`/app/${seededOrgSlug()}/data/documents/00000000-0000-4000-8000-000000000000`);
    expect(response?.status()).toBe(404);
  });
});
