import { MARKETING_REPORT_VERSION, type MarketingReport } from '../../../src/modules/marketing/domain/types';

/**
 * The client's own example, transcribed into the report contract (ADR-170): "Beara Beara Marketing
 * Strategy", October 2026 — the document the Marketing report is shaped on. Every sentence and figure
 * is the client's, so a renderer test can assert on text the client will recognise.
 *
 * Percentages are percent strings with one place ("57.4"), shares whole ("35"), money two places —
 * as `services/financials` produces them. The document's 3.4 "Accounting caution" paragraph has no
 * field in the contract and is not carried.
 */
export const SAMPLE_MARKETING_REPORT: MarketingReport = {
  version: MARKETING_REPORT_VERSION,
  organisationName: 'Beara Beara Ltd',
  generatedAt: '2026-10-13T09:30:00.000Z',
  reportDate: 'October 2026',
  profile: {
    website: 'https://www.bearabeara.co.uk/',
    socialLinks: [{ label: 'Instagram', url: 'https://www.instagram.com/beara_beara/' }],
    productsServices: 'Luxury leather bags',
    industry: 'Luxury leather accessories',
    description: 'Vintage-inspired British design with leather craftsmanship in Bolivia.',
  },
  narrative: {
    objective: 'Strategic objective: strengthen Beara Beara’s position in premium leather accessories, acquire higher-quality customers, improve repeat purchase and protect contribution margins. The proposed positioning centres on distinctive design, craftsmanship, longevity and accessible luxury rather than discount-led competition.',
    overview: 'The strategy is structured in the same sequence as the management presentation: competitor and customer sectors first, then campaign and commercial implementation, with the complete financial overview at the end.',
    competitors: {
      brandPositioning: 'Beara Beara combines vintage-inspired British design with leather craftsmanship in Bolivia. Its differentiation should be expressed through product character, makers’ stories, practical longevity and an identifiable visual aesthetic. The brand should test a clear “investment in everyday style” message rather than compete purely on price.',
      competitors: [
        { name: 'Cambridge Satchel', positioning: 'direct heritage competitor', learning: 'Craftsmanship, signature satchels, personalisation and collaborations', website: 'cambridgesatchel.com', social: 'instagram.com/cambridge_satchel/' },
        { name: 'O My Bag Amsterdam', positioning: 'ethical premium', learning: 'Responsible production, lifetime value, pre-loved and retention programmes', website: 'omybagamsterdam.com', social: 'instagram.com/omybagamsterdam/' },
        { name: 'SMAAK Amsterdam', positioning: 'contemporary style', learning: 'Seasonal colour, fashion photography and minimal styling', website: 'smaakamsterdam.com', social: 'instagram.com/smaakamsterdam/' },
        { name: 'Fossil', positioning: 'broad accessories benchmark', learning: 'Gifting, coordinated leather accessories and cross-selling', website: 'fossil.com', social: 'instagram.com/fossil/' },
      ],
      competitorNote: 'These brands are directional comparators, not a ranking by market share or verified digital engagement.',
      customerSectors: [
        { sector: 'Premium everyday fashion', profile: 'Style-conscious buyers; versatile daily use', campaignDirection: 'Creator-led styling, lifestyle imagery, hero handbag campaigns' },
        { sector: 'Professional & corporate', profile: 'Practicality, elegance, commuting', campaignDirection: 'Work-to-evening, functionality and durability' },
        { sector: 'Gifts & occasions', profile: 'Birthdays, anniversaries, seasonal gifting', campaignDirection: 'Personalisation, gifting guides and bundles' },
        { sector: 'Vintage / independent fashion', profile: 'Heritage aesthetics and individuality', campaignDirection: 'Editorial storytelling, boutiques, vintage creators' },
        { sector: 'Conscious consumption', profile: 'Craftsmanship, longevity, considered purchasing', campaignDirection: 'Maker stories, transparent claims, leather care' },
        { sector: 'International lifestyle', profile: 'Overseas customers attracted to British-inspired style', campaignDirection: 'Localised messaging and shipping clarity' },
      ],
      effortSplit: [
        { sector: 'everyday fashion', percent: '35' },
        { sector: 'professional', percent: '25' },
        { sector: 'gifting', percent: '15' },
        { sector: 'vintage', percent: '15' },
        { sector: 'conscious consumption', percent: '10' },
      ],
      effortNote: 'International audiences are a geographic overlay, not an additional budget line.',
    },
    strategy: {
      digitalAcquisition: [
        'Short-form Instagram/TikTok content showing product use, styling and craftsmanship.',
        'Google Search and Shopping for high-intent handbag, satchel and backpack searches.',
        'Meta retargeting for product viewers and abandoned checkouts, subject to consent.',
        'Product-specific landing pages, improved checkout experience and email automation.',
        'Measure customer acquisition cost, conversion, contribution per order and incremental return.',
      ],
      productCampaigns: [
        { product: 'Handbags', positioning: 'Style and everyday luxury', execution: 'Hero SKU campaign; outfit styling; work/evening versatility' },
        { product: 'Backpacks', positioning: 'Professional and travel practicality', execution: 'Test demand, price, function and product imagery before scaling' },
        { product: 'Satchels', positioning: 'Heritage and enduring design', execution: 'Editorial heritage photography and professional-use stories' },
        { product: 'Accessories / wallets', positioning: 'Affordable entry and gifting', execution: 'Bundles, add-on recommendations, post-purchase offers' },
        { product: 'Embossing', positioning: 'Personal and memorable gifts', execution: 'Personalisation landing pages and gift-season campaigns' },
      ],
      retention: [
        'Membership or early-access benefits for returning customers.',
        'Complementary accessories and personalisation at checkout.',
        'Post-purchase care, styling and referral journeys.',
        'Customer segmentation by product, frequency and average order value.',
        'Test value-added benefits before broad discounting.',
      ],
      concepts: [
        { title: 'The Bag and Its Story', description: 'Maker-to-owner storytelling; artisan interviews and workshop footage.', purpose: 'Brand awareness and differentiation.' },
        { title: 'The Everyday Icon', description: 'Hero bags photographed across work, casual and evening settings.', purpose: 'Product recognition and conversion.' },
        { title: 'A Gift That Lasts', description: 'Personalisation and premium gifting for occasions and seasonal peaks.', purpose: 'Basket value and new audiences.' },
        { title: 'Independent Luxury Partnerships', description: 'Selective collaborations with stylists, boutiques and independent designers.', purpose: 'New distribution tests.' },
      ],
      recommendedCombination: 'Recommended combination: use Concepts 01 and 02 as the always-on foundation, Concept 03 for seasonal sales and Concept 04 as a controlled pilot.',
      budget: [
        { channel: 'Meta / Instagram advertising', percent: '35', purpose: 'Discovery, retargeting and product sales' },
        { channel: 'Google Search / Shopping', percent: '25', purpose: 'Capture high purchase intent' },
        { channel: 'Content / photography', percent: '15', purpose: 'Campaign creative and product presentation' },
        { channel: 'Creators / collaborations', percent: '10', purpose: 'Audience reach and social proof' },
        { channel: 'Email / retention', percent: '10', purpose: 'Repeat purchases and recovery' },
        { channel: 'Testing / optimisation', percent: '5', purpose: 'Conversion experiments' },
      ],
      budgetNote: 'Example: a £3,000 monthly test budget equates to £36,000 annualised. This is an illustrative allocation, not an approved spend recommendation. Final spend must be constrained by product contribution, CAC and cash availability.',
      first90Days: [
        { period: 'Days 1–30', activities: 'SKU margin audit; segment and channel baselines; landing page review', deliverable: 'Profitability shortlist and KPI dashboard' },
        { period: 'Days 31–60', activities: 'Small paid-media tests; creator content; email flows', deliverable: 'CAC, conversion and contribution assessment' },
        { period: 'Days 61–90', activities: 'Reallocate to profitable campaigns; gifting and retention tests', deliverable: 'Scale / stop decisions and revised forecast' },
      ],
      priorities: [
        { priority: 1, action: 'Identify highest-contribution hero products', kpi: 'Contribution margin by SKU' },
        { priority: 2, action: 'Acquire qualified customers in target sectors', kpi: 'CAC, conversion rate, new customers' },
        { priority: 3, action: 'Build repeat sales and accessories attachment', kpi: 'Repeat rate, AOV, attachment rate' },
        { priority: 4, action: 'Test channel partnerships without excessive stock risk', kpi: 'Contribution by channel' },
        { priority: 5, action: 'Review monthly financial and marketing performance', kpi: 'Marketing spend %, gross and net margins' },
      ],
    },
    financialCommentary: {
      performance: '2026 turnover changed by -21.3% year on year. Gross margin changed by -7.6 percentage points. Net profit changed by -37.5%. The business remains profitable, but lower revenue and weaker gross margin create pressure on marketing capacity.',
      productSales: 'Handbags remain the primary sales engine. Backpacks have the sharpest decline among major bag categories. Accessories & Other grew, suggesting a cross-selling and gifting opportunity. Product revenue figures are before general discounts and exclude shipping and other income.',
      marketingEfficiency: 'Marketing expenditure has fallen considerably. This may affect reach and acquisition, but financial statements alone do not prove that the reduction caused declining sales. Restart investment through measured tests rather than committing to a large fixed budget.',
      costActions: [
        'Audit fulfilment cost by order and geography',
        'Review platform subscriptions and development return',
        'Review ageing, stock turns and replenishment',
        'Confirm nature and recurrence before setting marketing targets',
      ],
      actionPlan: [
        'Calculate merchandise margin and contribution after payment, fulfilment, return and advertising costs by SKU.',
        'Review supplier costs, freight, duties, pricing and discount policy to restore margin.',
        'Identify slow-moving stock and protect cash conversion.',
        'Set campaign-level maximum CAC using incremental contribution rather than revenue-based ROAS alone.',
        'Monitor monthly revenue, gross margin, net margin, marketing intensity and working capital.',
      ],
      conclusion: 'Connect product profitability, sector-led acquisition and retention into one commercial operating model. Prioritise handbags, build accessory attachment, test backpack demand before scaling and increase advertising only where incremental contribution and cash flow support it.',
    },
  },
  financials: {
    currency: 'GBP',
    years: [
      {
        label: '2024', periodStart: '2023-10-01', periodEnd: '2024-09-30', partial: false,
        turnover: '1633422.00', costOfSales: '937075.00', costOfSalesPct: '57.4', grossProfit: '696347.00', grossProfitPct: '42.6',
        adminCosts: '379997.00', netProfit: '229727.00', netProfitPct: '14.1', marketingSpend: '119729.00', marketingPct: '7.3',
      },
      {
        label: '2025', periodStart: '2024-10-01', periodEnd: '2025-09-30', partial: false,
        turnover: '895231.00', costOfSales: '415616.00', costOfSalesPct: '46.4', grossProfit: '479615.00', grossProfitPct: '53.6',
        adminCosts: '333246.00', netProfit: '104806.00', netProfitPct: '11.7', marketingSpend: '36939.00', marketingPct: '4.1',
      },
      {
        label: '2026', periodStart: '2025-10-01', periodEnd: '2026-09-30', partial: false,
        turnover: '704530.00', costOfSales: '380512.00', costOfSalesPct: '54.0', grossProfit: '324018.00', grossProfitPct: '46.0',
        adminCosts: '233608.00', netProfit: '65542.00', netProfitPct: '9.3', marketingSpend: '19296.00', marketingPct: '2.7',
      },
    ],
    productSales: {
      previousLabel: '2025',
      currentLabel: '2026',
      rows: [
        { product: 'Handbags', previous: '559565.00', current: '437128.00', changePct: '-21.9' },
        { product: 'Backpacks', previous: '155388.00', current: '104979.00', changePct: '-32.4' },
        { product: 'Satchels', previous: '73365.00', current: '56611.00', changePct: '-22.8' },
        { product: 'Accessories & Other', previous: '59782.00', current: '70446.00', changePct: '17.8' },
        { product: 'Wallets', previous: '17436.00', current: '15940.00', changePct: '-8.6' },
        { product: 'Embossing', previous: '15789.00', current: '12515.00', changePct: '-20.7' },
      ],
    },
    costLines: [
      { name: 'Transportation & distribution', amount: '79086.00' },
      { name: 'Websites & IT', amount: '20049.00' },
      { name: 'Closing inventory', amount: '102890.00' },
      { name: 'Other income', amount: '80381.00' },
    ],
    sourceNote: 'Financial years ended 30 September 2024, 2025 and 2026. All figures GBP. Source: Beara Beara Ltd Profit and Loss workbook supplied for this review. The workbook contains zero-valued subtotal cells; totals below have been reconstructed from detailed ledger lines.',
  },
  sources: [
    { label: 'Beara Beara website', url: 'https://www.bearabeara.co.uk/' },
    { label: 'Beara Beara Instagram', url: 'https://www.instagram.com/beara_beara/' },
    { label: 'Cambridge Satchel', url: 'https://cambridgesatchel.com' },
    { label: 'O My Bag Amsterdam', url: 'https://omybagamsterdam.com' },
    { label: 'SMAAK Amsterdam', url: 'https://smaakamsterdam.com' },
    { label: 'Fossil', url: 'https://fossil.com' },
    { label: 'Beara Beara Ltd Profit and Loss workbook (FY2024–FY2026)', url: '' },
  ],
  model: 'gpt-5',
  promptVersion: 'marketing-prompt-v1',
};

/** The same report for a company with no figures yet: no Section 03 tables, no commentary. */
export const SAMPLE_REPORT_WITHOUT_FIGURES: MarketingReport = {
  ...SAMPLE_MARKETING_REPORT,
  narrative: { ...SAMPLE_MARKETING_REPORT.narrative, financialCommentary: null },
  financials: null,
};
