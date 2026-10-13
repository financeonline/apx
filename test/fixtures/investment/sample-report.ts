import {
  INVESTMENT_REPORT_VERSION, type GrowthScenario, type InvestmentReport,
} from '../../../src/modules/investment/domain/types';

/**
 * The client's own example, transcribed into the pack contract (ADR-171): "Investment Strategy &
 * Financial Growth Plan — Investment Pack", October 2026, the document the Investment Pack is shaped
 * on. Every sentence is the client's, and so is every figure the contract carries the same way —
 * £1,000,000 revenue at a 15% net margin, the illustrative £100,000 surplus split 45/35/20, the
 * growth scenarios to £2,073,600, £3,321,506 and £5,062,500, the £35,000 portfolio — so a renderer
 * test can assert on text the client will recognise.
 *
 * One difference, and it is the contract's: the client's example ran the three return scenarios on
 * the whole £100,000, while APX runs them on the external allocation (`returnScenarios`, "on the
 * external allocation"), so those rows are APX's arithmetic on £35,000 (Decimal, two places). The
 * SOW's reinvest-versus-invest comparison has no counterpart in the example; its sentence is written
 * from the same figures.
 *
 * The example's £100,000 is not the year's £150,000 net profit, so its surplus is one the analyst
 * entered (`surplusSource: 'analyst'`). Money is two places and percentages whole or one place, as
 * the data side produces them.
 */

const scenario = (growthPct: string, name: string, years: readonly (readonly [string, string])[]): GrowthScenario => ({
  growthPct,
  name,
  years: years.map(([revenue, netProfit], i) => ({ label: `Year ${i + 1}`, revenue, netProfit })),
});

const BASE_CASE = scenario('20', 'Base case', [
  ['1000000.00', '150000.00'], ['1200000.00', '180000.00'], ['1440000.00', '216000.00'], ['1728000.00', '259200.00'], ['2073600.00', '311040.00'],
]);
const ACCELERATION = scenario('35', 'Acceleration case', [
  ['1000000.00', '150000.00'], ['1350000.00', '202500.00'], ['1822500.00', '273375.00'], ['2460375.00', '369056.25'], ['3321506.25', '498225.94'],
]);
const STRETCH = scenario('50', 'Stretch case', [
  ['1000000.00', '150000.00'], ['1500000.00', '225000.00'], ['2250000.00', '337500.00'], ['3375000.00', '506250.00'], ['5062500.00', '759375.00'],
]);

const REFERENCES = [
  { label: 'UK Debt Management Office', url: 'https://www.dmo.gov.uk/' },
  { label: 'Financial Services Compensation Scheme', url: 'https://www.fscs.org.uk/' },
  { label: 'iShares Global Aggregate Bond UCITS ETF', url: 'https://www.ishares.com/uk/individual/en/products/291773/ishares-global-aggregate-bond-ucits-etf-fund' },
  { label: 'Vanguard UK', url: 'https://www.vanguard.co.uk/' },
  { label: 'British Business Bank', url: 'https://www.british-business-bank.co.uk/' },
  { label: 'Financial Conduct Authority', url: 'https://www.fca.org.uk/' },
] as const;

