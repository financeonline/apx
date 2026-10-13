import 'server-only';
import { UpstreamError } from '@/core/errors';
import { log } from '@/core/logging';
import { compare, formatMoney, tryParseDecimal } from '@/core/money';
import { openAiReportTransport, type ModelCall, type ModelResponse, type ModelTransport } from '@/modules/ai';
import { checkNarrative, narrativeJsonSchema } from '../domain/narrative-schema';
import { templateFor, templateSections } from '../domain/industry-templates';
import {
  MARKETING_PROMPT_VERSION, SUBMIT_MARKETING_TOOL, buildMarketingPrompt, money, repairMessage, yearChanges, yearFigures,
} from '../domain/prompt';
import type { CompanyProfile, FinancialCommentary, MarketingFinancials, MarketingNarrative } from '../domain/types';

/**
 * Writes the Marketing report's narrative (ADR-170): Sections 01 and 02, the executive overview and
 * Section 03's commentary. The tables of Section 03 are the product's own figures and are not
 * written here; the caller (`generate-report.ts`) puts the two together.
 *
 * ONE forced-tool call (`submit_marketing_report`) whose schema is `MarketingNarrative`
 * (`narrative-schema.ts`), the same discipline as the statement and receipt readers (ADR-033,
 * ADR-150): text blocks are never read, and an answer that does not fit the schema and the semantic
 * checks is not used. Unlike a page of a statement, a report is expensive to write from scratch, so
 * a failed check earns ONE repair: the model's own submission and the list of problems go back to it
 * (as a tool result marked as an error, which OpenAI's translation carries as a `tool` message), and
 * it resubmits in full. The tokens of both attempts are added together, because both are billed and
 * both count under the organisation's monthly AI ceiling. A second failure, a reply with no
 * submission, a submission cut off at the output limit, or the provider failing on the repair (the
 * first attempt's tokens are still returned) is `ok: false` with a reason a person can read — never a
 * partial or guessed report.
 *
 * The model is OpenAI's, whichever provider is active (owner, 2026-10-13): the default transport is
 * `openAiReportTransport`. A provider that cannot be reached or is not configured is an
 * `UpstreamError` with a message the page can show (no key; no model on the OpenAI card; ChatGPT
 * unavailable) — thrown, not returned, so the job can tell "the provider is down" from "the model
 * wrote something unusable".
 *
 * OFFLINE (`MOTION_AI_OFFLINE=1`, as the automated test server runs, ADR-157): no model is called.
 * The narrative is built deterministically from the industry template, with Section 03's commentary
 * restating the figures only, and the model is recorded as `offline-template` — so local demos and
 * the end-to-end suite produce a complete report with no key and no cost. An injected transport
 * always wins over the switch (as in `claude-client.ts`, where the switch lives in the live
 * transport), so the unit tests drive the real path with fakes.
 */

export const OFFLINE_MODEL = 'offline-template';

/**
 * The output budget asked for. A whole report runs to roughly 4,000–6,000 output tokens, and a
 * reasoning model's thinking counts against the same limit; the transport clamps this to what the
 * chosen model accepts (`reportOutputCeiling`).
 */
export const MARKETING_MAX_TOKENS = 32_000;

/** The first attempt and one repair. */
const MAX_ATTEMPTS = 2;

type Message = ModelCall['messages'][number];
type Tool = ModelCall['tools'][number];

export function aiOffline(): boolean {
  return process.env.MOTION_AI_OFFLINE === '1';
}

export function submitMarketingTool(): Tool {
  return {
    name: SUBMIT_MARKETING_TOOL,
    description: 'Submit the complete marketing report: the executive overview, Section 01, Section 02 and the Section 03 commentary (null when no figures were supplied). The only way to answer.',
    input_schema: narrativeJsonSchema() as Tool['input_schema'],
  };
}

export interface GenerateNarrativeInput {
  readonly organisationName: string;
  readonly profile: CompanyProfile;
  readonly currency: string;
  readonly financials: MarketingFinancials | null;
  readonly signal?: AbortSignal;
  readonly transport?: ModelTransport;
}

