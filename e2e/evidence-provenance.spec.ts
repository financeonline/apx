import { expect, test } from '@playwright/test';
import { seededOrgSlug, sql } from './fixtures';

/**
 * The two ends of the chain, clicked rather than typed (EVIDENCE_MODEL.md §1; ADR-096).
 *
 * The drawer spec proves a figure walks down to its rows and a row to its file. This proves the two
 * questions asked from the other end are reachable by clicking: from a row in the drawer, "Where
 * from?" opens that record's own history; and a file says what rests on it.
 *
 * Runs against the organisation the setup project seeded, whose ledger came from a real import
 * through a real calculation run — so every link below is a real stored relation, not a fixture.
 */

test.describe('from one record back to where it came from', () => {
  test('a row in the drawer opens its own history, and the history reaches the file', async ({ page }) => {
    const slug = seededOrgSlug();

    await page.goto(`/app/${slug}/money/profit-and-loss`);
    await page.getByRole('link', { name: /why\?/i }).first().click();
    await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 30_000 });

    // The records level, and the per-row affordance this phase adds.
    const whereFrom = page.getByRole('link', { name: /where from\?/i });
    await expect(whereFrom.first(), 'every record row can be asked where it came from').toBeVisible();
    await whereFrom.first().click();

    await page.waitForURL(/\/evidence\/record\/(ledger|bank|invoice|balance)\/[0-9a-f-]{36}/, { timeout: 30_000 });

    // §7: the URL carries the product's word for the record, never a table name.
    expect(page.url(), 'no table name in a URL a reader may paste into a ticket')
      .not.toMatch(/ledger_entries|bank_transactions|period_balances/);

    await expect(page.getByRole('heading', { name: /is it counted\?/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /how it got here/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /source document/i })).toBeVisible();

    // A row that is in the figures says so, in words rather than a status code.
    await expect(page.getByText(/this record is part of the figures/i)).toBeVisible();

    // And it names the import it arrived with, which is the link back into the data trail.
    await expect(page.getByRole('link', { name: /see the import this came in with/i })).toBeVisible();
  });

  test('an invented record, and an invented kind, are both 404', async ({ page }) => {
    const slug = seededOrgSlug();
    const invented = '00000000-0000-4000-8000-000000000000';
    expect((await page.goto(`/app/${slug}/evidence/record/ledger/${invented}`))?.status()).toBe(404);
    // `ledger_entries` is a table name, not a kind: the page must not accept one.
    expect((await page.goto(`/app/${slug}/evidence/record/ledger_entries/${invented}`))?.status()).toBe(404);
    expect((await page.goto(`/app/${slug}/evidence/record/ledger/not-a-uuid`))?.status()).toBe(404);
  });

  test('another organisation’s record is 404, not a denial', async ({ page }) => {
    const slug = seededOrgSlug();
    // A real ledger id belonging to somebody else: the answer must not differ from an invented one.
    const foreign = sql(`
      select e.id from public.ledger_entries e
        join public.organizations o on o.id = e.organization_id
       where o.slug <> '${slug}' limit 1`);
    test.skip(foreign === '', 'needs a second organisation with a ledger');
    expect((await page.goto(`/app/${slug}/evidence/record/ledger/${foreign}`))?.status()).toBe(404);
  });
});

test.describe('from one file to what rests on it', () => {
  test('the document page says how many records rest on the file and which months', async ({ page }) => {
    const slug = seededOrgSlug();
    const documentId = sql(`
      select d.id from public.source_documents d
        join public.organizations o on o.id = d.organization_id
       where o.slug = '${slug}' and d.original_filename = 'gl-may.csv'
       order by d.created_at desc limit 1`);
    test.skip(documentId === '', 'needs the seeded ledger file');

    await page.goto(`/app/${slug}/data/documents/${documentId}`);
    await expect(page.getByRole('heading', { name: /what rests on this file/i })).toBeVisible();
    await expect(page.getByText(/records in your figures/i)).toBeVisible();
    await expect(page.getByText(/months it contributed to/i)).toBeVisible();

    // The months are links into the figures they are behind — the chain closed in both directions.
    await expect(page.getByRole('link', { name: /May 2026/i }).first()).toBeVisible();
  });
});
