import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '@/core/errors';
import { NO_OPENAI_KEY, NO_OPENAI_MODEL, type ModelCall, type ModelResponse, type ModelTransport } from '@/modules/ai';
import type { InvestmentFigures } from '@/modules/investment';
import { CLIENT_FIGURES, figuresIn } from '../fixtures/investment-figures';
import { CLIENT_PROFILE, validInvestmentNarrative } from '../fixtures/investment-narrative';

const { checkInvestmentNarrative } = await import('@/modules/investment/domain/narrative-schema');
const { INVESTMENT_PLAYBOOKS, playbookFor } = await import('@/modules/investment/domain/playbooks');
const { INVESTMENT_PROMPT_VERSION, SUBMIT_INVESTMENT_TOOL } = await import('@/modules/investment/domain/prompt');
const {
  INVESTMENT_MAX_TOKENS, INVESTMENT_NO_OPENAI_KEY, INVESTMENT_NO_OPENAI_MODEL, INVESTMENT_OFFLINE_MODEL, generateInvestmentNarrative,
  offlineInvestmentNarrative, submitInvestmentTool,
} = await import('@/modules/investment/services/generate-narrative');

/**
 * ADR-171, Marketing's writer exactly (ADR-170): one forced call, one repair with the problems, then
 * a refusal — tokens summed across attempts; a provider failure is an UpstreamError the page can
 * show; offline, a deterministic pack from the country playbook and APX's figures with no model at
 * all. No network: fake transports only.
 */

const base = { organisationName: 'Acme Goods Ltd', profile: CLIENT_PROFILE, countryCode: 'GB', figures: CLIENT_FIGURES };

const submit = (input: unknown, usage = { inputTokens: 4000, outputTokens: 3000 }, id = 'call_1'): ModelResponse => ({
  content: [{ type: 'tool_use', id, name: SUBMIT_INVESTMENT_TOOL, input } as unknown as ModelResponse['content'][number]],
  stopReason: 'tool_use', usage, model: 'gpt-test',
});

