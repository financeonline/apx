import { describe, expect, it } from 'vitest';
import type { InvestmentNarrative } from '@/modules/investment';
import { CLIENT_FIGURES, figuresIn } from '../fixtures/investment-figures';
import { validInvestmentNarrative } from '../fixtures/investment-narrative';

const {
  HIGH_RISK_CAP_PCT, InvestmentNarrativeSchema, checkInvestmentNarrative, investmentNarrativeJsonSchema, linkKey, moneyMentions,
  percentMentions, restates,
} = await import('@/modules/investment/domain/narrative-schema');
const { playbookFor } = await import('@/modules/investment/domain/playbooks');
const { Decimal } = await import('@/core/money');

/**
 * ADR-171: the Investment Pack's words are either the contract's exact shape — options from lower to
 * higher risk, a portfolio adding to 100 with at most 10% high risk, playbook-only links, no named
 * products and no number that is not APX's — or a list of problems the model can fix. Never a guess.
 */

type Draft = { -readonly [K in keyof InvestmentNarrative]: InvestmentNarrative[K] };
const UK = { figures: CLIENT_FIGURES, playbook: playbookFor('GB') };

/** A deep copy to break. */
const draft = (): Draft => structuredClone(validInvestmentNarrative()) as Draft;

function problemsOf(input: unknown, context = UK): readonly string[] {
  const result = checkInvestmentNarrative(input, context);
  return result.ok ? [] : result.problems;
}

describe('the schema', () => {
  it('accepts the client example and keeps it as written', () => {
    const result = checkInvestmentNarrative(validInvestmentNarrative(), UK);
    expect(result.ok ? [] : result.problems).toEqual([]);
    if (result.ok) expect(result.narrative).toEqual(validInvestmentNarrative());
  });

  it('refuses a missing field, an extra field, a blank string and an over-long one', () => {
    const missing = draft() as Record<string, unknown>;
    delete missing.comparison;
    expect(problemsOf(missing).join()).toMatch(/comparison/);
    expect(problemsOf({ ...draft(), extra: 'x' }).join()).toMatch(/extra|Unrecognized/i);
    expect(problemsOf({ ...draft(), objective: '   ' }).join()).toMatch(/objective: must not be blank/);
    expect(problemsOf({ ...draft(), growthToSurplus: 'x'.repeat(1201) }).join()).toMatch(/growthToSurplus/);
  });

  it('holds the counts: 4–6 levers, 3–5 options, 3–6 portfolio lines, 5–7 stages, 4–8 controls, exactly 4 priorities, 2–8 references', () => {
    const n = draft();
    expect(problemsOf({ ...n, levers: n.levers.slice(0, 3) }).join()).toMatch(/^levers/);
    expect(problemsOf({ ...n, options: n.options.slice(0, 2) }).join()).toMatch(/^options/);
    expect(problemsOf({ ...n, options: [...n.options, n.options[4]!] }).join()).toMatch(/^options/);
    expect(problemsOf({ ...n, portfolio: n.portfolio.slice(0, 2) }).join()).toMatch(/^portfolio/);
    expect(problemsOf({ ...n, process: n.process.slice(0, 4) }).join()).toMatch(/^process/);
    expect(problemsOf({ ...n, governance: n.governance.slice(0, 3) }).join()).toMatch(/^governance/);
    expect(problemsOf({ ...n, recommendation: n.recommendation.slice(0, 3) }).join()).toMatch(/^recommendation/);
    expect(problemsOf({ ...n, recommendation: [...n.recommendation, n.recommendation[0]!] }).join()).toMatch(/^recommendation/);
    expect(problemsOf({ ...n, references: n.references.slice(0, 1) }).join()).toMatch(/^references/);
  });

  it('knows only the six risk levels, and wants portfolio shares as whole-number strings', () => {
    const n = draft();
    expect(problemsOf({ ...n, options: n.options.map((o, i) => (i === 0 ? { ...o, risk: 'none' } : o)) }).join()).toMatch(/options\.0\.risk/);
    expect(problemsOf({ ...n, portfolio: n.portfolio.map((p, i) => (i === 0 ? { ...p, percent: '45%' } : p)) }).join()).toMatch(/whole number of percent/);
    expect(problemsOf({ ...n, portfolio: n.portfolio.map((p, i) => (i === 0 ? { ...p, percent: '44.5' } : p)) }).join()).toMatch(/portfolio\.0\.percent/);
  });
});

