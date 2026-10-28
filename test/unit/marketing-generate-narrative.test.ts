import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '@/core/errors';
import { NO_OPENAI_KEY, type ModelCall, type ModelResponse, type ModelTransport } from '@/modules/ai';
import { generateMarketingNarrative } from '@/modules/marketing';
import { BEARA_FINANCIALS, BEARA_PROFILE, validNarrative } from '../fixtures/marketing-narrative';

const { checkNarrative } = await import('@/modules/marketing/domain/narrative-schema');
const { MARKETING_PROMPT_VERSION, SUBMIT_MARKETING_TOOL } = await import('@/modules/marketing/domain/prompt');
const { MARKETING_MAX_TOKENS, OFFLINE_MODEL, costAction, offlineNarrative } = await import('@/modules/marketing/services/generate-narrative');

/**
 * ADR-170: one forced call, one repair with the problems, then a refusal — tokens summed across
 * attempts; a provider failure is an UpstreamError the page can show; offline, a deterministic
 * report from the industry template with no model at all. No network: fake transports only.
 */

const base = { organisationName: 'Beara Beara Ltd', profile: BEARA_PROFILE, currency: 'GBP', financials: BEARA_FINANCIALS };

const submit = (input: unknown, usage = { inputTokens: 5000, outputTokens: 4000 }, id = 'call_1'): ModelResponse => ({
  content: [{ type: 'tool_use', id, name: SUBMIT_MARKETING_TOOL, input } as unknown as ModelResponse['content'][number]],
  stopReason: 'tool_use', usage, model: 'gpt-test',
});

const text = (stopReason: string): ModelResponse => ({
  content: [{ type: 'text', text: 'Here is your report…', citations: null } as unknown as ModelResponse['content'][number]],
  stopReason, usage: { inputTokens: 5000, outputTokens: 100 }, model: 'gpt-test',
});

/** A transport that plays the given replies in order and records every call. */
function scripted(...replies: ModelResponse[]): ModelTransport & { calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const transport = (async (call: ModelCall) => {
    calls.push(call);
    const reply = replies[calls.length - 1];
    if (!reply) throw new Error('no more replies scripted');
    return reply;
  }) as ModelTransport & { calls: ModelCall[] };
  transport.calls = calls;
  return transport;
}

