import 'server-only';
import { UpstreamError } from '@/core/errors';
import { log } from '@/core/logging';
import {
  NO_OPENAI_KEY, NO_OPENAI_MODEL, openAiReportTransport, type ModelCall, type ModelResponse, type ModelTransport,
} from '@/modules/ai';
import type { CompanyProfile } from '@/modules/marketing';
import { HIGH_RISK_CAP_PCT, checkInvestmentNarrative, investmentNarrativeJsonSchema } from '../domain/narrative-schema';
import { defaultOptions, defaultReferences, playbookFor, type InvestmentPlaybook } from '../domain/playbooks';
import {
  INVESTMENT_PROMPT_VERSION, SUBMIT_INVESTMENT_TOOL, buildInvestmentPrompt, countWord, figureText, investmentRepairMessage,
} from '../domain/prompt';
import type { InvestmentFigures, InvestmentNarrative } from '../domain/types';

/**
 * Writes the Investment Pack's words (ADR-171): the objective, Sections 01–05, the options, the
 * portfolio's asset classes and shares, the comparison and the references. Every number is APX's
 * (`InvestmentFigures`), worked out before this is called; the caller (`generate-report.ts`) puts the
 * figures, these words and the portfolio's amounts together.
 *
 * Marketing's writer exactly (ADR-170, `marketing/services/generate-narrative.ts`): ONE forced-tool
 * call (`submit_investment_pack`) whose schema is `InvestmentNarrative` (`narrative-schema.ts`); text
 * blocks are never read; an answer that fails the schema or the semantic checks (risk order, the
 * portfolio's 100% and 10% high-risk limit, playbook-only links, no named products, APX's numbers
 * only) earns ONE repair — the model's own submission and the problems go back to it as a tool result
 * marked as an error — and is refused if it fails again. The tokens of both attempts are added
 * together (both are billed, and both count under the organisation's monthly AI ceiling). A second
 * failure, a reply with no submission, a submission cut off at the output limit, or the provider
 * failing on the repair (the first attempt's tokens are still returned) is `ok: false` with a reason a
 * person can read — never a partial or guessed pack.
 *
 * The model is OpenAI's, whichever provider is active (owner, 2026-10-13): the default transport is
 * `openAiReportTransport` (the OpenAI key; the OpenAI card's model and effort). A provider that cannot
 * be reached or is not configured is an `UpstreamError` with a message the page can show — thrown, not
 * returned, so the job can tell "the provider is down" from "the model wrote something unusable". The
 * transport's own "no key" and "no model" sentences name the marketing report; they are re-worded for
 * the pack here (the fix they name is the same).
 *
 * OFFLINE (`MOTION_AI_OFFLINE=1`, ADR-157): no model is called. The narrative is built from the
 * country playbook and APX's figures (restated, never inferred), says on its cover that it is APX's
 * standard template, and is recorded as `offline-template` — so demos and the end-to-end suite get a
 * complete pack with no key and no cost. An injected transport always wins over the switch, so the
 * unit tests drive the real path with fakes.
 */

export const INVESTMENT_OFFLINE_MODEL = 'offline-template';

/**
 * The output budget asked for. A whole pack runs to roughly 2,500–3,500 output tokens, and a
 * reasoning model's thinking counts against the same limit; the transport clamps this to what the
 * chosen model accepts (`reportOutputCeiling`).
 */
export const INVESTMENT_MAX_TOKENS = 32_000;

/** The first attempt and one repair. */
const MAX_ATTEMPTS = 2;

type Message = ModelCall['messages'][number];
type Tool = ModelCall['tools'][number];

function aiOffline(): boolean {
  return process.env.MOTION_AI_OFFLINE === '1';
}

export function submitInvestmentTool(): Tool {
  return {
    name: SUBMIT_INVESTMENT_TOOL,
    description: 'Submit the complete investment pack: the objective, Sections 01–05, the external options and illustrative portfolio, the comparison, the process and the reference links. The only way to answer.',
    input_schema: investmentNarrativeJsonSchema() as Tool['input_schema'],
  };
}

