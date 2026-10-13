import { describe, expect, it } from 'vitest';

const {
  INDUSTRY_TEMPLATES, industryTemplate, productList, templateFor, templateSections,
} = await import('@/modules/marketing/domain/industry-templates');
const { NARRATIVE_BOUNDS, checkNarrative } = await import('@/modules/marketing/domain/narrative-schema');

/**
 * ADR-170: the hardcoded playbooks steer the prompt and stand in for the model offline, so every
 * one of them must be sound on its own — splits that add to 100, sectors that exist, counts and
 * lengths inside the narrative schema — and the matcher must send a company to the right one.
 */

const sum = (values: readonly string[]) => values.reduce((a, v) => a + Number.parseInt(v, 10), 0);

describe('every template', () => {
  it.each(INDUSTRY_TEMPLATES.map((t) => [t.key, t] as const))('%s is internally sound', (_key, t) => {
    expect(sum(t.effortSplit.map((s) => s.percent))).toBe(100);
    expect(sum(t.budget.map((b) => b.percent))).toBe(100);
    const sectors = t.customerSectors.map((s) => s.sector);
    for (const share of t.effortSplit) expect(sectors).toContain(share.sector);
    expect(new Set(sectors).size).toBe(sectors.length);
    expect(t.priorities.map((p) => p.priority)).toEqual(t.priorities.map((_, i) => i + 1));
    expect(t.first90Days.map((p) => p.period)).toEqual(['Days 1–30', 'Days 31–60', 'Days 61–90']);
    expect(t.competitorTypes.length).toBeGreaterThanOrEqual(NARRATIVE_BOUNDS.competitors.min);
    expect(t.concepts.length).toBeGreaterThanOrEqual(NARRATIVE_BOUNDS.concepts.min);
    expect(t.concepts.length).toBeLessThanOrEqual(NARRATIVE_BOUNDS.concepts.max);
  });

  it.each(INDUSTRY_TEMPLATES.map((t) => [t.key, t] as const))('%s builds Sections 01 and 02 that pass the narrative checks', (_key, t) => {
    const sections = templateSections(t, {
      organisationName: 'Acme Trading Ltd', productsServices: null, industry: null, exampleMonthlyBudget: '£3,000', exampleAnnualBudget: '£36,000',
    });
    const result = checkNarrative({ ...sections, overview: 'How to read it.', financialCommentary: null }, { financials: null });
    expect(result.ok ? [] : result.problems).toEqual([]);
    // Offline never invents a business: no competitor carries a link.
    expect(sections.competitors.competitors.every((c) => c.website === null && c.social === null)).toBe(true);
  });

  it('uses UK spelling in what reaches the report', () => {
    const text = JSON.stringify(INDUSTRY_TEMPLATES);
    for (const us of ['optimize', 'personalization', 'color', 'center ', 'program ', 'favorite', 'organization']) {
      expect(text.toLowerCase().includes(us), us).toBe(false);
    }
  });
});

describe('templateFor', () => {
  it.each([
    ['Luxury leather accessories', 'Luxury Leather Bags', 'retail'],
    [null, 'Sports apparel', 'retail'],
    ['Restaurant', null, 'hospitality'],
    [null, 'Café and bakery', 'hospitality'],
    ['Accountancy', 'Bookkeeping and tax returns', 'professional-services'],
    ['Construction', 'Roofing and loft conversions', 'construction'],
    ['Software', 'SaaS platform for clinics', 'technology'],
    ['Manufacturing', 'Packaging components', 'manufacturing'],
    ['Health & fitness', 'Gym memberships and personal training', 'health'],
    ['Software', 'Online store builder', 'technology'],
    [null, null, 'other'],
    ['Space tourism', 'Orbital flights', 'other'],
  ] as const)('%s / %s → %s', (industry, products, key) => {
    expect(templateFor(industry, products).key).toBe(key);
  });

  it('matches whole words only: "apparel" is not "app", "baggage" is not "bag"', () => {
    expect(templateFor(null, 'Apparel').key).toBe('retail');
    expect(templateFor(null, 'Baggage handling').key).toBe('other');
  });

  it('counts the industry double what the company sells', () => {
    // Industry "Hospitality" (2) beats one retail word in the products (1).
    expect(templateFor('Hospitality', 'Gift vouchers').key).toBe('hospitality');
  });

  it('falls back to the general playbook by key too', () => {
    expect(industryTemplate('other').label).toBe('General business');
  });
});

describe('productList', () => {
  it('splits what a company sells into its lines, at most six, each fitting the schema', () => {
    expect(productList('Handbags, backpacks and satchels; wallets / embossing')).toEqual(['Handbags', 'Backpacks', 'Satchels', 'Wallets', 'Embossing']);
    expect(productList('Bags & bags & BAGS')).toEqual(['Bags']);
    expect(productList('a,b,c,d,e,f,g,h')).toHaveLength(6);
    expect(productList(`${'x'.repeat(200)}, y`)[0]!.length).toBeLessThanOrEqual(80);
    expect(productList(null)).toEqual([]);
  });

  it('uses the company\'s own lines in Strategy B when it names two or more', () => {
    const t = templateFor('Retail', null);
    const sections = templateSections(t, {
      organisationName: 'Acme', productsServices: 'Handbags, wallets', industry: 'Retail', exampleMonthlyBudget: '£3,000', exampleAnnualBudget: '£36,000',
    });
    expect(sections.strategy.productCampaigns.map((p) => p.product)).toEqual(['Handbags', 'Wallets']);
    expect(sections.objective).toContain('Acme\'s position in retail');
  });
});
