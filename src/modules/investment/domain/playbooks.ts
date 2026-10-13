import type { SocialLink } from '@/modules/marketing';
import type { InvestmentLever, InvestmentOption, PortfolioShare, ProcessStage, RiskLevel } from './types';

/**
 * The standard investment reference material per country (ADR-171) — hard-coded, on the owner's
 * rule "standard things can be hardcoded; AI only where needed", exactly as Marketing's industry
 * playbooks are (ADR-170, `marketing/domain/industry-templates.ts`).
 *
 * Three uses:
 *
 *   1. The prompt (`prompt.ts`) hands the company's playbook to the model: the usual option ladder
 *      from cash to private stakes, an illustrative portfolio, the capital allocation process, the
 *      governance controls and the jurisdiction's points — so a pack for a UK company names gilts, the
 *      FSCS and a director's SIPP, and a pack for an Indian one names DICGC, SEBI and section 186.
 *   2. The LINKS are an allow-list. The model may cite only the pages listed here
 *      (`narrative-schema.ts` refuses any other), so every link in a pack is a regulator's, a
 *      protection scheme's, a government body's or a provider's stable public homepage that a person
 *      chose — never a URL the model guessed, and never a single fund's product page (Stage 1 is
 *      illustrative: never a named fund to buy).
 *   3. OFFLINE (`MOTION_AI_OFFLINE=1`) the whole narrative is built from the playbook and APX's figures
 *      with no model (`services/generate-narrative.ts`), labelled as a template.
 *
 * Shaped on the client's own example (the "Investment Strategy & Financial Growth Plan", October 2026):
 * five options from "lower" to "very high" risk, a 45/25/20/5/5 portfolio whose high-risk share is
 * 10%, six process stages, six governance controls and five reinvestment levers. Every option ladder
 * is ordered from lower to higher risk; every portfolio adds up to 100 with at most 10% in high and
 * very-high risk; every string fits the narrative schema (`investment-playbooks.test.ts` holds each
 * playbook to the schema).
 *
 * Accuracy rule for this file: statements are general and durable — no rates, limits, allowances,
 * thresholds or dates, which change and which APX cannot keep current. Only homepages (or a register's
 * front door) whose address we are confident of are listed.
 *
 * UK English throughout: these strings reach the client's pack verbatim in offline mode.
 */

export type PlaybookKey = 'GB' | 'AE' | 'IE' | 'IN' | 'generic';

/** What a reference page is, so the prompt can ask for "the regulator and the protection scheme". */
export type LinkKind = 'regulator' | 'protection' | 'government' | 'guidance' | 'tax' | 'market' | 'provider' | 'development';

export interface PlaybookLink extends SocialLink {
  /** A short key the options refer to ("fca"). */
  readonly id: string;
  readonly kind: LinkKind;
  /** What the page is for, for the model: "check that a firm is authorised". */
  readonly use: string;
}

/** One rung of the option ladder: an asset class or route, never a product. */
export interface PlaybookOption {
  readonly id: string;
  readonly name: string;
  readonly risk: RiskLevel;
  readonly description: string;
  /** One of the playbook's `links` ids, or null when no listed page fits. */
  readonly linkId: string | null;
}

export interface InvestmentPlaybook {
  readonly key: PlaybookKey;
  /** "the United Kingdom"; for the generic playbook, "the company's country". */
  readonly country: string;
  /** The home market as an adjective, for the geographic lever: "UK", "UAE", "Irish", "Indian", "domestic". */
  readonly market: string;
  /** The usual routes, ordered from lower to very high risk. */
  readonly ladder: readonly PlaybookOption[];
  /** The five rungs the offline pack shows (the client's example's five). */
  readonly defaultOptionIds: readonly string[];
  /** The illustrative portfolio of the external allocation: adds up to 100; high + very high ≤ 10. */
  readonly portfolio: readonly PortfolioShare[];
  /** The only pages a pack may cite. */
  readonly links: readonly PlaybookLink[];
  /** The reference list of the offline pack (at most eight). */
  readonly defaultReferenceIds: readonly string[];
  readonly levers: readonly InvestmentLever[];
  readonly process: readonly ProcessStage[];
  readonly governance: readonly string[];
  /** The jurisdiction's points the writer must respect (guidance for the model, not printed verbatim). */
  readonly notes: readonly string[];
}