export interface GenerateInvestmentNarrativeInput {
  readonly organisationName: string;
  readonly profile: CompanyProfile;
  /** `organizations.country_code` (ISO 3166-1 alpha-2): chooses the playbook. */
  readonly countryCode: string;
  readonly figures: InvestmentFigures;
  readonly signal?: AbortSignal;
  readonly transport?: ModelTransport;
}

interface Usage {
  readonly model: string;
  readonly promptVersion: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type GenerateInvestmentNarrativeResult =
  | ({ readonly ok: true; readonly narrative: InvestmentNarrative } & Usage)
  | ({ readonly ok: false; readonly reason: string } & Usage);

const SERVICE = 'investment.generate-narrative';

const UNREACHABLE = 'ChatGPT could not write the investment pack just now. Try again in a few minutes; if it keeps failing, the super admin should check the OpenAI key and its billing on the Account page.';
export const INVESTMENT_NO_OPENAI_KEY = 'The investment pack is written by ChatGPT and needs an OpenAI key. The super admin adds it on the Account page.';
export const INVESTMENT_NO_OPENAI_MODEL = 'The investment pack is written by ChatGPT and needs an OpenAI model. The super admin chooses one in the model drop-down on the OpenAI card on the Account page.';
/** `UpstreamError`'s own default message: one that says nothing about what failed. */
const GENERIC_UPSTREAM = new UpstreamError('openai').message;

/**
 * The transport, with every failure made one the job can present (as Marketing's):
 *
 *   - the caller's signal fired (the job's time budget, or a cancellation): its own reason is thrown —
 *     a `TimeoutError` or `AbortError` the job words as "took too long";
 *   - the report transport's "no key" / "no model" — re-worded to name the pack;
 *   - another `UpstreamError` that already says what to do passes as it is;
 *   - anything else becomes APX's sentence, with the provider's text kept in `provider` for the job
 *     row and the log only (any key-like string masked), never in the message.
 */
async function callTransport(transport: ModelTransport, call: ModelCall): Promise<ModelResponse> {
  try {
    return await transport(call);
  } catch (cause) {
    if (call.signal?.aborted) throw call.signal.reason ?? cause;
    if (cause instanceof UpstreamError && cause.message === NO_OPENAI_KEY) throw new UpstreamError(cause.provider, INVESTMENT_NO_OPENAI_KEY);
    if (cause instanceof UpstreamError && cause.message === NO_OPENAI_MODEL) throw new UpstreamError(cause.provider, INVESTMENT_NO_OPENAI_MODEL);
    if (cause instanceof UpstreamError && cause.message !== GENERIC_UPSTREAM) throw cause;
    const said = (cause instanceof UpstreamError ? cause.provider : cause instanceof Error ? cause.message : String(cause))
      .replace(/sk-[\w*.-]+/g, '[key]').slice(0, 300);
    log.error('the investment pack model call failed', { service: SERVICE, error: said });
    throw new UpstreamError(said || 'openai', UNREACHABLE);
  }
}

/** A short, readable summary of the problems for the stored failure; the full list goes to the model. */
const detail = (problems: readonly string[]) => problems.slice(0, 2).join('; ') + (problems.length > 2 ? `; and ${problems.length - 2} more` : '');

export async function generateInvestmentNarrative(input: GenerateInvestmentNarrativeInput): Promise<GenerateInvestmentNarrativeResult> {
  if (input.transport === undefined && aiOffline()) {
    const playbook = playbookFor(input.countryCode);
    const checked = checkInvestmentNarrative(offlineInvestmentNarrative(input), { figures: input.figures, playbook });
    const usage = { model: INVESTMENT_OFFLINE_MODEL, promptVersion: INVESTMENT_PROMPT_VERSION, inputTokens: 0, outputTokens: 0 };
    return checked.ok
      ? { ok: true, narrative: checked.narrative, ...usage }
      : { ok: false, reason: `The offline pack did not pass APX's checks (${detail(checked.problems)}).`, ...usage };
  }

  const transport = input.transport ?? openAiReportTransport;
  const prompt = buildInvestmentPrompt(input);
  const context = { figures: input.figures, playbook: prompt.playbook };
  const tool = submitInvestmentTool();
  const messages: Message[] = [{ role: 'user', content: prompt.user }];
  let usage: Usage = { model: 'unknown', promptVersion: INVESTMENT_PROMPT_VERSION, inputTokens: 0, outputTokens: 0 };
  const fail = (reason: string): GenerateInvestmentNarrativeResult => ({ ok: false, reason, ...usage });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: ModelResponse;
    try {
      response = await callTransport(transport, {
        system: [{ text: prompt.system, cached: true }],
        messages: [...messages],
        tools: [tool],
        toolChoice: { type: 'tool', name: SUBMIT_INVESTMENT_TOOL },
        maxTokens: INVESTMENT_MAX_TOKENS,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (cause) {
      // The provider failing on the REPAIR is still a refused draft, and the first attempt's tokens
      // were billed: they are returned to be recorded. A timeout or cancellation is thrown as it is.
      if (attempt === 1 || !(cause instanceof UpstreamError)) throw cause;
      log.warn('the investment pack repair could not be obtained', { service: SERVICE, ...usage });
      return fail(`The pack ChatGPT wrote did not pass APX's checks, and the correction could not be obtained: ${cause.message}`);
    }
    usage = {
      model: response.model,
      promptVersion: INVESTMENT_PROMPT_VERSION,
      inputTokens: usage.inputTokens + response.usage.inputTokens,
      outputTokens: usage.outputTokens + response.usage.outputTokens,
    };

    if (response.stopReason === 'max_tokens') {
      log.warn('the investment pack was cut off at the output limit', { service: SERVICE, attempt, ...usage });
      return fail('ChatGPT stopped before finishing the pack because it reached its output limit. Try again, or choose a model with a larger output limit on the OpenAI card.');
    }
    const use = response.content.find((block) => block.type === 'tool_use' && block.name === SUBMIT_INVESTMENT_TOOL);
    if (use === undefined || use.type !== 'tool_use') {
      log.warn('the model did not submit the investment pack', { service: SERVICE, attempt, stopReason: response.stopReason, ...usage });
      return fail('ChatGPT did not return the pack in the required form. Try again.');
    }

    const checked = checkInvestmentNarrative(use.input, context);
    if (checked.ok) {
      log.info('investment pack narrative written', { service: SERVICE, attempts: attempt, ...usage });
      return { ok: true, narrative: checked.narrative, ...usage };
    }
    if (attempt === MAX_ATTEMPTS) {
      log.warn('the investment pack failed its checks after one repair', { service: SERVICE, problems: checked.problems.length, ...usage });
      return fail(`The pack ChatGPT wrote did not pass APX's checks, even after one correction (${detail(checked.problems)}). Try again.`);
    }

    log.warn('the investment pack failed its checks; asking for one repair', { service: SERVICE, problems: checked.problems.length });
    messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: use.id, name: use.name, input: use.input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, is_error: true, content: investmentRepairMessage(checked.problems) }] },
    );
  }
  /* c8 ignore next */
  return fail('ChatGPT did not return the pack in the required form. Try again.');
}

