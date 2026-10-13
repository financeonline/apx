/**
 * The Investment Pack (ADR-171), shaped section by section on the client's own example (the
 * "Investment Strategy & Financial Growth Plan — Investment Pack", October 2026): a cover with the
 * strategic objective and the two headline aims, the executive capital allocation, 01 converting
 * growth into surplus capital, 02 reinvesting in the core business, 03 external investment
 * opportunities (options, an illustrative portfolio, return scenarios), the capital allocation
 * process, 04 governance and investment controls, 05 the investment committee recommendation, the
 * reference links and the "illustrative" notice.
 *
 * Every NUMBER is APX's own arithmetic on the company's figures (`InvestmentFigures`) — growth
 * paths, the surplus split, portfolio amounts, return scenarios. ChatGPT writes only the words and
 * chooses the options and the portfolio's asset classes and shares (`InvestmentNarrative`); it never
 * produces a figure. Stage 1 is deliberately basic (SOW: "a very basic level of analysis that
 * recommends via AI what is possible to a business like this"); it is illustrative, never advice.
 *
 * Money and percentages are decimal strings (the product's convention: no floats on money).
 */

import type { CompanyProfile, SocialLink } from '@/modules/marketing';

/* ------------------------------------------------------------------------------------------------ */
/* What APX works out (no AI)                                                                       */
/* ------------------------------------------------------------------------------------------------ */

/** The company's latest year, the starting point of every projection. */
export interface InvestmentBase {
  readonly currency: string;
  /** "2026" or "2026 (9 months, annualised)". */
  readonly yearLabel: string;
  /** Turnover for a full year (annualised from the months held when the year is partial). */
  readonly revenue: string;
  /** Net profit for the same full year (annualised likewise). */
  readonly netProfit: string;
  /** Net profit as % of revenue, one decimal place. */
  readonly netMarginPct: string;
  /** True when the year held fewer than twelve months and the figures were scaled to twelve. */
  readonly annualised: boolean;
  /** Where the figures came from, in plain words. */
  readonly sourceNote: string;
}

export type SurplusSource = 'net_profit' | 'analyst';

/** The assumptions the pack is built on; the defaults are the client's own example's. */
export interface InvestmentAssumptions {
  /** The distributable surplus the pack allocates. */
  readonly surplus: string;
  /** `net_profit`: the base year's net profit; `analyst`: an amount the analyst entered. */
  readonly surplusSource: SurplusSource;
  /** Base, acceleration and stretch annual growth, whole percent: ["20", "35", "50"]. */
  readonly growthRates: readonly [string, string, string];
  /** The illustrative long-term annual return target, whole percent: "10". */
  readonly targetReturnPct: string;
  /** How the surplus is split, whole percent adding to 100: business 45, external 35, liquidity 20. */
  readonly split: { readonly business: string; readonly external: string; readonly liquidity: string };
  /** The return scenarios for the external portfolio, whole percent: ["4", "10", "15"]. */
  readonly returnRates: readonly [string, string, string];
  /** Years projected: 5. */
  readonly horizonYears: number;
}

export interface Amount {
  /** Whole percent as a string. */
  readonly percent: string;
  readonly amount: string;
}

/** One year of a projection. Year 1 is the base year's figures; each later year grows by the rate. */
export interface ProjectionYear {
  /** "Year 1" … "Year 5". */
  readonly label: string;
  readonly revenue: string;
  readonly netProfit: string;
}

export interface GrowthScenario {
  /** Whole percent: "20". */
  readonly growthPct: string;
  /** "Base case" | "Acceleration case" | "Stretch case". */
  readonly name: string;
  readonly years: readonly ProjectionYear[];
}

export interface ReturnScenario {
  /** Whole percent: "10". */
  readonly ratePct: string;
  readonly startAmount: string;
  /** The value at the end of each year, years 1..horizon, compounding annually, no withdrawals. */
  readonly values: readonly string[];
  readonly finalValue: string;
  readonly gain: string;
}

/**
 * The SOW's comparison: the external allocation invested for three years at the target return,
 * against what the business would need to make the same return from it.
 */
export interface ReinvestComparison {
  readonly years: number;
  readonly ratePct: string;
  readonly amount: string;
  readonly value: string;
  readonly gain: string;
  /** The base year's net margin: the sales the business would need to earn `gain` as net profit. */
  readonly salesNeededForSameGain: string | null;
}

export interface InvestmentFigures {
  readonly base: InvestmentBase;
  readonly assumptions: InvestmentAssumptions;
  /** The surplus split: business growth, external investments, additional liquidity. */
  readonly allocation: { readonly business: Amount; readonly external: Amount; readonly liquidity: Amount };
  /** 01: the base case (growthRates[0]) over the horizon. */
  readonly baseCase: GrowthScenario;
  /** 02: the three growth scenarios at a constant net margin. */
  readonly growthScenarios: readonly [GrowthScenario, GrowthScenario, GrowthScenario];
  /** 03: the three return scenarios, on the external allocation. */
  readonly returnScenarios: readonly [ReturnScenario, ReturnScenario, ReturnScenario];
  readonly comparison: ReinvestComparison;
}