/* ------------------------------------------------------------------------------------------------ */
/* Shared pieces                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

const link = (id: string, label: string, url: string, kind: LinkKind, use: string): PlaybookLink => ({ id, label, url, kind, use });
const option = (id: string, name: string, risk: RiskLevel, description: string, linkId: string | null): PlaybookOption => ({ id, name, risk, description, linkId });
const share = (assetClass: string, percent: number, risk: RiskLevel): PortfolioShare => ({ assetClass, percent: String(percent), risk });

/** The client's five reinvestment levers, with the home market named in the geographic one. */
function levers(market: string): InvestmentLever[] {
  return [
    { lever: 'Customer acquisition', action: 'Targeted marketing, conversion and distribution', measure: 'Acquisition cost; contribution' },
    { lever: 'Product expansion', action: 'Complementary and premium product lines', measure: 'Gross margin; stock turnover' },
    { lever: 'Geographic expansion', action: `New ${market} and international channels`, measure: 'Market-level profitability' },
    { lever: 'Operational efficiency', action: 'Automation, purchasing and inventory controls', measure: 'Cash conversion; margin' },
    { lever: 'Partnerships', action: 'Wholesale and strategic distribution', measure: 'Incremental return on capital' },
  ];
}

/** The client's capital allocation process; stage 3 names the jurisdiction's kind of regulated provider. */
function process(selectProviders: string): ProcessStage[] {
  return [
    { stage: 1, action: 'Confirm free cash, reserves and tax obligations', timing: 'Month 1' },
    { stage: 2, action: 'Approve measurable core-business projects', timing: 'Months 1–2' },
    { stage: 3, action: selectProviders, timing: 'Months 2–3' },
    { stage: 4, action: 'Deploy investment capital in tranches', timing: 'Months 3–6' },
    { stage: 5, action: 'Review performance, liquidity and risk', timing: 'Quarterly' },
    { stage: 6, action: 'Rebalance based on risk-adjusted outcomes', timing: 'Annually' },
  ];
}

/** The client's six governance controls (the fifth tailored to the jurisdiction), plus its deposit-protection control. */
function governance(taxAndStructure: string, depositProtection: string): string[] {
  return [
    'Maintain minimum operating cash reserves before allocating surplus.',
    'Do not fund long-term assets with short-term working capital.',
    'Set concentration limits and formal approval thresholds.',
    'Review performance net of fees, taxes and foreign-exchange movements.',
    taxAndStructure,
    'Measure business reinvestment against incremental cash flows and payback periods.',
    depositProtection,
  ];
}

const GLOBAL_EQUITY = 'Broad exposure to listed global companies for long-term capital growth; values can fall sharply in the short term.';
const GROWTH_SHARES = 'Selective technology, automation, healthcare or infrastructure exposure; more concentrated and more volatile.';
const PRIVATE_STAKES = 'Potential commercial synergies; illiquidity and total loss are possible.';
const BOND_FUNDS = 'Diversified exposure to government and high-quality corporate debt; subject to interest-rate and credit risk.';
const ISHARES = link('ishares', 'iShares (BlackRock) — fund provider', 'https://www.ishares.com/', 'provider', 'a fund provider\'s public site, for index and bond funds as an asset class');

/* ------------------------------------------------------------------------------------------------ */
/* The United Kingdom                                                                               */
/* ------------------------------------------------------------------------------------------------ */

