import { describe, expect, it } from 'vitest';
import type { MarketingFinancials, MarketingNarrative } from '@/modules/marketing';
import { BEARA_FINANCIALS, validNarrative } from '../fixtures/marketing-narrative';

const {
  MarketingNarrativeSchema, checkNarrative, isHttpUrl, narrativeJsonSchema, tidyLink,
} = await import('@/modules/marketing/domain/narrative-schema');

/**
 * ADR-170: the Marketing narrative is either the contract's exact shape with sound splits, links,
 * numbering and Section 03 alignment, or a list of problems the model can fix — never a guess.
 */

type Draft = { -readonly [K in keyof MarketingNarrative]: MarketingNarrative[K] };
const withFigures: { financials: MarketingFinancials | null } = { financials: BEARA_FINANCIALS };
const noFigures: { financials: MarketingFinancials | null } = { financials: null };

/** A deep copy to break. */
const draft = (): Draft => structuredClone(validNarrative()) as Draft;

function problemsOf(input: unknown, context = withFigures): readonly string[] {
  const result = checkNarrative(input, context);
  return result.ok ? [] : result.problems;
}

describe('the schema', () => {
  it('accepts the client example and keeps it as written', () => {
    const result = checkNarrative(validNarrative(), withFigures);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.narrative).toEqual(validNarrative());
  });

  it('refuses a missing field, an extra field, a blank string and an over-long one', () => {
    const missing = draft() as Record<string, unknown>;
    delete missing.overview;
    expect(problemsOf(missing).join()).toMatch(/overview/);
    expect(problemsOf({ ...draft(), extra: 'x' }).join()).toMatch(/extra|Unrecognized/i);
    expect(problemsOf({ ...draft(), objective: '   ' }).join()).toMatch(/objective: must not be blank/);
    expect(problemsOf({ ...draft(), overview: 'x'.repeat(801) }).join()).toMatch(/overview/);
  });

  it('holds the counts: 3–6 competitors, 3–7 sectors, 3–4 concepts, exactly three periods, 3–6 priorities, 3–7 bullets', () => {
    const n = draft();
    expect(problemsOf({ ...n, competitors: { ...n.competitors, competitors: n.competitors.competitors.slice(0, 2) } }).join()).toMatch(/competitors\.competitors/);
    expect(problemsOf({ ...n, strategy: { ...n.strategy, first90Days: n.strategy.first90Days.slice(0, 2) } }).join()).toMatch(/first90Days/);
    expect(problemsOf({ ...n, strategy: { ...n.strategy, concepts: [...n.strategy.concepts, ...n.strategy.concepts] } }).join()).toMatch(/concepts/);
    expect(problemsOf({ ...n, strategy: { ...n.strategy, retention: ['One.', 'Two.'] } }).join()).toMatch(/retention/);
    expect(problemsOf({ ...n, strategy: { ...n.strategy, priorities: n.strategy.priorities.slice(0, 2) } }).join()).toMatch(/priorities/);
  });

  it('wants percentages as whole-number strings, without a % sign', () => {
    const n = draft();
    const split = n.competitors.effortSplit.map((s, i) => (i === 0 ? { ...s, percent: '50%' } : s));
    expect(problemsOf({ ...n, competitors: { ...n.competitors, effortSplit: split } }).join()).toMatch(/whole number of percent/);
    const decimal = n.strategy.budget.map((b, i) => (i === 0 ? { ...b, percent: '40.5' } : b));
    expect(problemsOf({ ...n, strategy: { ...n.strategy, budget: decimal } }).join()).toMatch(/budget/);
  });
});

