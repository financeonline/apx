import type { CompanyProfile, MarketingFinancials, MarketingNarrative } from '@/modules/marketing';

/**
 * ADR-170 fixtures: the client's own example (the Beara Beara strategy, October 2026) as the
 * contract's types — a profile, the three years of figures their document shows, and a narrative
 * that passes every check. Tests copy and break these.
 */

export const BEARA_PROFILE: CompanyProfile = {
  website: 'https://www.bearabeara.co.uk/',
  socialLinks: [{ label: 'Instagram', url: 'https://www.instagram.com/beara_beara/' }],
  productsServices: 'Luxury Leather Bags',
  industry: 'Luxury leather accessories',
  description: 'Vintage-inspired British design with leather craftsmanship in Bolivia.',
};

const year = (
  label: string, start: string, end: string,
  v: [string, string, string, string, string, string, string, string, string, string],
) => ({
  label, periodStart: start, periodEnd: end, partial: false,
  turnover: v[0], costOfSales: v[1], costOfSalesPct: v[2], grossProfit: v[3], grossProfitPct: v[4],
  adminCosts: v[5], netProfit: v[6], netProfitPct: v[7], marketingSpend: v[8], marketingPct: v[9],
});

export const BEARA_FINANCIALS: MarketingFinancials = {
  currency: 'GBP',
  years: [
    year('2024', '2023-10-01', '2024-09-30', ['1633422.00', '937075.00', '57.4', '696347.00', '42.6', '379997.00', '229727.00', '14.1', '119729.00', '7.3']),
    year('2025', '2024-10-01', '2025-09-30', ['895231.00', '415616.00', '46.4', '479615.00', '53.6', '333246.00', '104806.00', '11.7', '36939.00', '4.1']),
    year('2026', '2025-10-01', '2026-09-30', ['704530.00', '380512.00', '54.0', '324018.00', '46.0', '233608.00', '65542.00', '9.3', '19296.00', '2.7']),
  ],
  productSales: {
    previousLabel: '2025',
    currentLabel: '2026',
    rows: [
      { product: 'Handbags', previous: '559565.00', current: '437128.00', changePct: '-21.9' },
      { product: 'Backpacks', previous: '155388.00', current: '104979.00', changePct: '-32.4' },
      { product: 'Accessories & Other', previous: '59782.00', current: '70446.00', changePct: '17.8' },
    ],
  },
  costLines: [
    { name: 'Transportation & distribution', amount: '79086.00' },
    { name: 'Websites & IT', amount: '20049.00' },
  ],
  sourceNote: 'All figures GBP. Financial years ended 30 September. Source: the accounts held in APX.',
};