const GB: InvestmentPlaybook = {
  key: 'GB',
  country: 'the United Kingdom',
  market: 'UK',
  ladder: [
    option('cash', 'Cash deposits & short-dated gilts', 'lower', 'Preserve capital and liquidity; yields vary, and deposit protection applies only up to a limit per banking licence.', 'dmo'),
    option('bonds', 'Investment-grade bond funds', 'low_medium', BOND_FUNDS, 'ishares'),
    option('pension', 'Director pension contributions', 'medium', 'Company contributions to a director\'s pension (a SIPP or workplace scheme) are often an allowable business expense; the money is locked away until pension age and annual allowance limits apply.', 'moneyhelper'),
    option('equity', 'Global equity index funds', 'higher', GLOBAL_EQUITY, 'vanguard'),
    option('growth', 'Growth shares & sector ETFs', 'high', GROWTH_SHARES, 'ishares'),
    option('private', 'Minority stakes in businesses', 'very_high', PRIVATE_STAKES, 'bbb'),
    option('crypto', 'Crypto-assets', 'very_high', 'Speculative and highly volatile; protections are limited compared with regulated investments, and the whole amount can be lost.', 'fca'),
  ],
  defaultOptionIds: ['cash', 'bonds', 'equity', 'growth', 'private'],
  portfolio: [
    share('Global equity funds', 45, 'higher'),
    share('Investment-grade bond funds', 25, 'low_medium'),
    share('Cash and gilts', 20, 'lower'),
    share('Growth shares / sector ETFs', 5, 'high'),
    share('Private investments', 5, 'very_high'),
  ],
  links: [
    link('fca', 'Financial Conduct Authority (FCA)', 'https://www.fca.org.uk/', 'regulator', 'the regulator of investment firms; its warnings on high-risk investments'),
    link('fca-register', 'FCA Financial Services Register', 'https://register.fca.org.uk/', 'regulator', 'check that a provider is authorised before using it'),
    link('fscs', 'Financial Services Compensation Scheme (FSCS)', 'https://www.fscs.org.uk/', 'protection', 'deposit and investment protection, up to limits per authorised firm'),
    link('dmo', 'UK Debt Management Office (gilts)', 'https://www.dmo.gov.uk/', 'government', 'UK government bonds (gilts)'),
    link('moneyhelper', 'MoneyHelper (pensions and investing guidance)', 'https://www.moneyhelper.org.uk/', 'guidance', 'free government-backed guidance on pensions and investing'),
    link('hmrc', 'HM Revenue & Customs', 'https://www.gov.uk/government/organisations/hm-revenue-customs', 'tax', 'corporation tax and the tax treatment of company investments'),
    link('bbb', 'British Business Bank', 'https://www.british-business-bank.co.uk/', 'development', 'the government\'s development bank; the private-company finance market'),
    link('lse', 'London Stock Exchange', 'https://www.londonstockexchange.com/', 'market', 'listed shares and exchange-traded funds'),
    link('vanguard', 'Vanguard UK — fund provider', 'https://www.vanguard.co.uk/', 'provider', 'a fund provider\'s public site, for index funds as an asset class'),
    ISHARES,
  ],
  defaultReferenceIds: ['dmo', 'fscs', 'ishares', 'vanguard', 'bbb', 'fca', 'fca-register', 'moneyhelper'],
  levers: levers('UK'),
  process: process('Select FCA-authorised providers and corporate accounts'),
  governance: governance(
    'Seek advice on corporation tax, investment structure and trading status.',
    'Spread cash across banking licences to stay within FSCS deposit protection limits.',
  ),
  notes: [
    'Use only FCA-authorised providers; the FCA register confirms a firm\'s status.',
    'FSCS protection applies to eligible deposits and some investments, up to limits per authorised firm; it does not cover investment losses.',
    'Gilts are UK government bonds, issued through the Debt Management Office.',
    'Company contributions to a director\'s pension (a SIPP or workplace scheme) are a route for the directors, not an investment the company holds; they are often an allowable expense, locked away until pension age, and subject to annual allowance limits.',
    'Substantial investment activity can affect a company\'s trading status for some tax reliefs, so the structure needs tax advice.',
    'Crypto-assets carry very high risk and limited protection; mention them only as a very-high-risk note.',
  ],
};