const text = (stopReason: string): ModelResponse => ({
  content: [{ type: 'text', text: 'Here is your pack…', citations: null } as unknown as ModelResponse['content'][number]],
  stopReason, usage: { inputTokens: 4000, outputTokens: 100 }, model: 'gpt-test',
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

/** The narrative with its options out of risk order and too much high risk in the portfolio. */
function brokenNarrative() {
  const n = validInvestmentNarrative();
  return {
    ...n,
    options: [n.options[1]!, n.options[0]!, ...n.options.slice(2)],
    portfolio: n.portfolio.map((p, i) => (i === 0 ? { ...p, percent: '40' } : i === 4 ? { ...p, percent: '10' } : p)),
  };
}

/** The narrative with a number of its own in the comparison. */
function inventedFigure() {
  return { ...validInvestmentNarrative(), comparison: `${validInvestmentNarrative().comparison} A further £50,000 could follow.` };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('generateInvestmentNarrative', () => {
  it('forces the one tool and returns a valid narrative with its usage', async () => {
    const transport = scripted(submit(validInvestmentNarrative()));
    const result = await generateInvestmentNarrative({ ...base, transport });
    expect(result).toEqual({
      ok: true, narrative: validInvestmentNarrative(), model: 'gpt-test', promptVersion: INVESTMENT_PROMPT_VERSION, inputTokens: 4000, outputTokens: 3000,
    });
    const [call] = transport.calls;
    expect(call!.toolChoice).toEqual({ type: 'tool', name: SUBMIT_INVESTMENT_TOOL });
    expect(call!.tools.map((t) => t.name)).toEqual([SUBMIT_INVESTMENT_TOOL]);
    expect(call!.tools[0]).toEqual(submitInvestmentTool());
    expect(call!.maxTokens).toBe(INVESTMENT_MAX_TOKENS);
    expect(call!.system).toEqual([{ text: expect.stringContaining('Investment Strategy & Financial Growth Plan'), cached: true }]);
    expect(call!.messages).toHaveLength(1);
    const user = String(call!.messages[0]!.content);
    expect(user).toContain('<data name="organisation_name">Acme Goods Ltd</data>');
    expect(user).toContain('<playbook country="the United Kingdom">');
    expect(user).toContain('£77,233 of additional sales');
  });

  it('passes the cancellation signal through', async () => {
    const controller = new AbortController();
    const transport = scripted(submit(validInvestmentNarrative()));
    await generateInvestmentNarrative({ ...base, transport, signal: controller.signal });
    expect(transport.calls[0]!.signal).toBe(controller.signal);
  });

  it('repairs once: sends the submission back with the problems, and sums the tokens of both attempts', async () => {
    const transport = scripted(
      submit(brokenNarrative(), { inputTokens: 4000, outputTokens: 3000 }, 'call_A'),
      submit(validInvestmentNarrative(), { inputTokens: 7500, outputTokens: 3100 }, 'call_B'),
    );
    const result = await generateInvestmentNarrative({ ...base, transport });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ inputTokens: 11500, outputTokens: 6100, model: 'gpt-test' });

    expect(transport.calls).toHaveLength(2);
    const second = transport.calls[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'call_A', name: SUBMIT_INVESTMENT_TOOL, input: brokenNarrative() }] });
    const reply = second.messages[2]!.content as Array<{ type: string; tool_use_id: string; is_error: boolean; content: string }>;
    expect(reply[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_A', is_error: true });
    expect(reply[0]!.content).toContain('order the options from lower to higher risk');
    expect(reply[0]!.content).toContain('<data name="problem">portfolio: high and very_high risk together come to 15%; they may be at most 10% of the external allocation</data>');
    expect(second.toolChoice).toEqual({ type: 'tool', name: SUBMIT_INVESTMENT_TOOL });
    // The first call's messages were not mutated by the repair.
    expect(transport.calls[0]!.messages).toHaveLength(1);
  });

  it('repairs a number that is not APX\'s', async () => {
    const transport = scripted(submit(inventedFigure()), submit(validInvestmentNarrative()));
    const result = await generateInvestmentNarrative({ ...base, transport });
    expect(result.ok).toBe(true);
    const reply = transport.calls[1]!.messages[2]!.content as Array<{ content: string }>;
    expect(reply[0]!.content).toContain('<data name="problem">comparison: "£50,000" is not one of APX\'s figures;');
  });

  it('refuses after one failed repair, with a readable reason and both attempts\' tokens', async () => {
    const transport = scripted(submit(brokenNarrative()), submit(inventedFigure()));
    const result = await generateInvestmentNarrative({ ...base, transport });
    expect(transport.calls).toHaveLength(2);
    expect(result).toMatchObject({ ok: false, inputTokens: 8000, outputTokens: 6000, model: 'gpt-test', promptVersion: INVESTMENT_PROMPT_VERSION });
    if (!result.ok) {
      expect(result.reason).toMatch(/^The pack ChatGPT wrote did not pass APX's checks, even after one correction/);
      expect(result.reason).toContain('comparison: "£50,000" is not one of APX\'s figures');
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
    const result = await generateInvestmentNarrative({ ...base, transport });
    spy.mockRestore();
    expect(result).toMatchObject({ ok: false, inputTokens: 4000, outputTokens: 3000, model: 'gpt-test' });
    if (!result.ok) expect(result.reason).toMatch(/the correction could not be obtained: ChatGPT could not write the investment pack just now/);
  });

  it('refuses a reply with no submission, without a second call', async () => {
    const transport = scripted(text('end_turn'));
    const result = await generateInvestmentNarrative({ ...base, transport });
    expect(transport.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, reason: 'ChatGPT did not return the pack in the required form. Try again.', inputTokens: 4000, outputTokens: 100 });
  });

  it('refuses a submission cut off at the output limit, without a second call', async () => {
    const transport = scripted({ ...submit({}), stopReason: 'max_tokens' });
    const result = await generateInvestmentNarrative({ ...base, transport });
    expect(transport.calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/output limit/);
  });

  it('throws an UpstreamError the page can show when the provider fails, keeping a presentable one as it is', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejected = generateInvestmentNarrative({ ...base, transport: async () => { throw new Error('ECONNRESET 10.0.0.1:443'); } });
    await expect(rejected).rejects.toBeInstanceOf(UpstreamError);
    await expect(rejected).rejects.toThrow(/^ChatGPT could not write the investment pack just now/);
    const own = new UpstreamError('openai', 'The super admin has paused AI for this organisation.');
    await expect(generateInvestmentNarrative({ ...base, transport: async () => { throw own; } })).rejects.toBe(own);
    spy.mockRestore();
  });

  it('words the report transport\'s "no key" and "no model" for the pack', async () => {
    const key = await generateInvestmentNarrative({ ...base, transport: async () => { throw new UpstreamError('openai', NO_OPENAI_KEY); } }).catch((e: unknown) => e);
    expect(key).toBeInstanceOf(UpstreamError);
    expect((key as UpstreamError).message).toBe(INVESTMENT_NO_OPENAI_KEY);
    expect((key as UpstreamError).provider).toBe('openai');
    const model = await generateInvestmentNarrative({ ...base, transport: async () => { throw new UpstreamError('openai', NO_OPENAI_MODEL); } }).catch((e: unknown) => e);
    expect((model as UpstreamError).message).toBe(INVESTMENT_NO_OPENAI_MODEL);
  });

  it('keeps OpenAI\'s own words out of the message, in `provider` for the log, with any key masked', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refusal = new UpstreamError('OpenAI refused the call: Incorrect API key provided: sk-proj-****abcd.');
    const caught = await generateInvestmentNarrative({ ...base, transport: async () => { throw refusal; } }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).message).toMatch(/^ChatGPT could not write the investment pack just now/);
    expect((caught as UpstreamError).provider).toBe('OpenAI refused the call: Incorrect API key provided: [key]');
    spy.mockRestore();
  });

  it('throws the signal\'s own reason when the job\'s time runs out, so the job can say it took too long', async () => {
    const controller = new AbortController();
    const transport: ModelTransport = async () => {
      controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      throw new UpstreamError('OpenAI refused the call: The operation timed out.');
    };
    const caught = await generateInvestmentNarrative({ ...base, transport, signal: controller.signal }).catch((e: unknown) => e);
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
    await expect(generateInvestmentNarrative(base)).rejects.toThrow(INVESTMENT_NO_OPENAI_KEY);
    spy.mockRestore();
  });
});