/** The narrative with its budget adding up to 110. */
function brokenNarrative() {
  const n = validNarrative();
  return { ...n, strategy: { ...n.strategy, budget: n.strategy.budget.map((b, i) => (i === 0 ? { ...b, percent: '50' } : b)) } };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('generateMarketingNarrative', () => {
  it('forces the one tool and returns a valid narrative with its usage', async () => {
    const transport = scripted(submit(validNarrative()));
    const result = await generateMarketingNarrative({ ...base, transport });
    expect(result).toEqual({
      ok: true, narrative: validNarrative(), model: 'gpt-test', promptVersion: MARKETING_PROMPT_VERSION, inputTokens: 5000, outputTokens: 4000,
    });
    const [call] = transport.calls;
    expect(call!.toolChoice).toEqual({ type: 'tool', name: SUBMIT_MARKETING_TOOL });
    expect(call!.tools.map((t) => t.name)).toEqual([SUBMIT_MARKETING_TOOL]);
    expect(call!.maxTokens).toBe(MARKETING_MAX_TOKENS);
    expect(call!.system).toEqual([{ text: expect.stringContaining('marketing campaign strategy report'), cached: true }]);
    expect(call!.messages).toHaveLength(1);
    expect(String(call!.messages[0]!.content)).toContain('<data name="organisation_name">Beara Beara Ltd</data>');
    expect(String(call!.messages[0]!.content)).toContain('turnover −21.3%');
  });

  it('passes the cancellation signal through', async () => {
    const controller = new AbortController();
    const transport = scripted(submit(validNarrative()));
    await generateMarketingNarrative({ ...base, transport, signal: controller.signal });
    expect(transport.calls[0]!.signal).toBe(controller.signal);
  });

  it('repairs once: sends the submission back with the problems, and sums the tokens of both attempts', async () => {
    const transport = scripted(
      submit(brokenNarrative(), { inputTokens: 5000, outputTokens: 4000 }, 'call_A'),
      submit(validNarrative(), { inputTokens: 9500, outputTokens: 4100 }, 'call_B'),
    );
    const result = await generateMarketingNarrative({ ...base, transport });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ inputTokens: 14500, outputTokens: 8100, model: 'gpt-test' });

    expect(transport.calls).toHaveLength(2);
    const second = transport.calls[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'call_A', name: SUBMIT_MARKETING_TOOL, input: brokenNarrative() }] });
    const reply = second.messages[2]!.content as Array<{ type: string; tool_use_id: string; is_error: boolean; content: string }>;
    expect(reply[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_A', is_error: true });
    expect(reply[0]!.content).toContain('<data name="problem">strategy.budget: the percentages add up to 110, not 100</data>');
    expect(second.toolChoice).toEqual({ type: 'tool', name: SUBMIT_MARKETING_TOOL });
    // The first call's messages were not mutated by the repair.
    expect(transport.calls[0]!.messages).toHaveLength(1);
  });

  it('refuses after one failed repair, with a readable reason and both attempts\' tokens', async () => {
    const transport = scripted(submit(brokenNarrative()), submit(brokenNarrative()));
    const result = await generateMarketingNarrative({ ...base, transport });
    expect(transport.calls).toHaveLength(2);
    expect(result).toMatchObject({ ok: false, inputTokens: 10000, outputTokens: 8000, model: 'gpt-test', promptVersion: MARKETING_PROMPT_VERSION });
    if (!result.ok) {
      expect(result.reason).toMatch(/^The report ChatGPT wrote did not pass APX's checks, even after one correction/);
      expect(result.reason).toContain('strategy.budget: the percentages add up to 110, not 100');
    }
  });

  it('keeps the first attempt\'s tokens when the provider fails on the repair', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const transport: ModelTransport = async () => {
      calls += 1;
      if (calls === 1) return submit(brokenNarrative());
      throw new Error('socket hang up');
    };
    const result = await generateMarketingNarrative({ ...base, transport });
    spy.mockRestore();
    expect(result).toMatchObject({ ok: false, inputTokens: 5000, outputTokens: 4000, model: 'gpt-test' });
    if (!result.ok) expect(result.reason).toMatch(/the correction could not be obtained: ChatGPT could not write the marketing report just now/);
  });

  it('refuses a reply with no submission, without a second call', async () => {
    const transport = scripted(text('end_turn'));
    const result = await generateMarketingNarrative({ ...base, transport });
    expect(transport.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, reason: 'ChatGPT did not return the report in the required form. Try again.', inputTokens: 5000, outputTokens: 100 });
  });

  it('refuses a submission cut off at the output limit, without a second call', async () => {
    const transport = scripted({ ...submit({}), stopReason: 'max_tokens' });
    const result = await generateMarketingNarrative({ ...base, transport });
    expect(transport.calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/output limit/);
  });

  it('throws an UpstreamError the page can show when the provider fails, keeping a presentable one as it is', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejected = generateMarketingNarrative({ ...base, transport: async () => { throw new Error('ECONNRESET 10.0.0.1:443'); } });
    await expect(rejected).rejects.toBeInstanceOf(UpstreamError);
    await expect(rejected).rejects.toThrow(/^ChatGPT could not write the marketing report just now/);
    const own = new UpstreamError('openai', NO_OPENAI_KEY);
    await expect(generateMarketingNarrative({ ...base, transport: async () => { throw own; } })).rejects.toBe(own);
    spy.mockRestore();
  });

  it('keeps OpenAI\'s own words out of the message, in `provider` for the log, with any key masked', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // callOpenAi's shape: the detail in `provider`, the generic message.
    const refusal = new UpstreamError('OpenAI refused the call: Incorrect API key provided: sk-proj-****abcd.');
    const caught = await generateMarketingNarrative({ ...base, transport: async () => { throw refusal; } }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).message).toMatch(/^ChatGPT could not write the marketing report just now/);
    expect((caught as UpstreamError).provider).toBe('OpenAI refused the call: Incorrect API key provided: [key]');
    spy.mockRestore();
  });

  it('throws the signal\'s own reason when the job\'s time runs out, so the job can say it took too long', async () => {
    const controller = new AbortController();
    const transport: ModelTransport = async () => {
      controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      throw new UpstreamError('OpenAI refused the call: The operation timed out.');
    };
    const caught = await generateMarketingNarrative({ ...base, transport, signal: controller.signal }).catch((e: unknown) => e);
    expect((caught as Error).name).toBe('TimeoutError');
  });

  it('uses the OpenAI report transport by default, which names the missing key', async () => {
    // With the switch off and no key anywhere (no stored key: the database is not configured here;
    // no server key), the default transport refuses before any network call.
    vi.stubEnv('MOTION_AI_OFFLINE', '0');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '');
    vi.stubEnv('FIREBASE_SERVICE_ACCOUNT', '');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(generateMarketingNarrative(base)).rejects.toThrow(NO_OPENAI_KEY);
    spy.mockRestore();
  });
});