describe('risk', () => {
  it('needs the options ordered from lower to higher risk; equal neighbours are fine', () => {
    const n = draft();
    const swapped = [n.options[1]!, n.options[0]!, ...n.options.slice(2)];
    expect(problemsOf({ ...n, options: swapped }).join()).toMatch(/order the options from lower to higher risk \(option 2, "Cash deposits & short-dated gilts", is lower after low_medium\)/);
    const level = n.options.map((o, i) => (i === 3 ? { ...o, risk: 'higher' as const } : o));
    expect(problemsOf({ ...n, options: level })).toEqual([]);
  });

  it('holds high and very high risk together to 10% of the portfolio — the client\'s rule', () => {
    expect(HIGH_RISK_CAP_PCT).toBe(10);
    const n = draft();
    const over = n.portfolio.map((p, i) => (i === 0 ? { ...p, percent: '44' } : i === 3 ? { ...p, percent: '6' } : p));
    expect(problemsOf({ ...n, portfolio: over })).toContain('portfolio: high and very_high risk together come to 11%; they may be at most 10% of the external allocation');
    const highEquity = n.portfolio.map((p, i) => (i === 0 ? { ...p, risk: 'high' as const } : p));
    expect(problemsOf({ ...n, portfolio: highEquity }).join()).toMatch(/come to 55%/);
  });

  it('keeps crypto at very high risk, whatever it is called', () => {
    const n = draft();
    const options = n.options.map((o, i) => (i === 3 ? { ...o, name: 'Digital assets', description: 'Crypto exposure.', referenceUrl: null } : o));
    expect(problemsOf({ ...n, options }).join()).toMatch(/options\.3\.risk: a crypto option is always very_high/);
    const portfolio = n.portfolio.map((p, i) => (i === 3 ? { ...p, assetClass: 'Crypto-assets' } : p));
    expect(problemsOf({ ...n, portfolio }).join()).toMatch(/portfolio\.3\.risk: a crypto holding is always very_high/);
    const fine = n.portfolio.map((p, i) => (i === 4 ? { ...p, assetClass: 'Crypto-assets' } : p));
    expect(problemsOf({ ...n, portfolio: fine })).toEqual([]);
  });
});

describe('the portfolio and the lists', () => {
  it('needs whole shares from 1 to 100 adding up to exactly 100, each asset class once', () => {
    const n = draft();
    expect(problemsOf({ ...n, portfolio: n.portfolio.map((p, i) => (i === 0 ? { ...p, percent: '40' } : p)) }))
      .toContain('portfolio: the percentages add up to 95, not 100');
    const zero = n.portfolio.map((p, i) => (i === 0 ? { ...p, percent: '50' } : i === 4 ? { ...p, percent: '0' } : p));
    expect(problemsOf({ ...n, portfolio: zero }).join()).toMatch(/from 1 to 100/);
    const twice = n.portfolio.map((p, i) => (i === 1 ? { ...p, assetClass: ' global EQUITY funds' } : p));
    expect(problemsOf({ ...n, portfolio: twice }).join()).toMatch(/each asset class may appear once/);
  });

  it('numbers the stages 1…n and names each lever and option once', () => {
    const n = draft();
    expect(problemsOf({ ...n, process: n.process.map((s, i) => (i === 2 ? { ...s, stage: 5 } : s)) }).join()).toMatch(/number the stages 1 to 6 in order \(entry 3 is numbered 5\)/);
    expect(problemsOf({ ...n, levers: n.levers.map((l, i) => (i === 1 ? { ...l, lever: 'customer acquisition' } : l)) }).join()).toMatch(/each lever may appear once/);
  });
});

