import { z } from 'zod';
import type { MarketingFinancials, MarketingNarrative } from './types';

/**
 * The Marketing report's AI contract (ADR-170): the zod schema the model's `submit_marketing_report`
 * input must fit, and the checks a schema cannot express.
 *
 * The same discipline as statement and receipt extraction (ADR-033, ADR-150): the model answers
 * through ONE forced tool whose schema is this file, and anything that does not fit is a failure —
 * repaired once with the problems sent back, then refused — never a guess. The schema is the shape
 * of `MarketingNarrative` in `types.ts` exactly (a compile-time check below keeps them in step); the
 * bounds are the client's example document's (four competitors, six sectors, four concepts, three
 * ninety-day periods, five priorities) with room either side.
 *
 * Kept to what OpenAI function calling carries (ADR-164's translation passes `input_schema` through
 * as the function's `parameters`, non-strict): objects with every key required and no extra keys,
 * arrays with `minItems`/`maxItems`, strings with `maxLength`/`pattern`, integers with bounds, and a
 * nullable value as `anyOf [T, null]`. No `$ref`, no `oneOf`/`allOf`, no conditional schemas and no
 * transforms — a shape OpenAI cannot carry would be sent as something looser and only fail here.
 * Every field is REQUIRED (nullable where the contract allows null) rather than optional, so the
 * same schema also satisfies OpenAI's strict mode should the translation ever turn it on.
 *
 * Semantic checks (after parsing): the effort and budget splits are whole percentages adding to
 * 100; every effort share names one of the customer sectors; competitor links are http(s) or null;
 * the priorities are numbered 1…n; and Section 03's commentary exists exactly when there are figures,
 * with one commercial action per cost line, in order. Two deterministic tidy-ups run first, because
 * a repair costs a second model call: a bare domain ("cambridgesatchel.com", as in the client's own
 * example) gains `https://`, and an effort share whose sector differs from a customer sector only by
 * case or spacing takes the sector's own spelling.
 */

/* ------------------------------------------------------------------------------------------------ */
/* Bounds                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export const NARRATIVE_BOUNDS = {
  competitors: { min: 3, max: 6 },
  customerSectors: { min: 3, max: 7 },
  effortSplit: { min: 2, max: 7 },
  bullets: { min: 3, max: 7 },
  productCampaigns: { min: 2, max: 7 },
  concepts: { min: 3, max: 4 },
  budget: { min: 3, max: 8 },
  first90Days: 3,
  priorities: { min: 3, max: 6 },
  costActions: { max: 12 },
} as const;

/** A non-blank line of prose, at most `max` characters. */
const text = (max: number) => z.string().min(1).max(max).refine((s) => s.trim().length > 0, 'must not be blank');
/** Whole percent as a string ("35"), as `SectorShare.percent` and `BudgetLine.percent` are. */
const WholePercent = z.string().regex(/^\d{1,3}$/, 'a whole number of percent, digits only (no % sign)');
/** A link, checked as http(s) after parsing (so a bare domain can be tidied rather than refused). */
const Link = z.string().min(1).max(300).nullable();

export const CompetitorSchema = z.strictObject({
  name: text(80),
  positioning: text(120).describe('Short label, e.g. "direct heritage competitor".'),
  learning: text(400).describe('What the company can learn from them.'),
  website: Link.describe('The brand\'s own homepage as a full https:// URL, or null when not certain.'),
  social: Link.describe('The brand\'s main social profile as a full https:// URL, or null when not certain.'),
});

export const CustomerSectorSchema = z.strictObject({
  sector: text(80),
  profile: text(300).describe('Profile and purchase trigger.'),
  campaignDirection: text(300),
});

export const SectorShareSchema = z.strictObject({
  sector: text(80).describe('Exactly the name of one of customerSectors.'),
  percent: WholePercent,
});

export const CompetitorSectionSchema = z.strictObject({
  brandPositioning: text(1500),
  competitors: z.array(CompetitorSchema).min(NARRATIVE_BOUNDS.competitors.min).max(NARRATIVE_BOUNDS.competitors.max),
  competitorNote: text(500),
  customerSectors: z.array(CustomerSectorSchema).min(NARRATIVE_BOUNDS.customerSectors.min).max(NARRATIVE_BOUNDS.customerSectors.max),
  effortSplit: z.array(SectorShareSchema).min(NARRATIVE_BOUNDS.effortSplit.min).max(NARRATIVE_BOUNDS.effortSplit.max)
    .describe('Whole percentages adding up to exactly 100.'),
  effortNote: text(500).nullable(),
});