/* ------------------------------------------------------------------------------------------------ */
/* The United Arab Emirates                                                                         */
/* ------------------------------------------------------------------------------------------------ */

const AE: InvestmentPlaybook = {
  key: 'AE',
  country: 'the United Arab Emirates',
  market: 'UAE',
  ladder: [
    option('cash', 'Fixed deposits with UAE banks', 'lower', 'Preserve capital and liquidity; rates vary, so limit the amount held with any one bank.', 'cbuae'),
    option('bonds', 'Investment-grade sukuk & bond funds', 'low_medium', 'Diversified exposure to Sharia-compliant and conventional debt; subject to interest-rate and credit risk.', 'sca'),
    option('equity', 'Global equity index funds', 'higher', GLOBAL_EQUITY, 'ishares'),
    option('growth', 'UAE-listed growth shares & sector ETFs', 'high', 'Selective exposure to listed UAE and regional companies; more concentrated and more volatile.', 'dfm'),
    option('private', 'Minority stakes in businesses', 'very_high', PRIVATE_STAKES, null),
    option('crypto', 'Virtual assets (crypto)', 'very_high', 'Speculative and highly volatile; use only providers licensed for virtual assets, and the whole amount can be lost.', 'vara'),
  ],
  defaultOptionIds: ['cash', 'bonds', 'equity', 'growth', 'private'],
  portfolio: [
    share('Global equity funds', 45, 'higher'),
    share('Sukuk and bond funds', 25, 'low_medium'),
    share('Bank deposits', 20, 'lower'),
    share('UAE-listed growth shares', 5, 'high'),
    share('Private investments', 5, 'very_high'),
  ],
  links: [
    link('sca', 'Securities and Commodities Authority (SCA)', 'https://www.sca.gov.ae/', 'regulator', 'the federal securities regulator; check that a provider is licensed'),
    link('dfsa', 'Dubai Financial Services Authority (DFSA)', 'https://www.dfsa.ae/', 'regulator', 'the regulator of firms in the Dubai International Financial Centre'),
    link('adgm', 'Abu Dhabi Global Market (ADGM)', 'https://www.adgm.com/', 'regulator', 'home of the FSRA, the regulator of firms in ADGM'),
    link('cbuae', 'Central Bank of the UAE', 'https://www.centralbank.ae/', 'regulator', 'the regulator of banks; check a bank\'s licence'),
    link('vara', 'Virtual Assets Regulatory Authority (VARA)', 'https://www.vara.ae/', 'regulator', 'the regulator of virtual-asset providers in Dubai'),
    link('fta', 'Federal Tax Authority', 'https://tax.gov.ae/', 'tax', 'UAE corporate tax'),
    link('dfm', 'Dubai Financial Market', 'https://www.dfm.ae/', 'market', 'listed UAE shares and exchange-traded funds'),
    link('adx', 'Abu Dhabi Securities Exchange', 'https://www.adx.ae/', 'market', 'listed UAE shares'),
    ISHARES,
  ],
  defaultReferenceIds: ['cbuae', 'sca', 'dfsa', 'adgm', 'ishares', 'dfm', 'fta'],
  levers: levers('UAE'),
  process: process('Select providers licensed by the SCA, DFSA or FSRA, and corporate accounts'),
  governance: governance(
    'Seek advice on UAE corporate tax, free-zone status and the investment structure.',
    'Check each bank\'s licence with the Central Bank of the UAE and limit exposure to any one bank.',
  ),
  notes: [
    'Securities firms are licensed by the SCA onshore, the DFSA in the DIFC and the FSRA in ADGM; banks by the Central Bank of the UAE.',
    'Deposit protection arrangements differ from other countries\': check each bank and spread deposits.',
    'UAE corporate tax applies to businesses, with particular rules for free-zone companies; the structure needs tax advice.',
    'Sukuk are Sharia-compliant debt instruments and sit alongside conventional bonds in the lower-to-medium-risk rungs.',
    'End-of-service benefits owed to staff are a liability to provide for before treating cash as surplus.',
    'Virtual assets are regulated (VARA in Dubai; the SCA and ADGM elsewhere) but remain very high risk; mention them only as a very-high-risk note.',
  ],
};

