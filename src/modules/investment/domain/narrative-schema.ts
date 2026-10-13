import { z } from 'zod';
import { Decimal, formatMoney, tryParseDecimal } from '@/core/money';
import { CRYPTO_PATTERN, NAMED_PRODUCT_WORDS, type InvestmentPlaybook, type PlaybookLink } from './playbooks';
import type { InvestmentFigures, InvestmentNarrative, RiskLevel } from './types';

/**
 * The Investment Pack's AI contract (ADR-171): the zod schema the model's `submit_investment_pack`
 * input must fit, and the checks a schema cannot express — Marketing's discipline exactly (ADR-170,
 * `marketing/domain/narrative-schema.ts`; first set for statement and receipt extraction, ADR-033,
 * ADR-150): ONE forced tool whose schema is this file; anything that does not fit is a failure,
 * repaired once with the problems sent back, then refused — never a guess.
 *
 * The schema is the shape of `InvestmentNarrative` in `types.ts` exactly (a compile-time check below
 * keeps them in step). The bounds are the client's example pack's (five levers, five options, five
 * portfolio lines, six process stages, six governance controls, four committee priorities, six
 * references) with room either side. It keeps to what OpenAI function calling carries (ADR-164): every
 * key required, no extra keys, `anyOf [T, null]` for a nullable value, no `$ref`, no combinators.
 *
 * Semantic checks (after parsing), each worded for the model to fix:
 *
 *   - RISK ORDER: the options run from lower to higher risk (each at least as risky as the one
 *     before), as the client's example does; crypto, by whatever name, is only ever `very_high`.
 *   - THE PORTFOLIO: whole percentages adding up to exactly 100, each asset class once, and `high` plus
 *     `very_high` together at most 10 — the client's own rule: "High-risk investments are limited to
 *     10% of the external allocation".
 *   - LINKS: every option's reference and every reference link is an http(s) address ON THE COUNTRY'S
 *     PLAYBOOK (`playbooks.ts`) — the model chooses among pages a person chose; it never supplies an
 *     address of its own (so no guessed URL and no single fund's product page reaches a pack). The
 *     references include at least one regulator.
 *   - NO NAMED PRODUCTS: no fund provider, platform or coin named in the options, the portfolio or
 *     the prose (Stage 1 is illustrative, never a named fund to buy); the reference LABELS may name a
 *     provider, because a reference is a page to read.
 *   - THE NUMBERS ARE APX's: every amount (currency symbol or code with digits: "£35,000", "£1m",
 *     "AED 35,000", "₹10 lakh") and every percentage ("10%", "20–50%", "15 per cent") written in any
 *     prose field must be one of APX's figures (`InvestmentFigures`), the narrative's own portfolio
 *     shares (or their amounts on the external allocation), the 10% high-risk limit or 100%. A
 *     restatement may be rounded the way people round — "approximately £311,000" for £311,040, "£1m"
 *     for £1,000,000, "£2.07m" for £2,073,600, "15%" for a 15.0% margin — so a mention matches a figure
 *     when it is that figure rounded to the mention's own precision (half its last significant place)
 *     and, for money, also within 1% of it (so a coarse "£60,000" is not passed off as £61,215); an
 *     invented "£50,000", a computed "61% cumulative gain" or a market yield fails. The comparison
 *     must state the gain and, when APX gives one, the sales needed for the same gain.
 *
 * The figures check covers EVERY prose field, not just the three the brief names (01, 02 and the
 * comparison): the committee recommendation restates the split, and a number anywhere in a board pack
 * is read as a fact. It is pragmatic, not a parser of English — an amount without a currency marker or
 * a number without a percent sign is not examined — and it errs towards passing a fair restatement.
 *
 * Deterministic tidy-ups run first, because a repair costs a second model call: a bare domain gains
 * `https://`; a link that is a playbook page written another way (scheme, `www.`, trailing slash, case)
 * takes the playbook's own spelling; a reference listed twice is kept once.
 */