const Bullets = z.array(text(300)).min(NARRATIVE_BOUNDS.bullets.min).max(NARRATIVE_BOUNDS.bullets.max);

export const ProductCampaignSchema = z.strictObject({
  product: text(80),
  positioning: text(200),
  execution: text(300),
});

export const CampaignConceptSchema = z.strictObject({
  title: text(80),
  description: text(500),
  purpose: text(200),
});

export const BudgetLineSchema = z.strictObject({
  channel: text(80),
  percent: WholePercent,
  purpose: text(200),
});

export const PlanPeriodSchema = z.strictObject({
  period: text(40),
  activities: text(400),
  deliverable: text(300),
});

export const PrioritySchema = z.strictObject({
  priority: z.number().int().min(1).max(NARRATIVE_BOUNDS.priorities.max),
  action: text(200),
  kpi: text(200),
});

export const StrategySectionSchema = z.strictObject({
  digitalAcquisition: Bullets,
  productCampaigns: z.array(ProductCampaignSchema).min(NARRATIVE_BOUNDS.productCampaigns.min).max(NARRATIVE_BOUNDS.productCampaigns.max),
  retention: Bullets,
  concepts: z.array(CampaignConceptSchema).min(NARRATIVE_BOUNDS.concepts.min).max(NARRATIVE_BOUNDS.concepts.max),
  recommendedCombination: text(600),
  budget: z.array(BudgetLineSchema).min(NARRATIVE_BOUNDS.budget.min).max(NARRATIVE_BOUNDS.budget.max)
    .describe('Whole percentages adding up to exactly 100.'),
  budgetNote: text(600),
  first90Days: z.array(PlanPeriodSchema).length(NARRATIVE_BOUNDS.first90Days),
  priorities: z.array(PrioritySchema).min(NARRATIVE_BOUNDS.priorities.min).max(NARRATIVE_BOUNDS.priorities.max),
});

export const FinancialCommentarySchema = z.strictObject({
  performance: text(1500),
  productSales: text(1200).nullable(),
  marketingEfficiency: text(1200),
  costActions: z.array(text(300)).max(NARRATIVE_BOUNDS.costActions.max)
    .describe('One commercial action per cost line, in the same order.'),
  actionPlan: Bullets,
  conclusion: text(1200),
});

export const MarketingNarrativeSchema = z.strictObject({
  objective: text(1200),
  overview: text(800),
  competitors: CompetitorSectionSchema,
  strategy: StrategySectionSchema,
  financialCommentary: FinancialCommentarySchema.nullable()
    .describe('Null exactly when no figures were supplied.'),
});

/*
 * The schema IS the contract's shape: the parsed type equals `MarketingNarrative` with its
 * `readonly`s removed. A field added to or removed from either side fails the type-check here.
 */
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesContract: Same<z.infer<typeof MarketingNarrativeSchema>, Mutable<MarketingNarrative>> = true;
void schemaMatchesContract;

/* ------------------------------------------------------------------------------------------------ */
/* The tool's JSON schema                                                                           */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The schema as the tool's `input_schema`. The `$schema` draft marker is dropped: it is not part of
 * a function's parameters and carries nothing a provider reads.
 */
export function narrativeJsonSchema(): Record<string, unknown> {
  const { $schema: _draft, ...schema } = z.toJSONSchema(MarketingNarrativeSchema, { unrepresentable: 'any' }) as Record<string, unknown>;
  return schema;
}

/* ------------------------------------------------------------------------------------------------ */
/* Tidy-ups and semantic checks                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export interface NarrativeContext {
  /** The figures Section 03 will show; null when the company has none. */
  readonly financials: MarketingFinancials | null;
}

const key = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