/* ------------------------------------------------------------------------------------------------ */
/* Ireland                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

const IE: InvestmentPlaybook = {
  key: 'IE',
  country: 'Ireland',
  market: 'Irish',
  ladder: [
    option('cash', 'Deposits & short-dated government bonds', 'lower', 'Preserve capital and liquidity; yields vary, and deposit protection applies only up to a limit per bank.', 'ntma'),
    option('bonds', 'Investment-grade bond funds', 'low_medium', BOND_FUNDS, 'ishares'),
    option('pension', 'Director pension contributions', 'medium', 'Company contributions to a director\'s executive pension or PRSA are generally deductible within Revenue limits; the money is locked away until retirement.', 'pensions-authority'),
    option('equity', 'Global equity index funds (UCITS)', 'higher', GLOBAL_EQUITY, 'ishares'),
    option('growth', 'Growth shares & sector ETFs', 'high', GROWTH_SHARES, 'euronext'),
    option('private', 'Minority stakes in businesses', 'very_high', PRIVATE_STAKES, 'enterprise-ireland'),
    option('crypto', 'Crypto-assets', 'very_high', 'Speculative and highly volatile; use only providers authorised under the EU\'s MiCA rules, and the whole amount can be lost.', 'cbi'),
  ],
  defaultOptionIds: ['cash', 'bonds', 'equity', 'growth', 'private'],
  portfolio: [
    share('Global equity funds', 45, 'higher'),
    share('Investment-grade bond funds', 25, 'low_medium'),
    share('Deposits and government bonds', 20, 'lower'),
    share('Growth shares / sector ETFs', 5, 'high'),
    share('Private investments', 5, 'very_high'),
  ],
  links: [
    link('cbi', 'Central Bank of Ireland', 'https://www.centralbank.ie/', 'regulator', 'the regulator of banks and investment firms; its register confirms a firm is authorised'),
    link('iccl', 'Investor Compensation Company (ICCL)', 'https://www.investorcompensation.ie/', 'protection', 'compensation when an investment firm fails, up to a limit'),
    link('dgs', 'Deposit Guarantee Scheme', 'https://www.depositguarantee.ie/', 'protection', 'protection of bank deposits, up to a limit per bank'),
    link('ntma', 'National Treasury Management Agency (NTMA)', 'https://www.ntma.ie/', 'government', 'Irish government bonds'),
    link('pensions-authority', 'The Pensions Authority', 'https://www.pensionsauthority.ie/', 'guidance', 'pension schemes and PRSAs'),
    link('revenue', 'Revenue (Irish Tax and Customs)', 'https://www.revenue.ie/', 'tax', 'corporation tax, the close-company surcharge and pension relief'),
    link('enterprise-ireland', 'Enterprise Ireland', 'https://www.enterprise-ireland.com/', 'development', 'the state agency backing Irish businesses; the private-company investment market'),
    link('euronext', 'Euronext (Euronext Dublin)', 'https://www.euronext.com/', 'market', 'listed shares and exchange-traded funds'),
    ISHARES,
  ],
  defaultReferenceIds: ['cbi', 'dgs', 'iccl', 'ntma', 'ishares', 'enterprise-ireland', 'revenue'],
  levers: levers('Irish'),
  process: process('Select providers authorised by the Central Bank of Ireland, and corporate accounts'),
  governance: governance(
    'Seek advice on corporation tax, the close-company surcharge and the investment structure.',
    'Spread deposits across banks to stay within Deposit Guarantee Scheme limits.',
  ),
  notes: [
    'Banks and investment firms are authorised by the Central Bank of Ireland (or passported into Ireland under EU rules).',
    'Bank deposits are covered by the Deposit Guarantee Scheme and investment firms by the Investor Compensation Company, each up to a limit; neither covers investment losses.',
    'Irish government bonds are issued through the NTMA. Many global index funds and ETFs are Irish-domiciled UCITS funds.',
    'A close company may pay a surcharge on undistributed investment income, so the structure needs tax advice.',
    'Company contributions to a director\'s executive pension or PRSA are a route for the directors, generally deductible within Revenue limits and locked away until retirement.',
    'Crypto-asset service providers must be authorised under the EU\'s MiCA rules; crypto remains very high risk; mention it only as a very-high-risk note.',
  ],
};

/* ------------------------------------------------------------------------------------------------ */
/* India                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

const IN: InvestmentPlaybook = {
  key: 'IN',
  country: 'India',
  market: 'Indian',
  ladder: [
    option('cash', 'Bank fixed deposits & government securities', 'lower', 'Preserve capital and liquidity; rates vary, and DICGC insurance covers deposits only up to a limit per bank.', 'rbi'),
    option('bonds', 'High-quality debt mutual funds', 'low_medium', 'Diversified exposure to government and highly rated corporate debt; subject to interest-rate and credit risk.', 'amfi'),
    option('pension', 'NPS contributions for directors', 'medium', 'Employer contributions to the National Pension System for employees, including whole-time directors, within the tax limits; the money is largely locked in until retirement.', 'pfrda'),
    option('equity', 'Diversified equity index funds', 'higher', 'Broad exposure to listed Indian and global companies for long-term capital growth; values can fall sharply in the short term.', 'nse'),
    option('growth', 'Growth shares & sector ETFs', 'high', GROWTH_SHARES, 'bse'),
    option('private', 'Minority stakes in unlisted businesses', 'very_high', 'Potential commercial synergies; subject to Companies Act approvals, illiquid, and total loss is possible.', 'mca'),
    option('crypto', 'Virtual digital assets (crypto)', 'very_high', 'Not regulated as securities in India and taxed under a specific regime; highly volatile, and the whole amount can be lost.', 'incometax'),
  ],
  defaultOptionIds: ['cash', 'bonds', 'equity', 'growth', 'private'],
  portfolio: [
    share('Equity index funds', 45, 'higher'),
    share('Debt mutual funds', 25, 'low_medium'),
    share('Fixed deposits and government securities', 20, 'lower'),
    share('Growth shares / sector ETFs', 5, 'high'),
    share('Unlisted investments', 5, 'very_high'),
  ],
  links: [
    link('sebi', 'Securities and Exchange Board of India (SEBI)', 'https://www.sebi.gov.in/', 'regulator', 'the regulator of mutual funds, brokers and listed markets; check a firm is registered'),
    link('rbi', 'Reserve Bank of India (RBI)', 'https://www.rbi.org.in/', 'regulator', 'the regulator of banks; government securities; overseas investment rules'),
    link('dicgc', 'Deposit Insurance and Credit Guarantee Corporation (DICGC)', 'https://www.dicgc.org.in/', 'protection', 'insurance of bank deposits, up to a limit per bank'),
    link('amfi', 'Association of Mutual Funds in India (AMFI)', 'https://www.amfiindia.com/', 'guidance', 'the mutual fund industry body; fund categories and investor guidance'),
    link('pfrda', 'Pension Fund Regulatory and Development Authority (PFRDA)', 'https://www.pfrda.org.in/', 'regulator', 'the National Pension System'),
    link('mca', 'Ministry of Corporate Affairs', 'https://www.mca.gov.in/', 'government', 'the Companies Act, including the rules on company investments'),
    link('incometax', 'Income Tax Department', 'https://www.incometax.gov.in/', 'tax', 'the tax treatment of company investments and virtual digital assets'),
    link('nse', 'National Stock Exchange of India', 'https://www.nseindia.com/', 'market', 'listed shares, indices and exchange-traded funds'),
    link('bse', 'BSE', 'https://www.bseindia.com/', 'market', 'listed shares and exchange-traded funds'),
  ],
  defaultReferenceIds: ['rbi', 'dicgc', 'sebi', 'amfi', 'nse', 'bse', 'mca'],
  levers: levers('Indian'),
  process: process('Select SEBI-registered intermediaries and corporate accounts'),
  governance: governance(
    'Confirm the Companies Act limits and approvals for company investments (section 186), and seek tax advice on the structure.',
    'Spread deposits across banks: DICGC insurance covers deposits only up to a limit per bank.',
  ),
  notes: [
    'Banks are regulated by the RBI; mutual funds, brokers and listed markets by SEBI. Use only SEBI-registered intermediaries.',
    'DICGC insures bank deposits only up to a limit per bank.',
    'A company\'s loans and investments are subject to section 186 of the Companies Act 2013, with board or shareholder approval beyond its limits.',
    'Investing overseas is subject to the RBI\'s overseas investment rules; global exposure is usually through Indian-registered international funds.',
    'Employer contributions to the National Pension System for employees, including whole-time directors, are a route for the directors within the tax limits.',
    'Virtual digital assets are not regulated as securities and are taxed under a specific regime; mention them only as a very-high-risk note.',
  ],
};

/* ------------------------------------------------------------------------------------------------ */
/* Any other country                                                                                */
/* ------------------------------------------------------------------------------------------------ */