/* ------------------------------------------------------------------------------------------------ */
/* Bounds                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export const INVESTMENT_NARRATIVE_BOUNDS = {
  levers: { min: 4, max: 6 },
  options: { min: 3, max: 5 },
  portfolio: { min: 3, max: 6 },
  process: { min: 5, max: 7 },
  governance: { min: 4, max: 8 },
  recommendation: 4,
  references: { min: 2, max: 8 },
} as const;

/** The client's rule: high plus very-high risk together, as a share of the external allocation. */
export const HIGH_RISK_CAP_PCT = 10;

/** Lowest to highest: the order the options must follow. */
export const RISK_LEVELS = ['lower', 'low_medium', 'medium', 'higher', 'high', 'very_high'] as const;

/** The levels the 10% limit counts. */
export const HIGH_RISK_LEVELS: ReadonlySet<RiskLevel> = new Set<RiskLevel>(['high', 'very_high']);

export function riskRank(risk: RiskLevel): number {
  return RISK_LEVELS.indexOf(risk);
}

/** A non-blank line of prose, at most `max` characters. */
const text = (max: number) => z.string().min(1).max(max).refine((s) => s.trim().length > 0, 'must not be blank');
/** Whole percent as a string ("45"), as `PortfolioShare.percent` is. */
const WholePercent = z.string().regex(/^\d{1,3}$/, 'a whole number of percent, digits only (no % sign)');
/** A link, checked as http(s) and against the playbook after parsing (so it can be tidied rather than refused). */
const Link = z.string().min(1).max(300);
const Risk = z.enum(RISK_LEVELS);

export const InvestmentLeverSchema = z.strictObject({
  lever: text(60).describe('Short name of the lever, e.g. "Customer acquisition".'),
  action: text(160).describe('The proposed action, under twelve words.'),
  measure: text(120).describe('One to three key measures, separated by semicolons.'),
});

export const InvestmentOptionSchema = z.strictObject({
  name: text(80).describe('An asset class or route, never a provider, fund, share or coin.'),
  risk: Risk,
  description: text(320).describe('One or two sentences: its purpose and its main risk.'),
  referenceUrl: Link.nullable().describe('One of the playbook\'s reference links exactly as listed, or null.'),
});

export const PortfolioShareSchema = z.strictObject({
  assetClass: text(60),
  percent: WholePercent,
  risk: Risk,
});

export const ProcessStageSchema = z.strictObject({
  stage: z.number().int().min(1).max(INVESTMENT_NARRATIVE_BOUNDS.process.max),
  action: text(160),
  timing: text(40).describe('"Month 1", "Months 3–6", "Quarterly", "Annually".'),
});

export const CommitteePrioritySchema = z.strictObject({
  title: text(60).describe('Two to four words, e.g. "Protect growth"; no "Priority 1 —" (APX adds it).'),
  text: text(300),
});

export const InvestmentReferenceSchema = z.strictObject({
  label: text(120),
  url: Link.describe('One of the playbook\'s reference links exactly as listed.'),
});

const B = INVESTMENT_NARRATIVE_BOUNDS;

export const InvestmentNarrativeSchema = z.strictObject({
  objective: text(500),
  growthToSurplus: text(1200),
  reinvestment: text(1200),
  levers: z.array(InvestmentLeverSchema).min(B.levers.min).max(B.levers.max),
  externalIntro: text(800),
  options: z.array(InvestmentOptionSchema).min(B.options.min).max(B.options.max)
    .describe('Ordered from lower to higher risk.'),
  portfolio: z.array(PortfolioShareSchema).min(B.portfolio.min).max(B.portfolio.max)
    .describe('Whole percentages adding up to exactly 100; high and very_high together at most 10.'),
  portfolioNote: text(400),
  comparison: text(1200),
  process: z.array(ProcessStageSchema).min(B.process.min).max(B.process.max),
  governance: z.array(text(200)).min(B.governance.min).max(B.governance.max),
  recommendation: z.array(CommitteePrioritySchema).length(B.recommendation),
  references: z.array(InvestmentReferenceSchema).min(B.references.min).max(B.references.max),
});