describe('offline mode (MOTION_AI_OFFLINE=1)', () => {
  it('writes the report from the industry template, with no model and no cost', async () => {
    vi.stubEnv('MOTION_AI_OFFLINE', '1');
    const result = await generateMarketingNarrative({ ...base, financials: null });
    expect(result).toMatchObject({ ok: true, model: OFFLINE_MODEL, promptVersion: MARKETING_PROMPT_VERSION, inputTokens: 0, outputTokens: 0 });
    if (!result.ok) return;
    expect(result.narrative.financialCommentary).toBeNull();
    expect(result.narrative.objective).toContain('Beara Beara Ltd\'s position in luxury leather accessories');
    expect(result.narrative.competitors.competitorNote).toMatch(/^Offline template/);
    expect(result.narrative.overview).toContain('financial overview to follow once figures are available');
  });

  it('restates the figures, and only the figures, with one action per cost line', async () => {
    vi.stubEnv('MOTION_AI_OFFLINE', '1');
    const result = await generateMarketingNarrative(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const c = result.narrative.financialCommentary!;
    expect(c.performance).toContain('Turnover was £1,633,422 in 2024, £895,231 in 2025 and £704,530 in 2026.');
    expect(c.performance).toContain('Gross profit over sales was 42.6% in 2024, 53.6% in 2025 and 46.0% in 2026.');
    expect(c.performance).toContain('Turnover changed by −21.3% from 2025 to 2026.');
    expect(c.productSales).toBe('Handbags had the largest sales in 2026, at £437,128. The table shows each line\'s change on 2025.');
    expect(c.marketingEfficiency).toContain('Advertising and marketing spend was £19,296 in 2026 (2.7% of turnover).');
    expect(c.costActions).toEqual(['Audit fulfilment cost by order, destination and carrier', 'Review platform subscriptions and the return on development spend']);
  });

  it('is valid for every kind of company and every shape of figures', () => {
    const shapes = [
      null,
      BEARA_FINANCIALS,
      { ...BEARA_FINANCIALS, productSales: null, costLines: [] },
      { ...BEARA_FINANCIALS, years: [] },
      { ...BEARA_FINANCIALS, years: BEARA_FINANCIALS.years.map((y) => ({ ...y, marketingSpend: null, marketingPct: null })) },
    ];
    for (const industry of ['Retail', 'Restaurant', 'Accountancy', 'Construction', 'Software', 'Manufacturing', 'Dental clinic', 'Space tourism']) {
      for (const financials of shapes) {
        const narrative = offlineNarrative({ organisationName: 'A'.repeat(300), profile: { ...BEARA_PROFILE, industry, productsServices: 'x' }, currency: 'EUR', financials });
        const result = checkNarrative(narrative, { financials });
        expect(result.ok ? [] : result.problems, `${industry}`).toEqual([]);
      }
    }
  });

  it('formats the example budget in the organisation\'s currency', () => {
    const narrative = offlineNarrative({ ...base, currency: 'EUR', financials: null });
    expect(narrative.strategy.budgetNote).toMatch(/^Example: a €3,000 monthly test budget equates to €36,000 annualised\./);
  });

  it('still uses an injected transport: the switch is the default path\'s, not the tests\'', async () => {
    vi.stubEnv('MOTION_AI_OFFLINE', '1');
    const transport = scripted(submit(validNarrative()));
    const result = await generateMarketingNarrative({ ...base, transport });
    expect(transport.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, model: 'gpt-test' });
  });
});

describe('costAction', () => {
  it.each([
    ['Carriage and postage', 'Audit fulfilment'],
    ['Advertising', 'measured campaigns'],
    ['Wages and salaries', 'staffing'],
    ['Rent and rates', 'premises'],
    ['Merchant fees', 'payment and finance charges'],
    ['Accountancy fees', 'professional services'],
    ['Sundries', 'named owner'],
  ])('%s → …%s…', (name, fragment) => {
    expect(costAction(name)).toContain(fragment);
  });
});
