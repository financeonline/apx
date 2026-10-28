import { expect, test } from '@playwright/test';
import { seededOrgSlug } from './fixtures';
import { newestFirst, orgIdBySlug, orgRows } from './firestore';

/**
 * `/analyst` and `/analyst/[conversationId]` (ROUTE_ARCHITECTURE.md §121–122; UX_ARCHITECTURE.md
 * §5 `AnalystChat`, §6, §7.2).
 *
 * The test server has no model key, so every turn ends `failed`: the page must then show the
 * fallback AND "Facts we can show you" from the organisation's own snapshots — the §7.2 promise that
 * the reader is never left with nothing. With a key the same test would see an answer; both are the
 * contract, and the assertions below hold for either.
 */

const INVENTED = '00000000-0000-4000-8000-000000000000';

/** The organisation's newest conversation, or '' when there is none yet. */
async function latestConversation(orgId: string): Promise<string> {
  return String(newestFirst(await orgRows(orgId, 'ai_conversations'))[0]?.id ?? '');
}

/** The newest feedback left on any message of one conversation. */
async function latestFeedback(orgId: string, conversationId: string): Promise<unknown> {
  const messages = new Set((await orgRows(orgId, 'ai_messages', (m) => m.conversation_id === conversationId)).map((m) => m.id));
  return newestFirst(await orgRows(orgId, 'ai_feedback', (f) => messages.has(f.message_id)))[0]?.feedback_type;
}

test.describe('the analyst page', () => {
  test('a question is asked, the turn is recorded, and the reader always gets figures', async ({ page }) => {
    const slug = seededOrgSlug();
    await page.goto(`/app/${slug}/analyst`);
    await expect(page.getByRole('heading', { name: /ask about the numbers/i })).toBeVisible();

    const box = page.getByLabel(/ask a question about the numbers/i);
    await box.fill('How was revenue in May 2026?');
    await page.getByRole('button', { name: /^ask$/i }).click();

    // The question is shown as asked, and the turn ends one way or the other.
    const conversation = page.getByRole('region', { name: /^conversation$/i });
    await expect(conversation.getByText('How was revenue in May 2026?')).toBeVisible();
    const outcome = page.getByText(/the analyst isn't available right now|the analyst's answer didn't pass apx's checks|see the evidence behind this answer/i).first();
    await expect(outcome).toBeVisible({ timeout: 60_000 });

    // Either way the page now addresses the recorded conversation, and the rail lists it.
    await expect(page).toHaveURL(/\/analyst\/[0-9a-f-]{36}$/);
    const conversationId = page.url().match(/\/analyst\/([0-9a-f-]{36})$/)![1]!;
    const orgId = await orgIdBySlug(slug);
    const assistant = await orgRows(orgId, 'ai_messages', (m) => m.conversation_id === conversationId && m.role === 'assistant');
    expect(assistant.length).toBe(1);

    if (await page.getByText(/the analyst isn't available right now|the analyst's answer didn't pass apx's checks/i).first().isVisible()) {
      // §7.2: the facts card, from current snapshots, deterministic.
      await expect(page.getByText(/facts we can show you/i)).toBeVisible();
      await expect(page.getByText('£40,000').first()).toBeVisible();
      // ADR-032.5: nothing to turn into an action from a failed answer.
      await expect(page.getByRole('button', { name: /create action/i })).toHaveCount(0);
    }

    // The conversation page renders the same record from the server.
    await page.goto(`/app/${slug}/analyst/${conversationId}`);
    await expect(page.getByRole('region', { name: /^conversation$/i }).getByText('How was revenue in May 2026?')).toBeVisible();
    await expect(page.getByRole('navigation', { name: /your conversations/i })).toBeVisible();
  });

  test('reporting an answer records feedback', async ({ page }) => {
    const slug = seededOrgSlug();
    const orgId = await orgIdBySlug(slug);
    const conversationId = await latestConversation(orgId);
    test.skip(conversationId === '', 'needs the conversation the previous test created');

    await page.goto(`/app/${slug}/analyst/${conversationId}`);
    await page.getByRole('button', { name: /report an incorrect figure/i }).first().click();
    await page.getByLabel(/what was wrong/i).selectOption('unhelpful');
    await page.getByLabel(/which figure/i).fill('It did not answer about May.');
    await page.getByRole('button', { name: /send report/i }).click();
    await expect(page.getByText(/someone will look at this answer/i)).toBeVisible();
    expect(await latestFeedback(orgId, conversationId)).toBe('unhelpful');
  });

  test('a reader can say an answer was helpful in one click', async ({ page }) => {
    const slug = seededOrgSlug();
    const orgId = await orgIdBySlug(slug);
    const conversationId = await latestConversation(orgId);
    test.skip(conversationId === '', 'needs the conversation the first test created');

    await page.goto(`/app/${slug}/analyst/${conversationId}`);
    await page.getByRole('button', { name: /^helpful$/i }).first().click();
    await expect(page.getByText(/noted/i)).toBeVisible();
    expect(await latestFeedback(orgId, conversationId)).toBe('helpful');
  });

  test('a conversation that does not exist is 404', async ({ page }) => {
    const response = await page.goto(`/app/${seededOrgSlug()}/analyst/${INVENTED}`);
    expect(response?.status()).toBe(404);
  });
});