interface Usage {
  readonly model: string;
  readonly promptVersion: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type GenerateNarrativeResult =
  | ({ readonly ok: true; readonly narrative: MarketingNarrative } & Usage)
  | ({ readonly ok: false; readonly reason: string } & Usage);

const SERVICE = 'marketing.generate-narrative';

const UNREACHABLE = 'ChatGPT could not write the marketing report just now. Try again in a few minutes; if it keeps failing, the super admin should check the OpenAI key and its billing on the Account page.';
/** `UpstreamError`'s own default message: one that says nothing about what failed. */
const GENERIC_UPSTREAM = new UpstreamError('openai').message;

/**
 * The transport, with every failure made one the job can present (`generate-report.ts` shows an
 * `UpstreamError`'s message to the person and records its `provider` as the detail):
 *
 *   - the caller's signal fired (the job's time budget, or a cancellation): its own reason is thrown —
 *     a `TimeoutError` or `AbortError` the job words as "took too long" — rather than whatever the
 *     interrupted call made of it;
 *   - an `UpstreamError` that already says what to do (no key; no model chosen) passes as it is;
 *   - anything else — OpenAI's own refusal arrives from `callOpenAi` under the generic message with
 *     its reason in `provider` — becomes APX's sentence, with the provider's text kept in `provider`
 *     for the job row and the log only (any key-like string masked), never in the message.
 */
async function callTransport(transport: ModelTransport, call: ModelCall): Promise<ModelResponse> {
  try {
    return await transport(call);
  } catch (cause) {
    if (call.signal?.aborted) throw call.signal.reason ?? cause;
    if (cause instanceof UpstreamError && cause.message !== GENERIC_UPSTREAM) throw cause;
    const said = (cause instanceof UpstreamError ? cause.provider : cause instanceof Error ? cause.message : String(cause))
      .replace(/sk-[\w*.-]+/g, '[key]').slice(0, 300);
    log.error('the marketing report model call failed', { service: SERVICE, error: said });
    throw new UpstreamError(said || 'openai', UNREACHABLE);
  }
}

/** A short, readable summary of the problems for the stored failure; the full list goes to the model. */
const detail = (problems: readonly string[]) => problems.slice(0, 2).join('; ') + (problems.length > 2 ? `; and ${problems.length - 2} more` : '');

export async function generateMarketingNarrative(input: GenerateNarrativeInput): Promise<GenerateNarrativeResult> {
  const context = { financials: input.financials };

  if (input.transport === undefined && aiOffline()) {
    const checked = checkNarrative(offlineNarrative(input), context);
    const usage = { model: OFFLINE_MODEL, promptVersion: MARKETING_PROMPT_VERSION, inputTokens: 0, outputTokens: 0 };
    return checked.ok
      ? { ok: true, narrative: checked.narrative, ...usage }
      : { ok: false, reason: `The offline report did not pass APX's checks (${detail(checked.problems)}).`, ...usage };
  }

  const transport = input.transport ?? openAiReportTransport;
  const prompt = buildMarketingPrompt(input);
  const tool = submitMarketingTool();
  const messages: Message[] = [{ role: 'user', content: prompt.user }];
  let usage: Usage = { model: 'unknown', promptVersion: MARKETING_PROMPT_VERSION, inputTokens: 0, outputTokens: 0 };
  const fail = (reason: string): GenerateNarrativeResult => ({ ok: false, reason, ...usage });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: ModelResponse;
    try {
      response = await callTransport(transport, {
        system: [{ text: prompt.system, cached: true }],
        messages: [...messages],
        tools: [tool],
        toolChoice: { type: 'tool', name: SUBMIT_MARKETING_TOOL },
        maxTokens: MARKETING_MAX_TOKENS,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (cause) {
      /*
       * The provider failing on the REPAIR is still a refused draft — and the first attempt's tokens
       * were spent and billed, so they are returned to be recorded under the monthly ceiling rather
       * than lost with a thrown error. A timeout or cancellation is thrown as it is, for the job to word.
       */
      if (attempt === 1 || !(cause instanceof UpstreamError)) throw cause;
      log.warn('the marketing report repair could not be obtained', { service: SERVICE, ...usage });
      return fail(`The report ChatGPT wrote did not pass APX's checks, and the correction could not be obtained: ${cause.message}`);
    }
    usage = {
      model: response.model,
      promptVersion: MARKETING_PROMPT_VERSION,
      inputTokens: usage.inputTokens + response.usage.inputTokens,
      outputTokens: usage.outputTokens + response.usage.outputTokens,
    };

    if (response.stopReason === 'max_tokens') {
      log.warn('the marketing report was cut off at the output limit', { service: SERVICE, attempt, ...usage });
      return fail('ChatGPT stopped before finishing the report because it reached its output limit. Try again, or choose a model with a larger output limit on the OpenAI card.');
    }
    const use = response.content.find((block) => block.type === 'tool_use' && block.name === SUBMIT_MARKETING_TOOL);
    if (use === undefined || use.type !== 'tool_use') {
      log.warn('the model did not submit the marketing report', { service: SERVICE, attempt, stopReason: response.stopReason, ...usage });
      return fail('ChatGPT did not return the report in the required form. Try again.');
    }

    const checked = checkNarrative(use.input, context);
    if (checked.ok) {
      log.info('marketing report narrative written', { service: SERVICE, attempts: attempt, ...usage });
      return { ok: true, narrative: checked.narrative, ...usage };
    }
    if (attempt === MAX_ATTEMPTS) {
      log.warn('the marketing report failed its checks after one repair', { service: SERVICE, problems: checked.problems.length, ...usage });
      return fail(`The report ChatGPT wrote did not pass APX's checks, even after one correction (${detail(checked.problems)}). Try again.`);
    }

    log.warn('the marketing report failed its checks; asking for one repair', { service: SERVICE, problems: checked.problems.length });
    messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: use.id, name: use.name, input: use.input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, is_error: true, content: repairMessage(checked.problems) }] },
    );
  }
  /* c8 ignore next */
  return fail('ChatGPT did not return the report in the required form. Try again.');
}