const GENERIC: InvestmentPlaybook = {
  key: 'generic',
  country: 'the company\'s country',
  market: 'domestic',
  ladder: [
    option('cash', 'Bank deposits & short-dated government bonds', 'lower', 'Preserve capital and liquidity; yields vary, and deposit protection, where it exists, applies only up to a limit.', 'iadi'),
    option('bonds', 'Investment-grade bond funds', 'low_medium', BOND_FUNDS, 'ishares'),
    option('pension', 'Director pension contributions', 'medium', 'Where the local pension system allows company contributions for directors, a separate long-term route; the rules and limits vary by country.', null),
    option('equity', 'Global equity index funds', 'higher', GLOBAL_EQUITY, 'msci'),
    option('growth', 'Growth shares & sector ETFs', 'high', GROWTH_SHARES, 'ishares'),
    option('private', 'Minority stakes in businesses', 'very_high', PRIVATE_STAKES, null),
    option('crypto', 'Crypto-assets', 'very_high', 'Speculative and highly volatile; protections are limited or absent in many countries, and the whole amount can be lost.', 'iosco'),
  ],
  defaultOptionIds: ['cash', 'bonds', 'equity', 'growth', 'private'],
  portfolio: [
    share('Global equity funds', 45, 'higher'),
    share('Investment-grade bond funds', 25, 'low_medium'),
    share('Deposits and government bonds', 20, 'lower'),
    share('Growth shares / sector ETFs', 5, 'high'),
    share('Private investments', 5, 'very_high'),
  ],
  links: [
    link('iosco', 'International Organization of Securities Commissions (IOSCO)', 'https://www.iosco.org/', 'regulator', 'the body of the world\'s securities regulators; its members list names the local regulator'),
    link('iadi', 'International Association of Deposit Insurers (IADI)', 'https://www.iadi.org/', 'protection', 'the body of deposit insurers; its members list names the local scheme'),
    link('msci', 'MSCI — index provider', 'https://www.msci.com/', 'provider', 'the global equity indices that index funds track'),
    ISHARES,
    link('vanguard', 'Vanguard — fund provider', 'https://www.vanguard.com/', 'provider', 'a fund provider\'s public site, for index funds as an asset class'),
  ],
  defaultReferenceIds: ['iosco', 'iadi', 'msci', 'ishares', 'vanguard'],
  levers: levers('domestic'),
  process: process('Select regulated providers and corporate accounts'),
  governance: governance(
    'Seek advice on corporate tax, the investment structure and local rules on company investments.',
    'Check what deposit protection applies locally and limit exposure to any one bank.',
  ),
  notes: [
    'APX holds no country-specific material for this company: describe regulators and protection schemes in general terms ("the local securities regulator"), never by a name you are unsure of.',
    'Use only providers authorised by the local securities regulator; IOSCO lists its members.',
    'Check what deposit protection applies locally; IADI lists the world\'s deposit insurers.',
    'Where the local system allows company pension contributions for directors, they are a separate route for the directors, not a company holding.',
    'Crypto-assets carry very high risk and limited protection; mention them only as a very-high-risk note.',
  ],
};