describe('offline mode (MOTION_AI_OFFLINE=1)', () => {
  it('writes the pack from the country playbook and APX\'s figures, with no model and no cost', async () => {
    vi.stubEnv('MOTION_AI_OFFLINE', '1');
    const result = await generateInvestmentNarrative(base);
    expect(result).toMatchObject({ ok: true, model: INVESTMENT_OFFLINE_MODEL, promptVersion: INVESTMENT_PROMPT_VERSION, inputTokens: 0, outputTokens: 0 });
    if (!result.ok) return;
    const n = result.narrative;
    expect(n.objective).toContain('Convert Acme Goods Ltd\'s growth into sustainable shareholder value');
    expect(n.objective).toContain('prepared from APX\'s standard investment playbook for the United Kingdom without an AI model');
    expect(n.growthToSurplus).toContain('illustrative net profit rises to £311,040 by Year 5');
    expect(n.growthToSurplus).toContain('The £100,000 distributable surplus was entered by the analyst.');
    expect(n.reinvestment).toContain('A 20% growth rate is the base case, 35% is the acceleration case, and 50% is a stretch case');
    expect(n.reinvestment).toContain('Year 5 follows four annual growth periods');
    expect(n.externalIntro).toMatch(/^Five possible investment routes/);
    expect(n.options.map((o) => o.name)).toEqual([
      'Cash deposits & short-dated gilts', 'Investment-grade bond funds', 'Global equity index funds', 'Growth shares & sector ETFs', 'Minority stakes in businesses',
    ]);
    expect(n.options[0]!.referenceUrl).toBe('https://www.dmo.gov.uk/');
    expect(n.comparison).toContain('the £35,000 external allocation would grow to £46,585, a gain of £11,585');
    expect(n.comparison).toContain('the business would need £77,233 of additional sales');
    expect(n.recommendation.map((r) => r.text)).toEqual([
      'Defend the 20% base-case growth rate and operating liquidity.',
      'Deploy 45% of investable surplus to projects supporting 35–50% growth where evidence justifies it.',
      'Allocate 35% to an external portfolio; use 10% as an aspirational scenario, not a promise.',
      'Retain 20% additional liquidity beyond the operating reserve.',
    ]);
    expect(n.references.map((r) => r.url)).toContain('https://www.fscs.org.uk/');
  });

  it('is valid for every country and every shape of figures', () => {
    const shapes: Array<[string, InvestmentFigures]> = [
      ['client', CLIENT_FIGURES],
      ['annualised, net profit as surplus', {
        ...CLIENT_FIGURES,
        base: { ...CLIENT_FIGURES.base, yearLabel: '2026 (9 months, annualised)', annualised: true, netMarginPct: '14.6' },
        assumptions: { ...CLIENT_FIGURES.assumptions, surplusSource: 'net_profit' },
      }],
      ['no margin to compare', { ...CLIENT_FIGURES, comparison: { ...CLIENT_FIGURES.comparison, salesNeededForSameGain: null } }],
    ];
    const currencies: Record<string, string> = { GB: 'GBP', AE: 'AED', IE: 'EUR', IN: 'INR', generic: 'USD' };
    for (const playbook of INVESTMENT_PLAYBOOKS) {
      const countryCode = playbook.key === 'generic' ? 'US' : playbook.key;
      for (const [label, shape] of shapes) {
        const figures = { ...shape, base: { ...shape.base, currency: currencies[playbook.key]! } };
        const narrative = offlineInvestmentNarrative({ organisationName: 'A'.repeat(300), countryCode, figures });
        const result = checkInvestmentNarrative(narrative, { figures, playbook: playbookFor(countryCode) });
        expect(result.ok ? [] : result.problems, `${playbook.key} / ${label}`).toEqual([]);
      }
    }
  });

  it('says so, rather than estimating, when there is no margin to compare with', () => {
    const figures = { ...CLIENT_FIGURES, comparison: { ...CLIENT_FIGURES.comparison, salesNeededForSameGain: null } };
    const n = offlineInvestmentNarrative({ ...base, figures });
    expect(n.comparison).toContain('cannot be stated until it is profitable');
    expect(n.comparison).not.toContain('additional sales');
  });

  it('names the country\'s own regulators and writes money in its currency', () => {
    const n = offlineInvestmentNarrative({ ...base, countryCode: 'IN', figures: figuresIn('INR') });
    expect(n.references.map((r) => r.url)).toEqual(expect.arrayContaining(['https://www.sebi.gov.in/', 'https://www.rbi.org.in/']));
    expect(n.comparison).toContain('₹77,233 of additional sales');
    expect(n.levers[2]!.action).toBe('New Indian and international channels');
    expect(n.process[2]!.action).toBe('Select SEBI-registered intermediaries and corporate accounts');
  });

  it('still uses an injected transport: the switch is the default path\'s, not the tests\'', async () => {
    vi.stubEnv('MOTION_AI_OFFLINE', '1');
    const transport = scripted(submit(validInvestmentNarrative()));
    const result = await generateInvestmentNarrative({ ...base, transport });
    expect(transport.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, model: 'gpt-test' });
  });
});