export const SAMPLE_INVESTMENT_REPORT: InvestmentReport = {
  version: INVESTMENT_REPORT_VERSION,
  organisationName: 'Northwind Trading Ltd',
  generatedAt: '2026-10-14T09:30:00.000Z',
  reportDate: 'October 2026',
  profile: {
    website: 'https://www.northwind.example/',
    socialLinks: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/company/northwind-example/' }],
    productsServices: 'Premium homeware',
    industry: 'Homeware retail and wholesale',
    description: 'A UK homeware business that has grown 20% a year.',
  },
  figures: {
    base: {
      currency: 'GBP',
      yearLabel: '2026',
      revenue: '1000000.00',
      netProfit: '150000.00',
      netMarginPct: '15.0',
      annualised: false,
      sourceNote: 'The company’s figures in APX for the year to 30 September 2026.',
    },
    assumptions: {
      surplus: '100000.00',
      surplusSource: 'analyst',
      growthRates: ['20', '35', '50'],
      targetReturnPct: '10',
      split: { business: '45', external: '35', liquidity: '20' },
      returnRates: ['4', '10', '15'],
      horizonYears: 5,
    },
    allocation: {
      business: { percent: '45', amount: '45000.00' },
      external: { percent: '35', amount: '35000.00' },
      liquidity: { percent: '20', amount: '20000.00' },
    },
    baseCase: BASE_CASE,
    growthScenarios: [BASE_CASE, ACCELERATION, STRETCH],
    returnScenarios: [
      { ratePct: '4', startAmount: '35000.00', values: ['36400.00', '37856.00', '39370.24', '40945.05', '42582.85'], finalValue: '42582.85', gain: '7582.85' },
      { ratePct: '10', startAmount: '35000.00', values: ['38500.00', '42350.00', '46585.00', '51243.50', '56367.85'], finalValue: '56367.85', gain: '21367.85' },
      { ratePct: '15', startAmount: '35000.00', values: ['40250.00', '46287.50', '53230.63', '61215.22', '70397.50'], finalValue: '70397.50', gain: '35397.50' },
    ],
    comparison: {
      years: 3, ratePct: '10', amount: '35000.00', value: '46585.00', gain: '11585.00', salesNeededForSameGain: '77233.33',
    },
  },
  narrative: {
    objective: 'Strategic objective: Convert the company’s achieved 20% year-on-year growth into sustainable shareholder value through disciplined reinvestment and a diversified external investment programme.',
    growthToSurplus: 'A company delivering consistent 20% growth can generate rising annual profits when margins remain stable. Management should distinguish accounting profits from investable free cash after tax, working capital, debt service and capital expenditure.',
    reinvestment: 'Prioritise opportunities where management has direct commercial influence. A 20% growth rate is the base case, 35% is the acceleration case, and 50% is a stretch case requiring evidence of demand, capacity and funding.',
    levers: [
      { lever: 'Customer acquisition', action: 'Targeted marketing, conversion and distribution', measure: 'Acquisition cost; contribution' },
      { lever: 'Product expansion', action: 'Complementary and premium product lines', measure: 'Gross margin; stock turnover' },
      { lever: 'Geographic expansion', action: 'New UK and international channels', measure: 'Market-level profitability' },
      { lever: 'Operational efficiency', action: 'Automation, purchasing and inventory controls', measure: 'Cash conversion; margin' },
      { lever: 'Partnerships', action: 'Wholesale and strategic distribution', measure: 'Incremental return on capital' },
    ],
    externalIntro: 'Five possible investment routes span lower-risk liquidity instruments through higher-risk private company investments. The portfolio should not depend on a 10% return every year; volatility, losses, fees and taxes matter.',
    options: [
      { name: 'Cash deposits & short-dated gilts', risk: 'lower', description: 'Preserve capital and liquidity; yields vary.', referenceUrl: 'https://www.dmo.gov.uk/' },
      { name: 'Investment-grade bond funds', risk: 'low_medium', description: 'Diversified debt exposure; subject to interest-rate and credit risk.', referenceUrl: 'https://www.ishares.com/uk/individual/en/products/291773/ishares-global-aggregate-bond-ucits-etf-fund' },
      { name: 'Global equity index funds', risk: 'higher', description: 'Broad exposure to listed global companies for long-term capital growth.', referenceUrl: 'https://www.vanguard.co.uk/' },
      { name: 'Growth shares & sector ETFs', risk: 'high', description: 'Selective technology, automation, healthcare or infrastructure exposure.', referenceUrl: 'https://www.ishares.com/uk/individual/en/products/etf-investments' },
      { name: 'Minority stakes in businesses', risk: 'very_high', description: 'Potential commercial synergies; illiquidity and total loss are possible.', referenceUrl: 'https://www.british-business-bank.co.uk/' },
    ],
    portfolio: [
      { assetClass: 'Global equity funds', percent: '45', risk: 'higher' },
      { assetClass: 'Investment-grade bond funds', percent: '25', risk: 'low_medium' },
      { assetClass: 'Cash and gilts', percent: '20', risk: 'lower' },
      { assetClass: 'Growth shares / sector ETFs', percent: '5', risk: 'high' },
      { assetClass: 'Private investments', percent: '5', risk: 'very_high' },
    ],
    portfolioNote: 'This is a diversified growth illustration, not a guaranteed 10% portfolio. High-risk investments are limited to 10% of the external allocation.',
    comparison: 'Invested externally, the £35,000 allocation would be worth about £46,585 after three years at 10% a year, a gain of £11,585. Earning the same from the business at a 15% net margin would take about £77,233 of additional sales.',
    process: [
      { stage: 1, action: 'Confirm free cash, reserves and tax obligations', timing: 'Month 1' },
      { stage: 2, action: 'Approve measurable core-business projects', timing: 'Months 1–2' },
      { stage: 3, action: 'Select regulated providers and corporate accounts', timing: 'Months 2–3' },
      { stage: 4, action: 'Deploy investment capital in tranches', timing: 'Months 3–6' },
      { stage: 5, action: 'Review performance, liquidity and risk', timing: 'Quarterly' },
      { stage: 6, action: 'Rebalance based on risk-adjusted outcomes', timing: 'Annually' },
    ],
    governance: [
      'Maintain minimum operating cash reserves before allocating surplus.',
      'Do not fund long-term assets with short-term working capital.',
      'Set concentration limits and formal approval thresholds.',
      'Review performance net of fees, taxes and foreign-exchange movements.',
      'Seek advice on corporate tax, investment structure and trading status.',
      'Measure business reinvestment against incremental cash flows and payback periods.',
    ],
    recommendation: [
      { title: 'Protect growth', text: 'Defend the achieved 20% growth rate and operating liquidity.' },
      { title: 'Accelerate expansion', text: 'Deploy 45% of investable surplus to projects supporting 35–50% growth where evidence justifies it.' },
      { title: 'Diversify wealth creation', text: 'Allocate 35% to an external portfolio; use 10% as an aspirational scenario, not a promise.' },
      { title: 'Preserve flexibility', text: 'Retain 20% additional liquidity beyond the operating reserve.' },
    ],
    references: [...REFERENCES],
  },
  portfolio: [
    { assetClass: 'Global equity funds', percent: '45', risk: 'higher', amount: '15750.00' },
    { assetClass: 'Investment-grade bond funds', percent: '25', risk: 'low_medium', amount: '8750.00' },
    { assetClass: 'Cash and gilts', percent: '20', risk: 'lower', amount: '7000.00' },
    { assetClass: 'Growth shares / sector ETFs', percent: '5', risk: 'high', amount: '1750.00' },
    { assetClass: 'Private investments', percent: '5', risk: 'very_high', amount: '1750.00' },
  ],
  sources: [
    ...REFERENCES,
    { label: 'Figures: the company’s records in APX, year to 30 September 2026', url: '' },
  ],
  model: 'gpt-5',
  promptVersion: 'investment-prompt-v1',
};

/**
 * The same pack with every optional part absent: no reference link on any option, no net margin to
 * compare sales with, no sources or reference links, an empty company profile beyond what it sells,
 * and a part year scaled to twelve months — the shape a sparse company produces. The figures are
 * otherwise the example's, so the two packs differ only where the optional parts were.
 */
export const SAMPLE_PACK_WITHOUT_OPTIONALS: InvestmentReport = {
  ...SAMPLE_INVESTMENT_REPORT,
  profile: { website: null, socialLinks: [], productsServices: 'Premium homeware', industry: null, description: null },
  figures: {
    ...SAMPLE_INVESTMENT_REPORT.figures,
    base: { ...SAMPLE_INVESTMENT_REPORT.figures.base, yearLabel: '2026 (9 months, annualised)', annualised: true },
    comparison: { ...SAMPLE_INVESTMENT_REPORT.figures.comparison, salesNeededForSameGain: null },
  },
  narrative: {
    ...SAMPLE_INVESTMENT_REPORT.narrative,
    options: SAMPLE_INVESTMENT_REPORT.narrative.options.map((option) => ({ ...option, referenceUrl: null })),
    references: [],
  },
  sources: [],
};