/* ------------------------------------------------------------------------------------------------ */
/* What ChatGPT writes                                                                              */
/* ------------------------------------------------------------------------------------------------ */

export type RiskLevel = 'lower' | 'low_medium' | 'medium' | 'higher' | 'high' | 'very_high';

export interface InvestmentLever {
  /** "Customer acquisition". */
  readonly lever: string;
  readonly action: string;
  readonly measure: string;
}

export interface InvestmentOption {
  /** "Cash deposits & short-dated gilts". */
  readonly name: string;
  readonly risk: RiskLevel;
  /** One or two sentences. */
  readonly description: string;
  /** A reference page (a regulator, a provider's public page); null when none fits. */
  readonly referenceUrl: string | null;
}

export interface PortfolioShare {
  /** "Global equity funds". */
  readonly assetClass: string;
  /** Whole percent as a string; the shares add up to 100. */
  readonly percent: string;
  readonly risk: RiskLevel;
}

export interface ProcessStage {
  readonly stage: number;
  readonly action: string;
  /** "Month 1", "Months 3–6", "Quarterly". */
  readonly timing: string;
}

export interface CommitteePriority {
  /** "Protect growth". */
  readonly title: string;
  readonly text: string;
}

export interface InvestmentNarrative {
  /** The strategic objective on the cover, one or two sentences. */
  readonly objective: string;
  /** 01: how growth becomes surplus capital (accounting profit is not investable free cash). */
  readonly growthToSurplus: string;
  /** 02: the reinvestment approach (base, acceleration and stretch cases). */
  readonly reinvestment: string;
  /** 02: the investment levers table (4–6). */
  readonly levers: readonly InvestmentLever[];
  /** 03: the introduction to the external options. */
  readonly externalIntro: string;
  /** 03: three to five options from lower to very high risk. */
  readonly options: readonly InvestmentOption[];
  /** 03: the illustrative diversified portfolio (asset classes and shares). */
  readonly portfolio: readonly PortfolioShare[];
  /** Under the portfolio: "This is a diversified growth illustration, not a guaranteed …". */
  readonly portfolioNote: string;
  /** The SOW's comparison, in words, restating only the figures given. */
  readonly comparison: string;
  /** The capital allocation process (5–7 stages). */
  readonly process: readonly ProcessStage[];
  /** 04: governance and investment controls (4–8 bullets). */
  readonly governance: readonly string[];
  /** 05: the investment committee recommendation (exactly four priorities). */
  readonly recommendation: readonly CommitteePriority[];
  /** Reference links (regulators, protection schemes, providers' public pages). */
  readonly references: readonly SocialLink[];
}

/* ------------------------------------------------------------------------------------------------ */
/* The whole pack                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

export const INVESTMENT_REPORT_VERSION = 'investment-v1';

/** The fixed notice at the end of every pack, whoever wrote the words. */
export const INVESTMENT_DISCLAIMER =
  'Important: all financial amounts, capital allocations, growth and investment returns are illustrative '
  + 'scenarios, not financial advice or a recommendation to buy any investment. Returns are not guaranteed and '
  + 'may be negative. The strategy needs confirming against the company’s actual accounts, cash flows, '
  + 'investment horizon, jurisdiction and risk capacity, with a regulated financial adviser.';

export interface InvestmentReport {
  readonly version: typeof INVESTMENT_REPORT_VERSION;
  readonly organisationName: string;
  /** ISO timestamp. */
  readonly generatedAt: string;
  /** "October 2026", for the cover. */
  readonly reportDate: string;
  readonly profile: CompanyProfile;
  readonly figures: InvestmentFigures;
  readonly narrative: InvestmentNarrative;
  /** The portfolio with amounts: the narrative's shares applied to the external allocation by APX. */
  readonly portfolio: readonly (PortfolioShare & { readonly amount: string })[];
  /** References, deduplicated, plus the source of the figures (url '' for a label-only source). */
  readonly sources: readonly SocialLink[];
  readonly model: string;
  readonly promptVersion: string;
}

export type InvestmentReportStatus = 'none' | 'queued' | 'running' | 'ready' | 'failed';

export interface InvestmentView {
  readonly organisationName: string;
  readonly currency: string;
  readonly profile: CompanyProfile;
  /**
   * The base year and the surplus APX would use by default; null when APX holds no full figures. When
   * the base year shows no profit, `defaultSurplus` is null and the analyst must enter an amount.
   */
  readonly base: InvestmentBase | null;
  readonly defaultSurplus: string | null;
  readonly status: InvestmentReportStatus;
  /** The latest successful pack, also while a refresh is queued or running. */
  readonly report: InvestmentReport | null;
  readonly failure: string | null;
  readonly canRefresh: boolean;
  readonly canEditProfile: boolean;
}