/* ------------------------------------------------------------------------------------------------ */
/* Offline: the deterministic narrative                                                             */
/* ------------------------------------------------------------------------------------------------ */

const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);
const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * The whole narrative, offline, from the country playbook and APX's figures: the client's example's
 * words with this company's figures restated (never a figure inferred), the playbook's five default
 * options, portfolio, process, controls and references. The cover and Section 03 say it is APX's
 * standard template, not a pack tailored by a model.
 */
export function offlineInvestmentNarrative(
  input: Pick<GenerateInvestmentNarrativeInput, 'organisationName' | 'countryCode' | 'figures'>,
): InvestmentNarrative {
  const playbook: InvestmentPlaybook = playbookFor(input.countryCode);
  const t = figureText(input.figures);
  const name = clip(input.organisationName.trim() || 'The company', 120);
  const options = defaultOptions(playbook);
  const finalProfit = t.baseCase.years[t.baseCase.years.length - 1]?.netProfit ?? t.netProfit;
  const c = t.comparison;
  const [business, external, liquidity] = [t.split.business[0], t.split.external[0], t.split.liquidity[0]];

  const comparison = c.salesNeeded === null
    ? `Invested at an illustrative ${c.rate} a year for ${countWord(c.years)} years, the ${c.amount} external allocation would grow to ${c.value}, a gain of ${c.gain} before fees and taxes. The base year shows no positive net margin, so the sales the business would need to earn the same gain cannot be stated until it is profitable.`
    : `Invested at an illustrative ${c.rate} a year for ${countWord(c.years)} years, the ${c.amount} external allocation would grow to ${c.value}, a gain of ${c.gain} before fees and taxes. To earn the same ${c.gain} as net profit at the base year's ${t.margin} net margin, the business would need ${c.salesNeeded} of additional sales. On these illustrative figures, a diversified external portfolio can put this amount to work more efficiently than the equivalent sales effort, but its returns are not guaranteed and core-business projects with evidence of demand remain the first call on capital.`;

  return {
    objective: `Convert ${name}'s growth into sustainable shareholder value through disciplined reinvestment and a diversified external investment programme. This version was prepared from APX's standard investment playbook for ${playbook.country} without an AI model, so it is not tailored to the company.`,
    growthToSurplus: `A company delivering consistent ${t.growth[0]} growth can generate rising annual profits when margins remain stable: at the base year's ${t.margin} net margin, illustrative net profit rises to ${finalProfit} by ${t.finalYearLabel}.`
      + (t.annualised ? ` The base year (${t.yearLabel}) held fewer than twelve months, so its figures are annualised.` : '')
      + ' Management should distinguish accounting profits from investable free cash after tax, working capital, debt service and capital expenditure; the projected profit does not imply that the full amount is available for investment.'
      + (t.surplusFromAnalyst ? ` The ${t.surplus} distributable surplus was entered by the analyst.` : ` The ${t.surplus} distributable surplus is the base year's net profit, before any reserves are set aside.`),
    reinvestment: `Prioritise opportunities where management has direct commercial influence. A ${t.growth[0]} growth rate is the base case, ${t.growth[1]} is the acceleration case, and ${t.growth[2]} is a stretch case requiring evidence of demand, capacity and funding. The illustrations use the base year's ${t.revenue} revenue and a constant ${t.margin} net margin; ${t.finalYearLabel} follows ${t.growthPeriods} annual growth periods. Growth is not the same as investment return.`,
    levers: [...playbook.levers],
    externalIntro: `${capitalise(countWord(options.length))} possible investment routes span lower-risk liquidity instruments through higher-risk private company investments. The portfolio should not depend on a ${t.target} return every year; volatility, losses, fees and taxes matter. These are the standard routes in APX's playbook for ${playbook.country}, not options selected for the company.`,
    options,
    portfolio: [...playbook.portfolio],
    portfolioNote: `This is a diversified growth illustration, not a guaranteed ${t.target} portfolio. High-risk investments are limited to ${HIGH_RISK_CAP_PCT}% of the external allocation.`,
    comparison,
    process: [...playbook.process],
    governance: [...playbook.governance],
    recommendation: [
      { title: 'Protect growth', text: `Defend the ${t.growth[0]} base-case growth rate and operating liquidity.` },
      { title: 'Accelerate expansion', text: `Deploy ${business} of investable surplus to projects supporting ${t.expansionRange} growth where evidence justifies it.` },
      { title: 'Diversify wealth creation', text: `Allocate ${external} to an external portfolio; use ${t.target} as an aspirational scenario, not a promise.` },
      { title: 'Preserve flexibility', text: `Retain ${liquidity} additional liquidity beyond the operating reserve.` },
    ],
    references: defaultReferences(playbook),
  };
}