/** "cambridgesatchel.com/shop" → "https://cambridgesatchel.com/shop"; anything else is left as it is. */
export function tidyLink(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/** True for an absolute http(s) URL with a host. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/** The deterministic tidy-ups (see the module note). Pure: returns a new narrative. */
export function tidyNarrative(narrative: MarketingNarrative): MarketingNarrative {
  const sectorNames = new Map(narrative.competitors.customerSectors.map((s) => [key(s.sector), s.sector]));
  return {
    ...narrative,
    competitors: {
      ...narrative.competitors,
      competitors: narrative.competitors.competitors.map((c) => ({ ...c, website: tidyLink(c.website), social: tidyLink(c.social) })),
      effortSplit: narrative.competitors.effortSplit.map((s) => ({ ...s, sector: sectorNames.get(key(s.sector)) ?? s.sector })),
    },
  };
}

/** Whole percentages that each lie in 1–100 and add up to exactly 100. Integer arithmetic only. */
function splitProblems(label: string, percents: readonly string[]): string[] {
  const problems: string[] = [];
  const values = percents.map((p) => Number.parseInt(p, 10));
  if (values.some((v) => !Number.isInteger(v) || v < 1 || v > 100)) problems.push(`${label}: every share must be a whole number from 1 to 100`);
  const total = values.reduce((a, b) => a + (Number.isInteger(b) ? b : 0), 0);
  if (total !== 100) problems.push(`${label}: the percentages add up to ${total}, not 100`);
  return problems;
}

/**
 * The checks a schema cannot express. Returns the problems, worded for the model to fix (they are
 * sent back verbatim in the one repair attempt); empty when the narrative is sound.
 */
export function narrativeProblems(narrative: MarketingNarrative, context: NarrativeContext): string[] {
  const problems: string[] = [];
  const { competitors: section, strategy, financialCommentary: commentary } = narrative;

  // Section 01: sectors and the effort split.
  const sectorKeys = section.customerSectors.map((s) => key(s.sector));
  if (new Set(sectorKeys).size !== sectorKeys.length) problems.push('competitors.customerSectors: each sector must be named once');
  problems.push(...splitProblems('competitors.effortSplit', section.effortSplit.map((s) => s.percent)));
  const shareKeys = section.effortSplit.map((s) => key(s.sector));
  if (new Set(shareKeys).size !== shareKeys.length) problems.push('competitors.effortSplit: each sector may appear once');
  for (const share of section.effortSplit) {
    if (!sectorKeys.includes(key(share.sector))) {
      problems.push(`competitors.effortSplit: "${share.sector}" is not one of the customerSectors; use a sector name exactly as listed there`);
    }
  }

  // Section 01: competitor links.
  section.competitors.forEach((c, i) => {
    if (c.website !== null && !isHttpUrl(c.website)) problems.push(`competitors.competitors.${i}.website: must be a full http(s) URL, or null`);
    if (c.social !== null && !isHttpUrl(c.social)) problems.push(`competitors.competitors.${i}.social: must be a full http(s) URL, or null`);
  });

  // Section 02: the budget split and the priorities' numbering.
  problems.push(...splitProblems('strategy.budget', strategy.budget.map((b) => b.percent)));
  const channelKeys = strategy.budget.map((b) => key(b.channel));
  if (new Set(channelKeys).size !== channelKeys.length) problems.push('strategy.budget: each channel may appear once');
  strategy.priorities.forEach((p, i) => {
    if (p.priority !== i + 1) problems.push(`strategy.priorities: number the priorities 1 to ${strategy.priorities.length} in order (entry ${i + 1} is numbered ${p.priority})`);
  });

  // Section 03: commentary exactly when there are figures, one action per cost line.
  const { financials } = context;
  if (financials === null && commentary !== null) {
    problems.push('financialCommentary: must be null, because no figures were supplied');
  } else if (financials !== null && commentary === null) {
    problems.push('financialCommentary: is required, because figures were supplied');
  } else if (financials !== null && commentary !== null) {
    if (commentary.costActions.length !== financials.costLines.length) {
      problems.push(`financialCommentary.costActions: give exactly ${financials.costLines.length} action${financials.costLines.length === 1 ? '' : 's'}, one per cost line in the order given (got ${commentary.costActions.length})`);
    }
    if (financials.productSales === null && commentary.productSales !== null) {
      problems.push('financialCommentary.productSales: must be null, because no product-sector sales were supplied');
    }
  }
  return problems;
}

export type NarrativeCheck =
  | { readonly ok: true; readonly narrative: MarketingNarrative }
  | { readonly ok: false; readonly problems: readonly string[] };

/** At most this many problems are reported (and sent back): enough to fix, not a wall of text. */
const MAX_PROBLEMS = 15;

/** The model's tool input → a sound narrative, or the problems with it. Never throws. */
export function checkNarrative(input: unknown, context: NarrativeContext): NarrativeCheck {
  const parsed = MarketingNarrativeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, MAX_PROBLEMS).map((i) => `${i.path.join('.') || 'report'}: ${i.message}`),
    };
  }
  const narrative = tidyNarrative(parsed.data);
  const problems = narrativeProblems(narrative, context);
  return problems.length === 0 ? { ok: true, narrative } : { ok: false, problems: problems.slice(0, MAX_PROBLEMS) };
}
