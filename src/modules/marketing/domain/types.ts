/**
 * The Marketing report (ADR-170), shaped section by section on the client's own example (the "Beara
 * Beara Marketing Strategy" document, October 2026): a cover, an executive overview, Section 01
 * (competitors and customer sectors — also the Competitive Readiness card), Section 02 (marketing and
 * growth strategy), Section 03 (financial overview and performance review) and the sources.
 *
 * Sections 01 and 02 and the commentary of Section 03 are written by the AI from the company profile
 * and the figures; Section 03's tables are the product's own figures, never the model's. Stage 1 is
 * deliberately generic by industry (owner and client, 2026-10-09): competitors are directional, not
 * verified, and the report says so.
 *
 * Money and percentages are decimal strings (the product's convention: no floats on money).
 */

/** The company profile the analyst fills in once; Marketing reads it (and later Investment). */
export interface CompanyProfile {
  readonly website: string | null;
  /** Instagram, LinkedIn, TikTok… in the order the analyst entered them. */
  readonly socialLinks: readonly SocialLink[];
  /** What the company sells, in the analyst's words ("Luxury leather bags"). */
  readonly productsServices: string | null;
  /** The industry in plain words ("Luxury leather accessories"). */
  readonly industry: string | null;
  /** A short history or description of the business. */
  readonly description: string | null;
}

export interface SocialLink {
  readonly label: string;
  readonly url: string;
}

/** True when the profile holds enough for a report: what the company sells, or its industry. */
export function profileIsReady(profile: CompanyProfile): boolean {
  return Boolean(profile.productsServices?.trim() || profile.industry?.trim());
}

/* ------------------------------------------------------------------------------------------------ */
/* Section 01 — Competitor & sector profiling                                                       */
/* ------------------------------------------------------------------------------------------------ */

export interface Competitor {
  /** "Cambridge Satchel". */
  readonly name: string;
  /** "direct heritage competitor". */
  readonly positioning: string;
  /** What the company can learn from them. */
  readonly learning: string;
  readonly website: string | null;
  readonly social: string | null;
}

export interface CustomerSector {
  readonly sector: string;
  /** Profile / purchase trigger. */
  readonly profile: string;
  readonly campaignDirection: string;
}

export interface SectorShare {
  readonly sector: string;
  /** Whole percent as a string ("35"); the shares add up to 100. */
  readonly percent: string;
}

export interface CompetitorSection {
  /** 1.1 Brand positioning. */
  readonly brandPositioning: string;
  /** 1.2 Comparable competitor benchmarks (3–6). */
  readonly competitors: readonly Competitor[];
  /** "These brands are directional comparators, not a ranking…". */
  readonly competitorNote: string;
  /** 1.3 Customer-sector strategy (3–7). */
  readonly customerSectors: readonly CustomerSector[];
  /** The proposed effort split across the sectors. */
  readonly effortSplit: readonly SectorShare[];
  /** Any note on the split ("International audiences are a geographic overlay…"). */
  readonly effortNote: string | null;
}

/* ------------------------------------------------------------------------------------------------ */
/* Section 02 — Marketing & growth strategy                                                          */
/* ------------------------------------------------------------------------------------------------ */

export interface ProductCampaign {
  /** Product sector ("Handbags"). */
  readonly product: string;
  readonly positioning: string;
  readonly execution: string;
}

export interface CampaignConcept {
  /** "The Bag and Its Story". */
  readonly title: string;
  readonly description: string;
  /** What it is for ("Brand awareness and differentiation"). */
  readonly purpose: string;
}

export interface BudgetLine {
  readonly channel: string;
  /** Whole percent as a string; the lines add up to 100. */
  readonly percent: string;
  readonly purpose: string;
}

export interface PlanPeriod {
  /** "Days 1–30". */
  readonly period: string;
  readonly activities: string;
  readonly deliverable: string;
}

export interface Priority {
  readonly priority: number;
  readonly action: string;
  readonly kpi: string;
}

export interface StrategySection {
  /** 2.1 Strategy A — Digital customer acquisition (bullets). */
  readonly digitalAcquisition: readonly string[];
  /** 2.2 Strategy B — Product-led campaigns (table). */
  readonly productCampaigns: readonly ProductCampaign[];
  /** 2.3 Strategy C — Retention & basket value (bullets). */
  readonly retention: readonly string[];
  /** 2.4 Alternative campaign concepts (3–4). */
  readonly concepts: readonly CampaignConcept[];
  /** "Recommended combination: …". */
  readonly recommendedCombination: string;
  /** 2.5 Illustrative marketing budget allocation. */
  readonly budget: readonly BudgetLine[];
  /** "Example: a £3,000 monthly test budget… This is an illustrative allocation…". */
  readonly budgetNote: string;
  /** 2.6 First 90 days (three periods). */
  readonly first90Days: readonly PlanPeriod[];
  /** 2.7 Management priorities and KPIs (about five). */
  readonly priorities: readonly Priority[];
}