describe('the semantic checks', () => {
  it('needs the effort split and the budget to add up to exactly 100', () => {
    const n = draft();
    const split = n.competitors.effortSplit.map((s, i) => (i === 0 ? { ...s, percent: '45' } : s));
    expect(problemsOf({ ...n, competitors: { ...n.competitors, effortSplit: split } })).toContain('competitors.effortSplit: the percentages add up to 95, not 100');
    const budget = n.strategy.budget.map((b, i) => (i === 0 ? { ...b, percent: '50' } : b));
    expect(problemsOf({ ...n, strategy: { ...n.strategy, budget } })).toContain('strategy.budget: the percentages add up to 110, not 100');
    const zero = n.strategy.budget.map((b, i) => (i === 0 ? { ...b, percent: '0' } : i === 1 ? { ...b, percent: '75' } : b));
    expect(problemsOf({ ...n, strategy: { ...n.strategy, budget: zero } }).join()).toMatch(/from 1 to 100/);
  });

  it('needs every effort share to name a customer sector, once; case and spacing are tidied, not refused', () => {
    const n = draft();
    const unknown = n.competitors.effortSplit.map((s, i) => (i === 0 ? { ...s, sector: 'Students' } : s));
    expect(problemsOf({ ...n, competitors: { ...n.competitors, effortSplit: unknown } }).join()).toMatch(/"Students" is not one of the customerSectors/);
    const twice = n.competitors.effortSplit.map((s, i) => (i === 1 ? { ...s, sector: 'Premium everyday fashion' } : s));
    expect(problemsOf({ ...n, competitors: { ...n.competitors, effortSplit: twice } }).join()).toMatch(/each sector may appear once/);

    const loose = n.competitors.effortSplit.map((s, i) => (i === 0 ? { ...s, sector: '  premium  EVERYDAY fashion ' } : s));
    const result = checkNarrative({ ...n, competitors: { ...n.competitors, effortSplit: loose } }, withFigures);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.narrative.competitors.effortSplit[0]!.sector).toBe('Premium everyday fashion');
  });

  it('needs competitor links to be http(s) URLs or null; a bare domain gains https://', () => {
    const n = draft();
    const at = (patch: object) => ({ ...n, competitors: { ...n.competitors, competitors: n.competitors.competitors.map((c, i) => (i === 0 ? { ...c, ...patch } : c)) } });
    expect(problemsOf(at({ website: 'ftp://cambridgesatchel.com' })).join()).toMatch(/competitors\.competitors\.0\.website/);
    expect(problemsOf(at({ social: 'the Instagram account' })).join()).toMatch(/competitors\.competitors\.0\.social/);
    expect(problemsOf(at({ website: 'javascript:alert(1)' })).join()).toMatch(/website/);

    const result = checkNarrative(at({ website: 'cambridgesatchel.com', social: 'instagram.com/cambridge_satchel/' }), withFigures);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.narrative.competitors.competitors[0]!.website).toBe('https://cambridgesatchel.com');
      expect(result.narrative.competitors.competitors[0]!.social).toBe('https://instagram.com/cambridge_satchel/');
    }
  });

  it('needs the priorities numbered 1…n in order', () => {
    const n = draft();
    const priorities = n.strategy.priorities.map((p, i) => ({ ...p, priority: i === 2 ? 5 : p.priority }));
    expect(problemsOf({ ...n, strategy: { ...n.strategy, priorities } }).join()).toMatch(/number the priorities 1 to 3/);
  });

  it('holds Section 03 to the figures: commentary exactly when there are figures, one action per cost line', () => {
    const n = draft();
    expect(problemsOf(n, noFigures)).toEqual(['financialCommentary: must be null, because no figures were supplied']);
    expect(checkNarrative({ ...n, financialCommentary: null }, noFigures).ok).toBe(true);
    expect(problemsOf({ ...n, financialCommentary: null })).toEqual(['financialCommentary: is required, because figures were supplied']);

    const commentary = n.financialCommentary!;
    expect(problemsOf({ ...n, financialCommentary: { ...commentary, costActions: ['Only one'] } }).join())
      .toMatch(/give exactly 2 actions, one per cost line in the order given \(got 1\)/);
    const noSales = { financials: { ...BEARA_FINANCIALS, productSales: null } };
    expect(problemsOf(n, noSales)).toEqual(['financialCommentary.productSales: must be null, because no product-sector sales were supplied']);
    expect(checkNarrative({ ...n, financialCommentary: { ...commentary, productSales: null } }, withFigures).ok).toBe(true);
    const noLines = { financials: { ...BEARA_FINANCIALS, costLines: [] } };
    expect(checkNarrative({ ...n, financialCommentary: { ...commentary, costActions: [] } }, noLines).ok).toBe(true);
  });

  it('caps the problems it reports', () => {
    expect(problemsOf({}).length).toBeLessThanOrEqual(15);
    expect(problemsOf('not an object')).toHaveLength(1);
  });
});

describe('links', () => {
  it('tidies a bare domain and leaves everything else alone', () => {
    expect(tidyLink('www.fossil.com')).toBe('https://www.fossil.com');
    expect(tidyLink(' fossil.co.uk/shop ')).toBe('https://fossil.co.uk/shop');
    expect(tidyLink('https://fossil.com')).toBe('https://fossil.com');
    expect(tidyLink('Fossil on Instagram')).toBe('Fossil on Instagram');
    expect(tidyLink('')).toBeNull();
    expect(tidyLink(null)).toBeNull();
    expect(isHttpUrl('https://www.fossil.com/')).toBe(true);
    expect(isHttpUrl('http://localhost')).toBe(false);
    expect(isHttpUrl('mailto:a@b.com')).toBe(false);
  });
});

describe('the tool schema', () => {
  /** Every keyword used anywhere in the schema. */
  function keywords(node: unknown, into = new Set<string>()): Set<string> {
    if (Array.isArray(node)) node.forEach((n) => keywords(n, into));
    else if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        into.add(k);
        if (k === 'properties') Object.values(v as object).forEach((p) => keywords(p, into));
        else keywords(v, into);
      }
    }
    return into;
  }

  it('is a plain object schema OpenAI function calling carries: no refs, no combinators but anyOf-null, no draft marker', () => {
    const schema = narrativeJsonSchema();
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    const used = keywords(schema);
    for (const forbidden of ['$schema', '$ref', '$defs', 'definitions', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'format']) {
      expect(used.has(forbidden), forbidden).toBe(false);
    }
  });

  it('makes every property of every object required (nullable, never optional)', () => {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      const o = node as { type?: unknown; properties?: Record<string, unknown>; required?: string[] };
      if (o.type === 'object' && o.properties) {
        expect(new Set(o.required)).toEqual(new Set(Object.keys(o.properties)));
        expect((o as { additionalProperties?: unknown }).additionalProperties).toBe(false);
      }
      Object.values(o).forEach(walk);
    };
    walk(narrativeJsonSchema());
  });

  it('describes the same fields the contract has', () => {
    const schema = narrativeJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(['competitors', 'financialCommentary', 'objective', 'overview', 'strategy']);
    expect(MarketingNarrativeSchema.safeParse(validNarrative()).success).toBe(true);
  });
});
