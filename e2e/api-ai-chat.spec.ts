import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { seededOrgSlug, sql } from './fixtures';

/**
 * `POST /api/ai/chat` (AI_ARCHITECTURE.md §2 step 13; ROUTE_ARCHITECTURE.md §165, §237).
 *
 * The model is not under test here — the browser never sees it. What the browser sees is a status
 * code decided before the first byte and, on 200, a Server-Sent-Events stream that carries status
 * events and exactly ONE `answer` event. With no model key on the test server the turn ends as
 * `failed` with the fixed fallback; with one it ends however the model did. Either way the shape
 * is the same, and that shape is the contract.
 */

const INVENTED_ORG = 'not-an-organisation-that-exists';

/** Parses an SSE body into its events. */
function eventsOf(body: string): Array<{ event: string; data: unknown }> {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(chunk)?.[1] ?? 'null';
      return { event, data: JSON.parse(data) as unknown };
    });
}

const ask = (page: Page, body: unknown, org = seededOrgSlug()): Promise<APIResponse> =>
  page.request.post(`/api/ai/chat?org=${org}`, { data: body });

test.describe('POST /api/ai/chat', () => {
  test('a caller with no session gets 401, not a redirect and not a stream', async ({ browser }) => {
    const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const response = await anonymous.request.post(`/api/ai/chat?org=${seededOrgSlug()}`, { data: { message: 'How was revenue?' } });
    expect(response.status()).toBe(401);
    expect(response.headers()['content-type']).toContain('application/json');
    await anonymous.close();
  });

  test('an organisation that is not yours answers 404 before any turn is charged', async ({ page }) => {
    const response = await ask(page, { message: 'How was revenue?' }, INVENTED_ORG);
    expect(response.status()).toBe(404);
  });

  test('an empty or oversized question is refused as 422 with the field named', async ({ page }) => {
    const empty = await ask(page, { message: '   ' });
    expect(empty.status()).toBe(422);
    const body = (await empty.json()) as { error: { code: string; issues: Array<{ path: string }> } };
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.issues.map((i) => i.path)).toContain('message');

    const long = await ask(page, { message: 'x'.repeat(2_001) });
    expect(long.status()).toBe(422);
  });

  test('a conversation that is not yours is 404, even inside your own organisation', async ({ page }) => {
    const response = await ask(page, { message: 'How was revenue?', conversationId: '00000000-0000-4000-8000-000000000000' });
    expect(response.status()).toBe(404);
  });

  test('a question streams status events and exactly one answer event', async ({ page }) => {
    const response = await ask(page, { message: 'How was revenue in May 2026?' });
    expect(response.status(), await response.text()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/event-stream');
    expect(response.headers()['cache-control']).toContain('no-store');

    const events = eventsOf(await response.text());
    const answers = events.filter((e) => e.event === 'answer');
    expect(answers, 'one answer event, whatever the model did').toHaveLength(1);
    expect(events.filter((e) => e.event === 'error')).toHaveLength(0);
    for (const status of events.filter((e) => e.event === 'status')) {
      // A status event names a tool and a label — never a payload (§2 step 13).
      expect(Object.keys(status.data as object).sort()).toEqual(['label', 'tool']);
    }

    const answer = answers[0]!.data as {
      conversationId: string; messageId: string; groundingStatus: string; answer: unknown; fallback: string; toolCalls: number;
    };
    expect(answer.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(answer.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(['passed', 'degraded', 'failed']).toContain(answer.groundingStatus);
    expect(answer.fallback).toMatch(/unavailable/i);
    if (answer.groundingStatus === 'failed') expect(answer.answer).toBeNull();
    else expect(answer.answer).not.toBeNull();

    // The turn is the server's record, not the browser's: the assistant row exists with that verdict.
    expect(sql(`select grounding_status from public.ai_messages where id = '${answer.messageId}'`)).toBe(answer.groundingStatus);
    // And a second question in the same conversation is accepted as the caller's own.
    const again = await ask(page, { message: 'And costs?', conversationId: answer.conversationId });
    expect(again.status()).toBe(200);
  });
});

/**
 * The cron routes are called by a scheduler with no session. The middleware used to send every
 * such call to the sign-in page, so the queue would never have drained in production; this pins
 * the shape the scheduler actually sees (ADR-078).
 */
test.describe('the cron routes answer a caller with no session', () => {
  test('a wrong or missing secret is 404, not a redirect; the right one runs the drain', async ({ browser }) => {
    const scheduler = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const denied = await scheduler.request.get('/api/jobs/run', { maxRedirects: 0 });
    expect(denied.status()).toBe(404);

    const secret = process.env.CRON_SECRET;
    expect(secret, 'CRON_SECRET must be set for this to prove anything').toBeTruthy();
    const ran = await scheduler.request.get('/api/jobs/run', { headers: { authorization: `Bearer ${secret}` }, maxRedirects: 0 });
    expect(ran.status()).toBe(200);
    expect(Object.keys((await ran.json()) as object).length).toBeGreaterThan(0);
    await scheduler.close();
  });
});