/* ------------------------------------------------------------------------------------------------ */
/* Section 03 — Financial overview & performance review (the product's figures)                     */
/* ------------------------------------------------------------------------------------------------ */

/** One financial year (or the year to date) in the overview table. Null where the data has no value. */
export interface FinancialYear {
  /** "2026" or "FY2026" or "2026 (to Sep)". */
  readonly label: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** True when the year has fewer than twelve complete months of data. */
  readonly partial: boolean;
  readonly turnover: string | null;
  readonly costOfSales: string | null;
  readonly costOfSalesPct: string | null;
  readonly grossProfit: string | null;
  readonly grossProfitPct: string | null;
  readonly adminCosts: string | null;
  readonly netProfit: string | null;
  readonly netProfitPct: string | null;
  /** Advertising & marketing spend, where the accounts or campaigns show it. */
  readonly marketingSpend: string | null;
  readonly marketingPct: string | null;
}

/** 3.2 Product-sector sales, the last two years. */
export interface ProductSales {
  readonly product: string;
  readonly previous: string | null;
  readonly current: string | null;
  readonly changePct: string | null;
}

/** 3.4 Cost and margin review: the largest cost lines of the latest year. */
export interface CostLine {
  readonly name: string;
  readonly amount: string;
}

export interface MarketingFinancials {
  readonly currency: string;
  /** Oldest first; at most three. */
  readonly years: readonly FinancialYear[];
  /** Null when the data has no product or category sales. */
  readonly productSales: { readonly previousLabel: string; readonly currentLabel: string; readonly rows: readonly ProductSales[] } | null;
  readonly costLines: readonly CostLine[];
  /** "All figures GBP. Source: …" — where the figures came from, in plain words. */
  readonly sourceNote: string;
}

/** The AI's reading of Section 03's figures. It may only restate figures that are in the tables. */
export interface FinancialCommentary {
  /** 3.1 Three-year performance. */
  readonly performance: string;
  /** Under 3.2. */
  readonly productSales: string | null;
  /** Under 3.3 Marketing expenditure and cost efficiency. */
  readonly marketingEfficiency: string;
  /** One commercial action per cost line in 3.4, in the same order. */
  readonly costActions: readonly string[];
  /** 3.5 Financial management action plan (bullets). */
  readonly actionPlan: readonly string[];
  /** "Financial conclusion and strategic recommendation". */
  readonly conclusion: string;
}

/* ------------------------------------------------------------------------------------------------ */
/* The whole report                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

/** What the model writes (Sections 01, 02, the overview and the Section 03 commentary). */
export interface MarketingNarrative {
  /** Executive overview: the strategic objective, one paragraph. */
  readonly objective: string;
  /** "The strategy is structured in the same sequence as…" — how to read the report. */
  readonly overview: string;
  readonly competitors: CompetitorSection;
  readonly strategy: StrategySection;
  /** Null when there are no figures to comment on. */
  readonly financialCommentary: FinancialCommentary | null;
}

export const MARKETING_REPORT_VERSION = 'marketing-v1';

export interface MarketingReport {
  readonly version: typeof MARKETING_REPORT_VERSION;
  readonly organisationName: string;
  /** ISO timestamp. */
  readonly generatedAt: string;
  /** "October 2026", for the cover. */
  readonly reportDate: string;
  readonly profile: CompanyProfile;
  readonly narrative: MarketingNarrative;
  /** Null when the company has no figures yet; the report then has no Section 03 tables. */
  readonly financials: MarketingFinancials | null;
  /** Website, social and competitor links, plus the source of the figures. */
  readonly sources: readonly SocialLink[];
  readonly model: string;
  readonly promptVersion: string;
}

/** The report's state for one organisation, as the page shows it. */
export type MarketingReportStatus = 'none' | 'queued' | 'running' | 'ready' | 'failed';

export interface MarketingView {
  readonly organisationName: string;
  readonly profile: CompanyProfile;
  readonly profileReady: boolean;
  readonly status: MarketingReportStatus;
  /** The latest successful report, also while a refresh is queued or running. */
  readonly report: MarketingReport | null;
  /** Shown when the last attempt failed. */
  readonly failure: string | null;
  /** Whether the viewer may create or refresh the report. */
  readonly canRefresh: boolean;
  /** Whether the viewer may edit the company profile. */
  readonly canEditProfile: boolean;
}