/* ------------------------------------------------------------------------------------------------ */
/* Lookup                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export const INVESTMENT_PLAYBOOKS: readonly InvestmentPlaybook[] = [GB, AE, IE, IN, GENERIC];

/**
 * The playbook for an organisation's country (`organizations.country_code`, ISO 3166-1 alpha-2,
 * any case). "UK" is read as GB, the common slip. Any other country — or none — gets the generic
 * playbook: a sound, jurisdiction-neutral starting point, never an error.
 */
export function playbookFor(countryCode: string | null | undefined): InvestmentPlaybook {
  const code = (countryCode ?? '').trim().toUpperCase();
  const key = code === 'UK' ? 'GB' : code;
  return INVESTMENT_PLAYBOOKS.find((p) => p.key === key) ?? GENERIC;
}

/** A playbook's link by id; undefined for an unknown id (a unit test holds every reference to a real id). */
export function playbookLink(playbook: InvestmentPlaybook, id: string | null): PlaybookLink | undefined {
  return id === null ? undefined : playbook.links.find((l) => l.id === id);
}

/** A rung of the ladder as the narrative's option, its link resolved to the page's address. */
export function asInvestmentOption(playbook: InvestmentPlaybook, rung: PlaybookOption): InvestmentOption {
  return { name: rung.name, risk: rung.risk, description: rung.description, referenceUrl: playbookLink(playbook, rung.linkId)?.url ?? null };
}