/** A narrative in the shape and depth of the client's example, valid with `BEARA_FINANCIALS`. */
export function validNarrative(): MarketingNarrative {
  return {
    objective: 'Strengthen Beara Beara\'s position in premium leather accessories, acquire higher-quality customers, improve repeat purchase and protect contribution margins.',
    overview: 'The strategy is structured in the same sequence as the management presentation: competitor and customer sectors first, then campaign and commercial implementation, with the complete financial overview at the end.',
    competitors: {
      brandPositioning: 'Beara Beara combines vintage-inspired British design with leather craftsmanship. It should test a clear "investment in everyday style" message rather than compete purely on price.',
      competitors: [
        { name: 'Cambridge Satchel', positioning: 'direct heritage competitor', learning: 'Craftsmanship, signature satchels, personalisation and collaborations.', website: 'https://www.cambridgesatchel.com', social: 'https://www.instagram.com/cambridge_satchel/' },
        { name: 'O My Bag Amsterdam', positioning: 'ethical premium', learning: 'Responsible production, lifetime value and retention programmes.', website: 'https://www.omybagamsterdam.com', social: null },
        { name: 'Fossil', positioning: 'broad accessories benchmark', learning: 'Gifting, coordinated leather accessories and cross-selling.', website: 'https://www.fossil.com', social: 'https://www.instagram.com/fossil/' },
      ],
      competitorNote: 'These brands are directional comparators, not a ranking by market share or verified digital engagement.',
      customerSectors: [
        { sector: 'Premium everyday fashion', profile: 'Style-conscious buyers; versatile daily use', campaignDirection: 'Creator-led styling, lifestyle imagery, hero handbag campaigns' },
        { sector: 'Professional & corporate', profile: 'Practicality, elegance, commuting', campaignDirection: 'Work-to-evening, functionality and durability' },
        { sector: 'Gifts & occasions', profile: 'Birthdays, anniversaries, seasonal gifting', campaignDirection: 'Personalisation, gifting guides and bundles' },
        { sector: 'International lifestyle', profile: 'Overseas customers attracted to British-inspired style', campaignDirection: 'Localised messaging and shipping clarity' },
      ],
      effortSplit: [
        { sector: 'Premium everyday fashion', percent: '50' },
        { sector: 'Professional & corporate', percent: '30' },
        { sector: 'Gifts & occasions', percent: '20' },
      ],
      effortNote: 'International audiences are a geographic overlay, not an additional budget line.',
    },
    strategy: {
      digitalAcquisition: [
        'Short-form Instagram and TikTok content showing product use, styling and craftsmanship.',
        'Google Search and Shopping for high-intent handbag, satchel and backpack searches.',
        'Meta retargeting for product viewers and abandoned checkouts, subject to consent.',
      ],
      productCampaigns: [
        { product: 'Handbags', positioning: 'Style and everyday luxury', execution: 'Hero SKU campaign; outfit styling; work and evening versatility' },
        { product: 'Backpacks', positioning: 'Professional and travel practicality', execution: 'Test demand, price and imagery before scaling' },
      ],
      retention: [
        'Membership or early-access benefits for returning customers.',
        'Complementary accessories and personalisation at checkout.',
        'Test value-added benefits before broad discounting.',
      ],
      concepts: [
        { title: 'The Bag and Its Story', description: 'Maker-to-owner storytelling; artisan interviews and workshop footage.', purpose: 'Brand awareness and differentiation' },
        { title: 'The Everyday Icon', description: 'Hero bags photographed across work, casual and evening settings.', purpose: 'Product recognition and conversion' },
        { title: 'A Gift That Lasts', description: 'Personalisation and premium gifting for occasions and seasonal peaks.', purpose: 'Basket value and new audiences' },
      ],
      recommendedCombination: 'Use The Bag and Its Story and The Everyday Icon as the always-on foundation and A Gift That Lasts for seasonal sales.',
      budget: [
        { channel: 'Meta / Instagram advertising', percent: '40', purpose: 'Discovery, retargeting and product sales' },
        { channel: 'Google Search / Shopping', percent: '35', purpose: 'Capture high purchase intent' },
        { channel: 'Email / retention', percent: '25', purpose: 'Repeat purchases and recovery' },
      ],
      budgetNote: 'Example: a £3,000 monthly test budget equates to £36,000 annualised. This is an illustrative allocation, not an approved spend recommendation.',
      first90Days: [
        { period: 'Days 1–30', activities: 'SKU margin audit; segment and channel baselines', deliverable: 'Profitability shortlist and KPI dashboard' },
        { period: 'Days 31–60', activities: 'Small paid-media tests; creator content; email flows', deliverable: 'CAC, conversion and contribution assessment' },
        { period: 'Days 61–90', activities: 'Reallocate to profitable campaigns', deliverable: 'Scale or stop decisions and revised forecast' },
      ],
      priorities: [
        { priority: 1, action: 'Identify highest-contribution hero products', kpi: 'Contribution margin by SKU' },
        { priority: 2, action: 'Acquire qualified customers in target sectors', kpi: 'CAC, conversion rate, new customers' },
        { priority: 3, action: 'Review monthly financial and marketing performance', kpi: 'Marketing spend %, gross and net margins' },
      ],
    },
    financialCommentary: {
      performance: '2026 turnover changed by −21.3% year on year. Gross margin changed by −7.6 percentage points. Net profit changed by −37.5%.',
      productSales: 'Handbags remain the primary sales engine; Accessories & Other grew.',
      marketingEfficiency: 'Marketing expenditure has fallen considerably. Accounting caution: some costs may be classified within cost of sales.',
      costActions: ['Audit fulfilment cost by order and geography', 'Review platform subscriptions and development return'],
      actionPlan: [
        'Calculate merchandise margin and contribution by SKU.',
        'Review supplier costs, freight, duties, pricing and discount policy.',
        'Monitor monthly revenue, gross margin, net margin and marketing intensity.',
      ],
      conclusion: 'Connect product profitability, sector-led acquisition and retention into one commercial operating model.',
    },
  };
}
