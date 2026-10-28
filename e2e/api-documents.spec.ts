import { expect, test } from '@playwright/test';
import { seededOrgSlug } from './fixtures';
import { auditEvents, newestFirst, orgIdBySlug, orgRows } from './firestore';

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

    const orgId = await orgIdBySlug(slug);
    const documentId = newestFirst(await orgRows(orgId, 'source_documents', (d) => d.original_filename === 'gl-may.csv'))[0]?.id;
    const downloads = (await auditEvents(orgId)).filter((a) => a.action === 'document.downloaded' && a.target_id === documentId);
    expect(downloads.length).not.toBe(0);
  });

  test('an invented document is 404', async ({ page }) => {
    const response = await page.goto(`/app/${seededOrgSlug()}/data/documents/00000000-0000-4000-8000-000000000000`);
    expect(response?.status()).toBe(404);
  });
});