/** The offline pack's options: the default rungs, in ladder order. */
export function defaultOptions(playbook: InvestmentPlaybook): InvestmentOption[] {
  return playbook.ladder.filter((r) => playbook.defaultOptionIds.includes(r.id)).map((r) => asInvestmentOption(playbook, r));
}

/** The offline pack's reference links, as label and address. */
export function defaultReferences(playbook: InvestmentPlaybook): SocialLink[] {
  return playbook.defaultReferenceIds
    .map((id) => playbookLink(playbook, id))
    .filter((l): l is PlaybookLink => l !== undefined)
    .map((l) => ({ label: l.label, url: l.url }));
}

/* ------------------------------------------------------------------------------------------------ */
/* Words the checks look for                                                                        */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Fund providers, platforms, exchanges-as-brands and coins that a pack must never name as something
 * to buy (Stage 1 is illustrative: asset classes, not products). Matched as whole words, any case,
 * in the options, the portfolio and the prose; the reference LABELS may name a provider, because a
 * reference is a page to read, not a recommendation.
 */
export const NAMED_PRODUCT_WORDS: readonly string[] = [
  'Vanguard', 'iShares', 'BlackRock', 'Fidelity', 'Legal & General', 'L&G', 'Schroders', 'abrdn', 'Invesco', 'SPDR',
  'State Street', 'JPMorgan', 'J.P. Morgan', 'Amundi', 'Xtrackers', 'Franklin Templeton', 'Baillie Gifford', 'M&G',
  'Hargreaves Lansdown', 'AJ Bell', 'Nutmeg', 'Wealthify', 'Moneybox', 'Freetrade', 'Trading 212', 'eToro', 'Robinhood',
  'Coinbase', 'Binance', 'Kraken', 'Bitcoin', 'Ethereum', 'Ether', 'Solana', 'Dogecoin', 'Tether',
  'Zerodha', 'Groww', 'Nippon India', 'SBI Mutual Fund', 'HDFC Mutual Fund', 'ICICI Prudential', 'Kotak Mutual Fund',
  'Sarwa', 'Davy', 'Goodbody',
];

/** An option or asset class that is crypto, whatever it is called: it may only ever be very high risk. */
export const CRYPTO_PATTERN = /\b(crypto|bitcoin|ethereum|stablecoin|nfts?\b|virtual (digital )?assets?|digital assets?)/i;