describe('links', () => {
  const at = (patch: object, index = 0) => {
    const n = draft();
    return { ...n, options: n.options.map((o, i) => (i === index ? { ...o, ...patch } : o)) };
  };

  it('allows only the playbook\'s pages, for options and references', () => {
    expect(problemsOf(at({ referenceUrl: 'https://www.ishares.com/uk/individual/en/products/291773/ishares-global-aggregate-bond-ucits-etf-fund' }, 1)).join())
      .toMatch(/options\.1\.referenceUrl: ".*291773.*" is not one of the playbook's reference links; use one of those addresses exactly as listed, or null/);
    expect(problemsOf(at({ referenceUrl: 'ftp://files.example.com/gilts' })).join()).toMatch(/options\.0\.referenceUrl: must be a full http\(s\) address/);
    expect(problemsOf(at({ referenceUrl: 'javascript:alert(1)' })).join()).toMatch(/options\.0\.referenceUrl/);
    expect(problemsOf(at({ referenceUrl: null }))).toEqual([]);

    const n = draft();
    const invented = [...n.references, { label: 'A blog', url: 'https://invest-tips.example.com/' }];
    expect(problemsOf({ ...n, references: invented }).join()).toMatch(/references\.6\.url: "https:\/\/invest-tips\.example\.com\/" is not one of the playbook's reference links/);
  });

  it('judges links by the company\'s country: a UK page is not on the Indian playbook', () => {
    const india = { figures: figuresIn('INR'), playbook: playbookFor('IN') };
    expect(problemsOf(validInvestmentNarrative(), india).join()).toMatch(/"https:\/\/www\.dmo\.gov\.uk\/" is not one of the playbook's reference links/);
  });

  it('tidies a bare domain or another spelling of a playbook page to the playbook\'s own spelling', () => {
    const n = draft();
    const options = n.options.map((o, i) => (i === 0 ? { ...o, referenceUrl: 'dmo.gov.uk' } : i === 2 ? { ...o, referenceUrl: 'http://VANGUARD.co.uk' } : o));
    const result = checkInvestmentNarrative({ ...n, options }, UK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.narrative.options[0]!.referenceUrl).toBe('https://www.dmo.gov.uk/');
      expect(result.narrative.options[2]!.referenceUrl).toBe('https://www.vanguard.co.uk/');
    }
    expect(linkKey('https://www.FCA.org.uk/')).toBe(linkKey('http://fca.org.uk'));
  });

  it('keeps a reference listed twice once, and needs a regulator among the references', () => {
    const n = draft();
    const twice = checkInvestmentNarrative({ ...n, references: [...n.references, { label: 'FCA again', url: 'fca.org.uk' }] }, UK);
    expect(twice.ok).toBe(true);
    if (twice.ok) expect(twice.narrative.references).toHaveLength(6);

    const noRegulator = n.references.filter((r) => r.url !== 'https://www.fca.org.uk/');
    expect(problemsOf({ ...n, references: noRegulator })).toEqual(['references: include at least one regulator\'s page from the playbook']);
    const one = checkInvestmentNarrative({ ...n, references: [n.references[5]!, { label: 'FCA', url: 'https://fca.org.uk' }] }, UK);
    expect(one.ok ? [] : one.problems).toContain('references: give at least 2 different reference links');
  });
});

describe('never a named product', () => {
  it('refuses a provider, platform or coin in the options, the portfolio and the prose — but not in a reference label', () => {
    const n = draft();
    const named = n.options.map((o, i) => (i === 2 ? { ...o, name: 'Vanguard global index funds' } : o));
    expect(problemsOf({ ...n, options: named }).join()).toMatch(/options\.2\.name: names "Vanguard"; name the asset class or route/);
    const coin = n.portfolio.map((p, i) => (i === 4 ? { ...p, assetClass: 'Bitcoin' } : p));
    expect(problemsOf({ ...n, portfolio: coin }).join()).toMatch(/portfolio\.4\.assetClass: names "Bitcoin"/);
    const recommendation = n.recommendation.map((r, i) => (i === 2 ? { ...r, text: 'Allocate 35% to an iShares portfolio.' } : r));
    expect(problemsOf({ ...n, recommendation }).join()).toMatch(/recommendation\.2\.text: names "iShares"/);
    // "Vanguard UK" as a reference label is a page to read, not a recommendation.
    expect(problemsOf(n)).toEqual([]);
  });
});

describe('the numbers are APX\'s', () => {
  const withComparison = (comparison: string) => ({ ...draft(), comparison });
  const base = validInvestmentNarrative().comparison;

  it('passes restatements, exact or rounded the way people round', () => {
    // The example's own: "approximately £311,000" (£311,040), "£1m" (£1,000,000), "15%" (15.0%), "35–50%".
    expect(problemsOf(validInvestmentNarrative())).toEqual([]);
    const fair = { ...draft(), growthToSurplus: 'Net profit rises from £150,000 to £311,040 (about £0.31m), with £2.07 million of Year 5 revenue at a 15.0% margin.' };
    expect(problemsOf(fair)).toEqual([]);
    expect(problemsOf(withComparison(`${base} Over five years at 10 per cent the allocation would reach £56,368.`))).toEqual([]);
  });

  it('refuses an amount or percentage that is not in the figures, wherever it is written', () => {
    expect(problemsOf(withComparison(`${base} A further £50,000 could follow.`)).join())
      .toMatch(/comparison: "£50,000" is not one of APX's figures; restate amounts and percentages exactly as they appear in <figures>/);
    expect(problemsOf({ ...draft(), reinvestment: 'Revenue could grow by 61% over the period.' }).join()).toMatch(/reinvestment: "61%" is not one of APX's figures/);
    expect(problemsOf({ ...draft(), growthToSurplus: 'Net profit reaches roughly £400,000 by Year 5.' }).join()).toMatch(/growthToSurplus: "£400,000"/);
    const yields = draft();
    const options = yields.options.map((o, i) => (i === 0 ? { ...o, description: 'Gilts currently yield around 4.5%.' } : o));
    expect(problemsOf({ ...yields, options }).join()).toMatch(/options\.0\.description: "4\.5%"/);
    const split = draft();
    const recommendation = split.recommendation.map((r, i) => (i === 1 ? { ...r, text: 'Deploy 50% of investable surplus to growth projects.' } : r));
    // 50% is the stretch growth rate, so it passes as a figure; 55% does not.
    expect(problemsOf({ ...split, recommendation })).toEqual([]);
    const wrong = split.recommendation.map((r, i) => (i === 1 ? { ...r, text: 'Deploy 55% of investable surplus to growth projects.' } : r));
    expect(problemsOf({ ...split, recommendation: wrong }).join()).toMatch(/recommendation\.1\.text: "55%"/);
  });

  it('allows the portfolio\'s own shares and their amounts on the external allocation', () => {
    const n = draft();
    expect(problemsOf({ ...n, portfolioNote: 'Global equity funds take 45% (£15,750) and private investments 5% (£1,750); high-risk investments are limited to 10%.' })).toEqual([]);
    expect(problemsOf({ ...n, portfolioNote: 'Global equity funds take £16,000.' }).join()).toMatch(/portfolioNote: "£16,000"/);
  });

  it('needs the comparison to state the gain and the sales needed for the same gain', () => {
    const vague = 'Investing the external allocation at the target return would earn far more than the equivalent sales effort.';
    expect(problemsOf(withComparison(vague))).toEqual([
      'comparison: state the gain, £11,585, exactly as given in <figures>',
      'comparison: state the sales the business would need for the same gain, £77,233, exactly as given in <figures>',
    ]);
    const noMargin = { figures: { ...CLIENT_FIGURES, comparison: { ...CLIENT_FIGURES.comparison, salesNeededForSameGain: null } }, playbook: UK.playbook };
    expect(problemsOf(withComparison('The £35,000 would gain £11,585; the base year shows no positive margin to compare with.'), noMargin)).toEqual([]);
  });

  it('reads the organisation\'s own currency: AED, INR and EUR amounts', () => {
    // The UK playbook throughout, so only the currency differs from the client example.
    const aed = { figures: figuresIn('AED'), playbook: playbookFor('GB') };
    const inr = { figures: figuresIn('INR'), playbook: playbookFor('GB') };
    expect(moneyMentions('a gain of AED 11,585 and AED46,585', 'AED').map((m) => m.value.toString())).toEqual(['11585', '46585']);
    expect(moneyMentions('a gain of 11,585 AED', 'AED').map((m) => m.text)).toEqual(['11,585 AED']);
    expect(moneyMentions('₹10 lakh, ₹1.5 crore and ₹77,233', 'INR').map((m) => m.value.toString())).toEqual(['1000000', '15000000', '77233']);
    expect(moneyMentions('€2.07m, about €311k', 'EUR').map((m) => m.value.toString())).toEqual(['2070000', '311000']);
    expect(moneyMentions('£35,000 more', 'GBP').map((m) => m.value.toString())).toEqual(['35000']);
    expect(problemsOf({ ...withComparison('At 10% for three years AED 35,000 grows to AED 46,585, a gain of AED 11,585; the business would need AED 77,233 of sales.'), growthToSurplus: 'Net profit rises over the period.', reinvestment: 'Growth is not the same as investment return.' }, aed))
      .toEqual([]);
    expect(problemsOf(withComparison('At 10% the gain is ₹11,585, against ₹77,233 of sales, or ₹7 lakh of new orders.'), inr).join())
      .toMatch(/comparison: "₹7 lakh" is not one of APX's figures/);
    // ₹10 lakh is ₹1,000,000: the base year's revenue, so a fair restatement.
    expect(problemsOf(withComparison('At 10% the gain is ₹11,585, against ₹77,233 of sales on ₹10 lakh of revenue.'), inr)).toEqual([]);
  });

  it('finds percentages written every usual way', () => {
    expect(percentMentions('20%, 15.0 %, 10 per cent, 20–50% and 35 to 50%; Year 2-3 and 2026 are not').map((m) => m.text))
      .toEqual(['20%', '15.0%', '10%', '20%', '50%', '35%', '50%']);
  });

  it('matches a mention to a figure within its own rounding and, for money, within 1%', () => {
    const [approx] = moneyMentions('£311,000', 'GBP');
    expect(restates(approx!, new Decimal('311040'))).toBe(true);
    const [three] = moneyMentions('£2.07m', 'GBP');
    expect(restates(three!, new Decimal('2073600'))).toBe(true);
    const [coarse] = moneyMentions('£60,000', 'GBP');
    expect(restates(coarse!, new Decimal('61215'))).toBe(false); // 2% away: not this figure
    const [far] = moneyMentions('£200,000', 'GBP');
    expect(restates(far!, new Decimal('216000'))).toBe(false);
    const [exact] = moneyMentions('£35,000.50', 'GBP');
    expect(restates(exact!, new Decimal('35000'))).toBe(false);
    const [pct] = percentMentions('15%');
    expect(restates(pct!, new Decimal('15.0'))).toBe(true);
    expect(restates(pct!, new Decimal('14.4'))).toBe(false);
  });

  it('caps the problems it reports', () => {
    expect(problemsOf({}).length).toBeLessThanOrEqual(15);
    expect(problemsOf('not an object')).toHaveLength(1);
    const many = { ...draft(), governance: Array.from({ length: 8 }, (_, i) => `Hold £${i + 1}3,333 in reserve at ${i + 41}%.`) };
    expect(problemsOf(many)).toHaveLength(15);
  });
});

describe('the tool schema', () => {
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
    const schema = investmentNarrativeJsonSchema();
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
    walk(investmentNarrativeJsonSchema());
  });

  it('describes the same fields the contract has, with the risk levels as an enum', () => {
    const schema = investmentNarrativeJsonSchema() as { properties: Record<string, { items?: { properties?: Record<string, { enum?: string[] }> } }> };
    expect(Object.keys(schema.properties).sort()).toEqual([
      'comparison', 'externalIntro', 'governance', 'growthToSurplus', 'levers', 'objective', 'options', 'portfolio', 'portfolioNote',
      'process', 'recommendation', 'references', 'reinvestment',
    ]);
    expect(schema.properties.options!.items!.properties!.risk!.enum).toEqual(['lower', 'low_medium', 'medium', 'higher', 'high', 'very_high']);
    expect(InvestmentNarrativeSchema.safeParse(validInvestmentNarrative()).success).toBe(true);
  });
});
