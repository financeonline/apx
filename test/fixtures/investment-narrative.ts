import type { InvestmentNarrative } from '@/modules/investment';
import type { CompanyProfile } from '@/modules/marketing';

/**
 * ADR-171 fixture: the client's own example pack (the "Investment Strategy & Financial Growth Plan",
 * October 2026) as an `InvestmentNarrative` that passes every check with `CLIENT_FIGURES` and the UK
 * playbook. Its words are the client's, with three changes the contract needs:
 *
 *   - the example's iShares PRODUCT pages (a single named bond fund, and an ETF listing) are replaced
 *     by the provider's homepage — a pack cites only the playbook's pages, never a fund to buy;
 *   - the comparison is the SOW's ("at 10% year on year your net return would be X …"), which the
 *     example does not have, written as the prompt asks;
 *   - "Defend the achieved 20% growth rate" stays: 20% is the base case in the figures.
 *
 * Tests copy and break this.
 */

export const CLIENT_PROFILE: CompanyProfile = {
  website: 'https://www.example-goods.co.uk/',
  socialLinks: [],
  productsServices: 'Premium consumer products, sold online and through wholesale partners',
  industry: 'Consumer goods',
  description: 'A UK company that has delivered 20% year-on-year growth and met its growth plan.',
};

export function validInvestmentNarrative(): InvestmentNarrative {
  return {
    objective: 'Convert the company’s achieved 20% year-on-year growth into sustainable shareholder value through disciplined reinvestment and a diversified external investment programme.',
    growthToSurplus: 'A company delivering consistent 20% growth can generate rising annual profits when margins remain stable. Management should distinguish accounting profits from investable free cash after tax, working capital, debt service and capital expenditure. By Year 5, illustrative annual net profit rises to approximately £311,000. This does not imply that the full amount is available for investment.',
    reinvestment: 'Prioritise opportunities where management has direct commercial influence. A 20% growth rate is the base case, 35% is the acceleration case, and 50% is a stretch case requiring evidence of demand, capacity and funding. Illustrations use £1m starting annual revenue and a constant 15% net profit margin. Year 5 follows four annual growth periods. Growth is not the same as investment return.',
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
      { name: 'Investment-grade bond funds', risk: 'low_medium', description: 'Diversified debt exposure; subject to interest-rate and credit risk.', referenceUrl: 'https://www.ishares.com/' },
      { name: 'Global equity index funds', risk: 'higher', description: 'Broad exposure to listed global companies for long-term capital growth.', referenceUrl: 'https://www.vanguard.co.uk/' },
      { name: 'Growth shares & sector ETFs', risk: 'high', description: 'Selective technology, automation, healthcare or infrastructure exposure.', referenceUrl: 'https://www.ishares.com/' },
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
    comparison: 'Invested at an illustrative 10% a year for three years, the £35,000 external allocation would grow to £46,585, a gain of £11,585 before fees and taxes. To earn the same £11,585 as net profit at the current 15% net margin, the business would need £77,233 of additional sales. On these illustrative figures, a diversified portfolio puts this amount to work more efficiently than the equivalent sales effort, though its returns are not guaranteed and core-business projects with evidence of demand remain the first call on capital.',
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
    references: [
      { label: 'UK Debt Management Office', url: 'https://www.dmo.gov.uk/' },
      { label: 'Financial Services Compensation Scheme', url: 'https://www.fscs.org.uk/' },
      { label: 'iShares', url: 'https://www.ishares.com/' },
      { label: 'Vanguard UK', url: 'https://www.vanguard.co.uk/' },
      { label: 'British Business Bank', url: 'https://www.british-business-bank.co.uk/' },
      { label: 'Financial Conduct Authority', url: 'https://www.fca.org.uk/' },
    ],
  };
}
