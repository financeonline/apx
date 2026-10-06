import { expect, test } from '@playwright/test';
import { cleanUpOwn, onboard, seedUser, signIn, sql, uniqueName } from './fixtures';

/**
 * Journey 20 — Team/Client Management, in the product (ADR-144).
 *
 * A client asks the team for something; the owner is told in their inbox, opens it, and moves it
 * along with a note; the client is told, and sees the history. No email anywhere.
 */

const ORG = uniqueName('Engagement Journey');
const OWNER = 'journey20-owner';
const CLIENT = 'journey20-client';

test.afterAll(() => cleanUpOwn([ORG], [OWNER, CLIENT]));

test('a client\'s request reaches the team, and the team\'s answer reaches the client', async ({ browser }) => {
  test.setTimeout(180_000);
  const ownerPage = await (await browser.newContext()).newPage();
  const owner = seedUser(OWNER);
  await signIn(ownerPage, owner);
  const slug = await onboard(ownerPage, ORG);

  const client = seedUser(CLIENT);
  sql(`insert into public.organization_memberships (organization_id, user_id, role, status)
       select id, '${client.userId}', 'client', 'active' from public.organizations where slug = '${slug}'`);
  const clientPage = await (await browser.newContext()).newPage();
  await signIn(clientPage, client);

  // The client raises a request.
  await clientPage.goto(`/app/${slug}/engagement`);
  await expect(clientPage.getByRole('heading', { name: 'Ask the team for something' })).toBeVisible();
  await clientPage.getByLabel('Title').fill('Explain the drop in September sales');
  await clientPage.getByLabel('Details (optional)').fill('Is it seasonal?');
  await clientPage.getByRole('button', { name: 'Send the request' }).click();
  await expect(clientPage.getByText('Request sent to the team.')).toBeVisible();

  // The owner is told, in the product.
  await ownerPage.goto(`/app/${slug}/home`);
  await expect(ownerPage.getByRole('link', { name: /notifications.*1 unread/i })).toBeVisible();
  await ownerPage.goto(`/app/${slug}/notifications`);
  await ownerPage.getByRole('link', { name: 'New request: Explain the drop in September sales' }).click();
  await expect(ownerPage.getByRole('heading', { name: 'Explain the drop in September sales' })).toBeVisible();
  await ownerPage.getByLabel('Move it to').selectOption('in_progress');
  await ownerPage.getByLabel('Note (optional)').fill('Pulling the invoice list now');
  await ownerPage.getByRole('button', { name: 'Update' }).click();
  await expect(ownerPage.getByText('Status updated.')).toBeVisible();

  // The client is told, and sees the history.
  await clientPage.goto(`/app/${slug}/notifications`);
  await clientPage.getByRole('link', { name: '"Explain the drop in September sales" is now in progress' }).click();
  await expect(clientPage.getByText(/moved it from Open to In progress/)).toBeVisible();
  await expect(clientPage.getByText('Pulling the invoice list now')).toBeVisible();
  // A client may withdraw their request, but not move it along.
  await expect(clientPage.getByRole('heading', { name: 'Withdraw your request' })).toBeVisible();
  await expect(clientPage.getByLabel('Move it to').locator('option')).toHaveText(['Closed']);
});