/* ------------------------------------------------------------------------------------------------ */
/* Offline: the deterministic narrative                                                             */
/* ------------------------------------------------------------------------------------------------ */

/** "a", "a and b", "a, b and c". */
const list = (items: readonly string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** "The example test budget": £3,000 a month in the organisation's currency, or the code if Intl does not know it. */
function exampleBudget(currency: string, amount: string): string {
  try {
    return formatMoney(amount, { currency });
  } catch {
    return `${currency} ${new Intl.NumberFormat('en-GB').format(BigInt(amount))}`;
  }
}

/** One standard commercial action per cost line, chosen by what the line is called. */
const COST_ACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/transport|distribution|delivery|carriage|freight|postage|shipping|courier|fulfil/i, 'Audit fulfilment cost by order, destination and carrier'],
  [/advertis|marketing|promotion/i, 'Move spend to measured campaigns with a maximum acquisition cost'],
  [/website|\bweb\b|\bit\b|software|subscription|technology|computer|hosting|platform/i, 'Review platform subscriptions and the return on development spend'],
  [/telephone|phone|internet|broadband/i, 'Review telephone and internet contracts against current use'],
  [/wage|salar|staff|payroll|personnel|employ|pension|people|remuneration|director/i, 'Match staffing to demand and track revenue per employee'],
  [/subcontract/i, 'Compare subcontractor rates and agree the scope before each job'],
  [/rent|rates|premises|property|lease|occupancy/i, 'Review premises costs and lease terms against the revenue they support'],
  [/stock|inventory|purchas|material|goods|cost of sales|supplies|supplier/i, 'Review supplier prices, stock turns and slow-moving lines'],
  [/repair|maintenance/i, 'Plan maintenance ahead and compare contractor quotes'],
  [/insurance/i, 'Re-tender insurance and confirm the cover matches current risks'],
  [/utilit|energy|electric|\bgas\b|water|heat/i, 'Review energy contracts and usage'],
  [/bank|interest|finance|charge|payment|merchant|card fee/i, 'Review payment and finance charges with each provider'],
  [/professional|legal|accountan|consult|\bfees?\b/i, 'Agree scope and fixed fees for professional services'],
  [/travel|vehicle|motor|fuel/i, 'Review travel and vehicle costs against the work they support'],
  [/depreciation|amortisation|amortization/i, 'Review the return on equipment and capital spending'],
];

export function costAction(name: string): string {
  return COST_ACTIONS.find(([pattern]) => pattern.test(name))?.[1] ?? 'Review this cost against budget and the revenue it supports, with a named owner';
}