/*
 * The schema IS the contract's shape: the parsed type equals `InvestmentNarrative` with its
 * `readonly`s removed, and the risk levels are exactly `RiskLevel`. A field added to or removed from
 * either side fails the type-check here.
 */
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesContract: Same<z.infer<typeof InvestmentNarrativeSchema>, Mutable<InvestmentNarrative>> = true;
const riskLevelsMatchContract: Same<(typeof RISK_LEVELS)[number], RiskLevel> = true;
void schemaMatchesContract;
void riskLevelsMatchContract;

/* ------------------------------------------------------------------------------------------------ */
/* The tool's JSON schema                                                                           */
/* ------------------------------------------------------------------------------------------------ */

/** The schema as the tool's `input_schema`, without the `$schema` draft marker (as Marketing's). */
export function investmentNarrativeJsonSchema(): Record<string, unknown> {
  const { $schema: _draft, ...schema } = z.toJSONSchema(InvestmentNarrativeSchema, { unrepresentable: 'any' }) as Record<string, unknown>;
  return schema;
}

/* ------------------------------------------------------------------------------------------------ */
/* How the pack writes numbers and links                                                            */
/* ------------------------------------------------------------------------------------------------ */

/*
 * Small helpers that Marketing has too (`marketing/domain/prompt.ts`, `narrative-schema.ts`,
 * `render/format.ts`) but does not export through its barrel, and the module rule (ADR-022,
 * `motion/no-deep-module-import`) forbids reaching inside it. They live here rather than in
 * `prompt.ts`, which imports this file, so the two never import each other. Same behaviour as
 * Marketing's, so a figure reads the same in both departments.
 */