/** Section 03's commentary, offline: the figures restated, the standard actions, nothing inferred. */
export function offlineCommentary(financials: MarketingFinancials): FinancialCommentary {
  const { currency } = financials;
  const years = financials.years.map((y) => yearFigures(y, currency));
  const series = (pick: (y: (typeof years)[number]) => string | null) => years.filter((y) => pick(y) !== null).map((y) => `${pick(y)} in ${y.label}`);

  const performance: string[] = [];
  if (years.length === 0) {
    performance.push('APX does not yet hold a financial year with complete figures for this company, so there is no performance to compare.');
  } else {
    const turnover = series((y) => y.turnover);
    const cos = series((y) => y.costOfSalesPct);
    const gross = series((y) => y.grossProfitPct);
    const net = series((y) => y.netProfitPct);
    if (turnover.length > 0) performance.push(`Turnover was ${list(turnover)}.`);
    if (cos.length > 0) performance.push(`Cost of sales over sales was ${list(cos)}.`);
    if (gross.length > 0) performance.push(`Gross profit over sales was ${list(gross)}.`);
    if (net.length > 0) performance.push(`Net profit over sales was ${list(net)}.`);
    const last = financials.years.length - 1;
    if (last >= 1) {
      const change = yearChanges(financials.years[last - 1]!, financials.years[last]!).find((c) => c.measure === 'turnover');
      if (change) performance.push(`Turnover changed by ${change.change} from ${financials.years[last - 1]!.label} to ${financials.years[last]!.label}.`);
    }
    const partial = years.filter((y) => y.partial).map((y) => y.label);
    if (partial.length > 0) performance.push(`${list(partial)} ${partial.length === 1 ? 'is a part year' : 'are part years'}, so ${partial.length === 1 ? 'it is' : 'they are'} not directly comparable with a full year.`);
  }
  performance.push('This offline summary restates the figures without interpreting them.');

  let productSales: string | null = null;
  const sales = financials.productSales;
  if (sales !== null && sales.rows.length > 0) {
    const top = [...sales.rows]
      .filter((r) => r.current !== null && tryParseDecimal(r.current) !== null)
      .sort((a, b) => compare(b.current!, a.current!))[0];
    productSales = top === undefined
      ? `The table shows product-sector sales for ${sales.previousLabel} and ${sales.currentLabel}.`
      : `${top.product.slice(0, 80)} had the largest sales in ${sales.currentLabel}, at ${money(top.current, currency)}. The table shows each line's change on ${sales.previousLabel}.`;
  }

  const latestSpend = [...years].reverse().find((y) => y.marketingSpend !== null);
  const marketingEfficiency = latestSpend === undefined
    ? 'The figures do not show advertising and marketing spend separately. Record it as its own cost line so that marketing intensity can be tracked against turnover. Accounting caution: confirm whether any advertising, delivery or payment costs are classified within cost of sales, as gross profit would then not be a pure product margin.'
    : `Advertising and marketing spend was ${latestSpend.marketingSpend} in ${latestSpend.label}${latestSpend.marketingPct === null ? '' : ` (${latestSpend.marketingPct} of turnover)`}. The figures alone do not show whether that spend drove sales, so restart or grow investment through measured tests rather than a large fixed budget. Accounting caution: confirm whether any advertising, delivery or payment costs are classified within cost of sales, as gross profit would then not be a pure product margin.`;

  return {
    performance: performance.join(' '),
    productSales,
    marketingEfficiency,
    costActions: financials.costLines.map((c) => costAction(c.name)),
    actionPlan: [
      'Calculate contribution after delivery, payment, returns and advertising costs for each product or service.',
      'Review supplier costs, pricing and discount policy to protect gross margin.',
      'Identify slow-moving stock or low-margin work and protect cash.',
      'Set a maximum customer acquisition cost for each campaign from contribution, not revenue alone.',
      'Monitor revenue, gross margin, net margin and marketing spend every month.',
    ],
    conclusion: 'Connect product profitability, sector-led acquisition and retention into one commercial plan. Invest first in the highest-contribution products and customer sectors, and increase marketing spend only where measured tests show that contribution and cash flow support it.',
  };
}

/** The whole narrative, offline, from the industry template (see the module note). */
export function offlineNarrative(input: Pick<GenerateNarrativeInput, 'organisationName' | 'profile' | 'currency' | 'financials'>): MarketingNarrative {
  const template = templateFor(input.profile.industry, input.profile.productsServices);
  const sections = templateSections(template, {
    organisationName: input.organisationName,
    productsServices: input.profile.productsServices,
    industry: input.profile.industry,
    exampleMonthlyBudget: exampleBudget(input.currency, '3000'),
    exampleAnnualBudget: exampleBudget(input.currency, '36000'),
  });
  const overview = 'The strategy is structured in the same sequence as a management presentation: competitor and customer sectors first, then campaign and commercial implementation, '
    + (input.financials === null
      ? 'with the financial overview to follow once figures are available in APX.'
      : 'with the financial overview at the end.')
    + ` This version was written from APX's standard ${template.label.toLowerCase()} playbook without an AI model, so it is generic to the industry.`;
  return {
    objective: sections.objective,
    overview,
    competitors: sections.competitors,
    strategy: sections.strategy,
    financialCommentary: input.financials === null ? null : offlineCommentary(input.financials),
  };
}