/** "GBP" → "£", "INR" → "₹", "AED" → "AED"; an unknown code stays as it is. */
export function currencySymbol(currency: string): string {
  try {
    const parts = new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

/** Money as the pack shows it: whole units with the currency symbol ("£2,073,600"); the code before it if Intl does not know the currency. */
export function packMoney(value: string, currency: string): string {
  if (tryParseDecimal(value) === null) return value;
  try {
    return formatMoney(value, { currency });
  } catch {
    return `${currency} ${value}`;
  }
}

/** A percent figure as the pack shows it (Marketing's `formatShare`): "45%" from "45", "15%" from "15.0", "14.6%" from "14.6". */
export function packPercent(value: string): string {
  const parsed = tryParseDecimal(value.replace(/%$/, ''));
  return parsed === null ? value : `${parsed.toDecimalPlaces(1).toFixed()}%`;
}

/** "dmo.gov.uk/gilts" → "https://dmo.gov.uk/gilts"; anything else is left as it is; blank is null. */
export function tidyLink(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/** True for an absolute http(s) URL with a dotted host. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Tidy-ups                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export interface InvestmentNarrativeContext {
  /** APX's figures: the only numbers the words may state. */
  readonly figures: InvestmentFigures;
  /** The company's country playbook: the only pages the words may cite. */
  readonly playbook: InvestmentPlaybook;
}

const key = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

/** The same page written two ways is one page: scheme, `www.`, trailing slash and host case aside. */
export function linkKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function playbookUrl(playbook: InvestmentPlaybook, url: string): PlaybookLink | undefined {
  const k = linkKey(url);
  return playbook.links.find((l) => linkKey(l.url) === k);
}

/** A link tidied (bare domain → https) and, when it is a playbook page, spelt as the playbook spells it. */
function tidyPlaybookLink(playbook: InvestmentPlaybook, value: string | null): string | null {
  const tidied = tidyLink(value);
  if (tidied === null) return null;
  return playbookUrl(playbook, tidied)?.url ?? tidied;
}

/** The deterministic tidy-ups (see the module note). Pure: returns a new narrative. */
export function tidyInvestmentNarrative(narrative: InvestmentNarrative, playbook: InvestmentPlaybook): InvestmentNarrative {
  const seen = new Set<string>();
  const references = narrative.references
    .map((r) => ({ label: r.label, url: tidyPlaybookLink(playbook, r.url) ?? r.url }))
    .filter((r) => {
      const k = linkKey(r.url);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return {
    ...narrative,
    options: narrative.options.map((o) => ({ ...o, referenceUrl: tidyPlaybookLink(playbook, o.referenceUrl) })),
    references,
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* Numbers in the words                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/** A number written in the text: what it says, its value, and how far a rounded restatement may be off. */
export interface NumberMention {
  readonly text: string;
  readonly value: Decimal;
  /** Half the place of its last significant digit: "£311,000" → 500; "£11,585.00" → 0.005; "15%" → 0.5. */
  readonly tolerance: Decimal;
  readonly kind: 'money' | 'percent';
}

const SCALES: Readonly<Record<string, number>> = {
  k: 1e3, thousand: 1e3, lakh: 1e5, m: 1e6, million: 1e6, crore: 1e7, bn: 1e9, billion: 1e9,
};
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const SCALE = String.raw`(?:\s?(bn|billion|million|thousand|lakh|crore|m|k)\b)?`;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The place of the last significant digit of a written number ("311,000" → 1000; "2.07" → 0.01; "1" → 1). */
function placeOf(digits: string): Decimal {
  const plain = digits.replace(/,/g, '');
  const dot = plain.indexOf('.');
  if (dot >= 0) return new Decimal(10).pow(-(plain.length - dot - 1));
  const zeros = plain.length - plain.replace(/0+$/, '').length;
  return new Decimal(10).pow(plain === '0' ? 0 : zeros);
}

function mention(whole: string, digits: string, scale: string | undefined, money: boolean): NumberMention {
  const factor = new Decimal(scale ? SCALES[scale.toLowerCase()] ?? 1 : 1);
  const value = new Decimal(digits.replace(/,/g, '')).times(factor);
  // A percentage's precision is its decimals only: "20%" is 20 ± 0.5, not "20 to the nearest ten".
  const place = money ? placeOf(digits).times(factor) : (digits.includes('.') ? placeOf(digits) : new Decimal(1));
  return { text: whole.trim(), value, tolerance: place.dividedBy(2), kind: money ? 'money' : 'percent' };
}

/**
 * The amounts of money in a text: the currency's symbol or code, then digits ("£35,000", "£1m",
 * "£2.07 million", "AED 35,000", "₹10 lakh"), or digits then the code ("35,000 AED"). The sign is
 * ignored (amounts are compared as magnitudes).
 */
export function moneyMentions(text: string, currency: string): NumberMention[] {
  const markers = [...new Set([currencySymbol(currency), currency].filter((m) => m.trim().length > 0))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (markers.length === 0) return [];
  const before = new RegExp(`(?:${markers.join('|')})\\s?(${NUMBER})${SCALE}`, 'gi');
  const code = /^[A-Z]{3}$/i.test(currency) ? new RegExp(`(?<![\\d.,])(${NUMBER})${SCALE}\\s?${escapeRegExp(currency)}\\b`, 'gi') : null;
  const found: Array<{ at: number; m: NumberMention }> = [];
  for (const m of text.matchAll(before)) found.push({ at: m.index ?? 0, m: mention(m[0], m[1]!, m[2], true) });
  if (code) {
    for (const m of text.matchAll(code)) {
      // "AED 35,000 AED" is one amount, not two.
      if (!found.some((f) => Math.abs(f.at - (m.index ?? 0)) < m[0].length + 6)) found.push({ at: m.index ?? 0, m: mention(m[0], m[1]!, m[2], true) });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.m);
}

const PERCENT = new RegExp(String.raw`(?<![\d.,])(\d+(?:\.\d+)?)(?:\s?(?:–|—|-|to)\s?(\d+(?:\.\d+)?))?\s?(?:%|per\s?cent\b)`, 'gi');

/** The percentages in a text: "10%", "15.0%", "20 per cent", and both ends of "20–50%" or "35 to 50%". */
export function percentMentions(text: string): NumberMention[] {
  const out: NumberMention[] = [];
  for (const m of text.matchAll(PERCENT)) {
    out.push(mention(`${m[1]}%`, m[1]!, undefined, false));
    if (m[2] !== undefined) out.push(mention(`${m[2]}%`, m[2], undefined, false));
  }
  return out;
}

/** How far a rounded amount may stray from the figure it restates, as a share of the figure. */
const MONEY_ROUNDING_LIMIT = new Decimal('0.01');

/**
 * A mention restates a figure when it is the figure rounded to the mention's own precision — and, for
 * money, within 1% of it. Percentages are small whole numbers, so their own precision is the test.
 */
export function restates(m: NumberMention, figure: Decimal): boolean {
  const diff = m.value.minus(figure.abs()).abs();
  if (!diff.lessThanOrEqualTo(m.tolerance)) return false;
  return m.kind === 'percent' || diff.lessThanOrEqualTo(figure.abs().times(MONEY_ROUNDING_LIMIT));
}

const dec = (value: string | null | undefined): Decimal[] => {
  const d = value === null || value === undefined ? null : tryParseDecimal(value);
  return d === null ? [] : [d];
};

/** Every amount in APX's figures (and the narrative's portfolio applied to the external allocation). */
export function allowedAmounts(figures: InvestmentFigures, portfolioPercents: readonly string[] = []): Decimal[] {
  const { base, assumptions, allocation, baseCase, growthScenarios, returnScenarios, comparison } = figures;
  const years = [baseCase, ...growthScenarios].flatMap((s) => s.years.flatMap((y) => [...dec(y.revenue), ...dec(y.netProfit)]));
  const returns = returnScenarios.flatMap((r) => [...dec(r.startAmount), ...r.values.flatMap((v) => dec(v)), ...dec(r.finalValue), ...dec(r.gain)]);
  const external = tryParseDecimal(allocation.external.amount);
  const portfolio = external === null
    ? []
    : portfolioPercents.flatMap((p) => dec(p)).map((p) => external.times(p).dividedBy(100));
  return [
    ...dec(base.revenue), ...dec(base.netProfit), ...dec(assumptions.surplus),
    ...dec(allocation.business.amount), ...dec(allocation.external.amount), ...dec(allocation.liquidity.amount),
    ...years, ...returns,
    ...dec(comparison.amount), ...dec(comparison.value), ...dec(comparison.gain), ...dec(comparison.salesNeededForSameGain),
    ...portfolio,
  ];
}

/** Every percentage in APX's figures, the narrative's portfolio shares, the high-risk limit and 100. */
export function allowedPercents(figures: InvestmentFigures, portfolioPercents: readonly string[] = []): Decimal[] {
  const { base, assumptions, allocation, baseCase, growthScenarios, returnScenarios, comparison } = figures;
  return [
    ...dec(base.netMarginPct),
    ...assumptions.growthRates.flatMap((g) => dec(g)), ...dec(assumptions.targetReturnPct),
    ...dec(assumptions.split.business), ...dec(assumptions.split.external), ...dec(assumptions.split.liquidity),
    ...assumptions.returnRates.flatMap((r) => dec(r)),
    ...dec(allocation.business.percent), ...dec(allocation.external.percent), ...dec(allocation.liquidity.percent),
    ...[baseCase, ...growthScenarios].flatMap((s) => dec(s.growthPct)),
    ...returnScenarios.flatMap((r) => dec(r.ratePct)),
    ...dec(comparison.ratePct),
    ...portfolioPercents.flatMap((p) => dec(p)),
    new Decimal(HIGH_RISK_CAP_PCT), new Decimal(100),
  ];
}

/** Every field of prose, with its path: what the figures and named-product checks read. References are not prose. */
export function proseFields(n: InvestmentNarrative): Array<readonly [string, string]> {
  return [
    ['objective', n.objective],
    ['growthToSurplus', n.growthToSurplus],
    ['reinvestment', n.reinvestment],
    ...n.levers.flatMap((l, i) => [[`levers.${i}.lever`, l.lever], [`levers.${i}.action`, l.action], [`levers.${i}.measure`, l.measure]] as const),
    ['externalIntro', n.externalIntro],
    ...n.options.flatMap((o, i) => [[`options.${i}.name`, o.name], [`options.${i}.description`, o.description]] as const),
    ...n.portfolio.map((p, i) => [`portfolio.${i}.assetClass`, p.assetClass] as const),
    ['portfolioNote', n.portfolioNote],
    ['comparison', n.comparison],
    ...n.process.flatMap((s, i) => [[`process.${i}.action`, s.action], [`process.${i}.timing`, s.timing]] as const),
    ...n.governance.map((g, i) => [`governance.${i}`, g] as const),
    ...n.recommendation.flatMap((r, i) => [[`recommendation.${i}.title`, r.title], [`recommendation.${i}.text`, r.text]] as const),
  ];
}

/* ------------------------------------------------------------------------------------------------ */
/* Semantic checks                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

const NAMED_PRODUCTS = NAMED_PRODUCT_WORDS.map((word) => ({
  word,
  pattern: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(word)}(?![A-Za-z0-9])`, 'i'),
}));

/** Whole percentages that each lie in 1–100 and add up to exactly 100. Integer arithmetic only. */
function splitProblems(label: string, percents: readonly string[]): string[] {
  const problems: string[] = [];
  const values = percents.map((p) => Number.parseInt(p, 10));
  if (values.some((v) => !Number.isInteger(v) || v < 1 || v > 100)) problems.push(`${label}: every share must be a whole number from 1 to 100`);
  const total = values.reduce((a, b) => a + (Number.isInteger(b) ? b : 0), 0);
  if (total !== 100) problems.push(`${label}: the percentages add up to ${total}, not 100`);
  return problems;
}

function linkProblem(path: string, url: string, playbook: InvestmentPlaybook): string | null {
  if (!isHttpUrl(url)) return `${path}: must be a full http(s) address from the playbook's reference links`;
  if (playbookUrl(playbook, url) === undefined) {
    return `${path}: "${url}" is not one of the playbook's reference links; use one of those addresses exactly as listed${path.startsWith('options') ? ', or null' : ''}`;
  }
  return null;
}

const FIGURES_RULE = 'restate amounts and percentages exactly as they appear in <figures> (or the portfolio shares and the 10% high-risk limit), or make the point in words without a number';

/**
 * The checks a schema cannot express. Returns the problems, worded for the model to fix (they are
 * sent back verbatim in the one repair attempt); empty when the narrative is sound.
 */
export function investmentNarrativeProblems(narrative: InvestmentNarrative, context: InvestmentNarrativeContext): string[] {
  const problems: string[] = [];
  const { figures, playbook } = context;
  const { options, portfolio } = narrative;

  // 03: the options, lower to higher risk; crypto only ever very high.
  for (let i = 1; i < options.length; i += 1) {
    const before = options[i - 1]!;
    const here = options[i]!;
    if (riskRank(here.risk) < riskRank(before.risk)) {
      problems.push(`options: order the options from lower to higher risk (option ${i + 1}, "${here.name}", is ${here.risk} after ${before.risk})`);
    }
  }
  const optionKeys = options.map((o) => key(o.name));
  if (new Set(optionKeys).size !== optionKeys.length) problems.push('options: each option may appear once');
  options.forEach((o, i) => {
    if (CRYPTO_PATTERN.test(`${o.name} ${o.description}`) && o.risk !== 'very_high') problems.push(`options.${i}.risk: a crypto option is always very_high`);
    if (o.referenceUrl !== null) {
      const problem = linkProblem(`options.${i}.referenceUrl`, o.referenceUrl, playbook);
      if (problem) problems.push(problem);
    }
  });

  // 03: the portfolio — adds to 100, each class once, the 10% high-risk limit.
  problems.push(...splitProblems('portfolio', portfolio.map((p) => p.percent)));
  const classKeys = portfolio.map((p) => key(p.assetClass));
  if (new Set(classKeys).size !== classKeys.length) problems.push('portfolio: each asset class may appear once');
  const highRisk = portfolio.filter((p) => HIGH_RISK_LEVELS.has(p.risk)).reduce((a, p) => a + (Number.parseInt(p.percent, 10) || 0), 0);
  if (highRisk > HIGH_RISK_CAP_PCT) {
    problems.push(`portfolio: high and very_high risk together come to ${highRisk}%; they may be at most ${HIGH_RISK_CAP_PCT}% of the external allocation`);
  }
  portfolio.forEach((p, i) => {
    if (CRYPTO_PATTERN.test(p.assetClass) && p.risk !== 'very_high') problems.push(`portfolio.${i}.risk: a crypto holding is always very_high`);
  });

  // 02 and the process: names once, stages numbered in order.
  const leverKeys = narrative.levers.map((l) => key(l.lever));
  if (new Set(leverKeys).size !== leverKeys.length) problems.push('levers: each lever may appear once');
  narrative.process.forEach((s, i) => {
    if (s.stage !== i + 1) problems.push(`process: number the stages 1 to ${narrative.process.length} in order (entry ${i + 1} is numbered ${s.stage})`);
  });

  // References: playbook pages only, and at least one regulator.
  narrative.references.forEach((r, i) => {
    const problem = linkProblem(`references.${i}.url`, r.url, playbook);
    if (problem) problems.push(problem);
  });
  if (!narrative.references.some((r) => playbookUrl(playbook, r.url)?.kind === 'regulator')) {
    problems.push('references: include at least one regulator\'s page from the playbook');
  }
  if (narrative.references.length < INVESTMENT_NARRATIVE_BOUNDS.references.min) {
    problems.push(`references: give at least ${INVESTMENT_NARRATIVE_BOUNDS.references.min} different reference links`);
  }

  // No named product, and no number that is not APX's.
  const currency = figures.base.currency;
  const percents = portfolio.map((p) => p.percent);
  const amounts = allowedAmounts(figures, percents);
  const percentages = allowedPercents(figures, percents);
  for (const [path, value] of proseFields(narrative)) {
    const named = NAMED_PRODUCTS.find((p) => p.pattern.test(value));
    if (named) problems.push(`${path}: names "${named.word}"; name the asset class or route, never a provider, fund, platform or coin (the reference links point to providers)`);
    for (const m of moneyMentions(value, currency)) {
      if (!amounts.some((a) => restates(m, a))) problems.push(`${path}: "${m.text}" is not one of APX's figures; ${FIGURES_RULE}`);
    }
    for (const m of percentMentions(value)) {
      if (!percentages.some((p) => restates(m, p))) problems.push(`${path}: "${m.text}" is not one of APX's figures; ${FIGURES_RULE}`);
    }
  }

  // The comparison states its two figures.
  const said = moneyMentions(narrative.comparison, currency);
  const mustState: Array<[string, string | null]> = [
    ['the gain', figures.comparison.gain],
    ['the sales the business would need for the same gain', figures.comparison.salesNeededForSameGain],
  ];
  for (const [what, value] of mustState) {
    const figure = value === null ? null : tryParseDecimal(value);
    if (figure === null) continue;
    if (!said.some((m) => restates(m, figure))) problems.push(`comparison: state ${what}, ${packMoney(value!, currency)}, exactly as given in <figures>`);
  }
  return problems;
}

export type InvestmentNarrativeCheck =
  | { readonly ok: true; readonly narrative: InvestmentNarrative }
  | { readonly ok: false; readonly problems: readonly string[] };

/** At most this many problems are reported (and sent back): enough to fix, not a wall of text. */
const MAX_PROBLEMS = 15;

/** The model's tool input → a sound narrative, or the problems with it. Never throws. */
export function checkInvestmentNarrative(input: unknown, context: InvestmentNarrativeContext): InvestmentNarrativeCheck {
  const parsed = InvestmentNarrativeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, MAX_PROBLEMS).map((i) => `${i.path.join('.') || 'pack'}: ${i.message}`),
    };
  }
  const narrative = tidyInvestmentNarrative(parsed.data, context.playbook);
  const problems = investmentNarrativeProblems(narrative, context);
  return problems.length === 0 ? { ok: true, narrative } : { ok: false, problems: problems.slice(0, MAX_PROBLEMS) };
}
