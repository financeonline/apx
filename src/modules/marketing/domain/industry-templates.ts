import type {
  BudgetLine, CampaignConcept, CompetitorSection, CustomerSector, PlanPeriod, Priority, ProductCampaign, SectorShare, StrategySection,
} from './types';

/**
 * The standard marketing playbook per broad industry (ADR-170) — hardcoded, on the owner's rule
 * "standard things can be hardcoded; AI only where needed".
 *
 * Two uses. First, the prompt (`prompt.ts`) hands the matching template to the model as a starting
 * point to adapt, so a report for a café and a report for a software firm start from the right
 * sectors, channels and KPIs: the output is more consistent from run to run, and the model spends its
 * tokens tailoring rather than inventing a structure. Second, OFFLINE mode (`MOTION_AI_OFFLINE`, the
 * automated test server and local demos) builds a whole report from the template with no model, no
 * key and no cost (`templateSections` below; `generate-narrative.ts` adds the figures' commentary).
 *
 * Each template is shaped on the client's own example (the Beara Beara strategy, October 2026): five
 * or six customer sectors with a proposed effort split, digital acquisition and retention points,
 * four campaign concepts, an illustrative channel budget, three thirty-day periods and five
 * management priorities with their KPIs. Every split adds up to 100 and every string fits the
 * narrative schema's bounds; a unit test holds every template to the schema.
 *
 * UK English throughout: these strings reach the client's report verbatim in offline mode.
 */

export type IndustryKey =
  | 'retail' | 'hospitality' | 'professional-services' | 'construction' | 'technology' | 'manufacturing' | 'health' | 'other';

/** A kind of comparator worth naming in Section 1.2; the model finds real businesses of each kind. */
export interface CompetitorType {
  /** "Direct competitor". */
  readonly label: string;
  /** What to look for: "a direct competitor of similar size and product type". */
  readonly find: string;
  /** What benchmarking that kind of comparator teaches (used offline). */
  readonly learning: string;
}

export interface IndustryTemplate {
  readonly key: IndustryKey;
  /** "Retail & e-commerce". */
  readonly label: string;
  /** Words and phrases that point a company here (matched on whole words, singular or plural). */
  readonly keywords: readonly string[];
  /** The positioning angle that usually works in the industry (Section 1.1), with no company name. */
  readonly positioning: string;
  readonly competitorTypes: readonly CompetitorType[];
  readonly customerSectors: readonly CustomerSector[];
  /** Over a subset of `customerSectors`; adds up to 100. A sector left out is an overlay. */
  readonly effortSplit: readonly SectorShare[];
  /** Generic product lines, used offline when the profile names fewer than two products. */
  readonly productLines: readonly ProductCampaign[];
  readonly acquisition: readonly string[];
  readonly retention: readonly string[];
  readonly concepts: readonly CampaignConcept[];
  /** The typical channel split; adds up to 100. */
  readonly budget: readonly BudgetLine[];
  readonly first90Days: readonly PlanPeriod[];
  /** Management priorities and their KPIs, numbered 1…n. */
  readonly priorities: readonly Priority[];
}

const sector = (name: string, profile: string, campaignDirection: string): CustomerSector => ({ sector: name, profile, campaignDirection });
const share = (name: string, percent: number): SectorShare => ({ sector: name, percent: String(percent) });
const line = (product: string, positioning: string, execution: string): ProductCampaign => ({ product, positioning, execution });
const concept = (title: string, description: string, purpose: string): CampaignConcept => ({ title, description, purpose });
const channel = (name: string, percent: number, purpose: string): BudgetLine => ({ channel: name, percent: String(percent), purpose });
const period = (name: string, activities: string, deliverable: string): PlanPeriod => ({ period: name, activities, deliverable });
const priorities = (rows: ReadonlyArray<readonly [string, string]>): Priority[] => rows.map(([action, kpi], i) => ({ priority: i + 1, action, kpi }));

/** The last priority is the same everywhere: the client's example closes on the monthly review. */
const MONTHLY_REVIEW = ['Review financial and marketing performance monthly', 'Marketing spend %, gross and net margin'] as const;

const RETAIL: IndustryTemplate = {
  key: 'retail',
  label: 'Retail & e-commerce',
  keywords: [
    'retail', 'retailer', 'shop', 'store', 'boutique', 'e-commerce', 'ecommerce', 'online shop', 'online store', 'd2c', 'direct to consumer',
    'fashion', 'clothing', 'apparel', 'accessory', 'accessories', 'leather', 'bag', 'handbag', 'jewellery', 'jewelry', 'watch', 'footwear', 'shoe',
    'cosmetic', 'beauty products', 'skincare', 'fragrance', 'gift', 'homeware', 'furniture', 'interiors', 'toy', 'stationery',
    'consumer goods', 'consumer products', 'luxury', 'lifestyle brand', 'merchandise',
  ],
  positioning: 'Lead with what makes the product distinctive — design, materials, provenance or craft — and why it lasts, so the brand competes on character and value rather than on discount. Test one clear message (for example "an investment in everyday style") across the website, social media and packaging.',
  competitorTypes: [
    { label: 'Direct competitor', find: 'a direct competitor of similar size and product type', learning: 'Benchmark range, price points, delivery promise and the content that drives their social engagement.' },
    { label: 'Premium benchmark', find: 'a premium or aspirational brand in the same category', learning: 'Study how craftsmanship, personalisation and collaborations justify a higher price.' },
    { label: 'Digital-native challenger', find: 'a digital-native challenger brand known for its social content', learning: 'Learn from their creator partnerships, product photography and retention programmes.' },
    { label: 'Broad category benchmark', find: 'a broad high-street or marketplace benchmark for range, gifting and cross-selling', learning: 'Benchmark gifting, coordinated ranges and cross-selling at checkout.' },
  ],
  customerSectors: [
    sector('Core everyday customers', 'Regular buyers choosing on style, quality and practicality', 'Hero-product campaigns, styling content, reviews and social proof'),
    sector('Gifts & occasions', 'Birthdays, anniversaries and seasonal peaks', 'Gift guides, personalisation, bundles and clear delivery dates'),
    sector('Premium & considered buyers', 'Quality, longevity and craftsmanship', 'Maker and material stories, care guidance, transparent claims'),
    sector('Professional & corporate', 'Practical use at work; corporate gifting', 'Work-ready product edits, corporate gifting and volume offers'),
    sector('Trade & wholesale partners', 'Independent stockists and concessions', 'Line sheets, trade terms and selective partnership tests'),
    sector('International online', 'Overseas buyers drawn to the brand\'s style', 'Localised messaging, shipping and returns clarity'),
  ],
  effortSplit: [
    share('Core everyday customers', 35), share('Gifts & occasions', 20), share('Premium & considered buyers', 15),
    share('Professional & corporate', 15), share('Trade & wholesale partners', 15),
  ],
  productLines: [
    line('Hero products', 'The best-known, highest-contribution lines', 'Always-on hero campaigns; styling and use-case content; reviews'),
    line('Entry products & accessories', 'Affordable entry and add-on purchases', 'Bundles, add-on recommendations at checkout, post-purchase offers'),
    line('Gifts & personalisation', 'Personal and memorable gifts', 'Gift guides, personalisation pages and seasonal campaigns'),
    line('New & seasonal lines', 'Freshness and a reason to return', 'Test demand with small runs and pre-launch emails before scaling'),
  ],
  acquisition: [
    'Short-form Instagram and TikTok content showing the product in use, styling and how it is made.',
    'Google Search and Shopping campaigns for high-intent product searches.',
    'Meta retargeting of product viewers and abandoned baskets, subject to consent.',
    'Product-specific landing pages, a faster checkout and automated welcome emails.',
    'Measure customer acquisition cost, conversion rate, contribution per order and incremental return.',
  ],
  retention: [
    'Early access or member benefits for returning customers.',
    'Complementary products and personalisation offered at checkout.',
    'Post-purchase care, styling and referral journeys.',
    'Segment customers by product, purchase frequency and average order value.',
    'Test value-added benefits before broad discounting.',
  ],
  concepts: [
    concept('The Product and Its Story', 'Maker-to-owner storytelling: materials, craft and the people behind the product, told through short films and photography.', 'Brand awareness and differentiation'),
    concept('The Everyday Icon', 'Hero products shown across work, weekend and evening settings, so customers see one product in many parts of their life.', 'Product recognition and conversion'),
    concept('A Gift That Lasts', 'Personalisation and premium gifting around occasions and seasonal peaks.', 'Basket value and new audiences'),
    concept('Selective Partnerships', 'Small, measured collaborations with creators, stylists or independent stockists.', 'New audiences and distribution tests'),
  ],
  budget: [
    channel('Meta / Instagram advertising', 35, 'Discovery, retargeting and product sales'),
    channel('Google Search / Shopping', 25, 'Capture high purchase intent'),
    channel('Content / photography', 15, 'Campaign creative and product presentation'),
    channel('Creators / collaborations', 10, 'Audience reach and social proof'),
    channel('Email / retention', 10, 'Repeat purchases and basket recovery'),
    channel('Testing / optimisation', 5, 'Conversion experiments'),
  ],
  first90Days: [
    period('Days 1–30', 'Margin audit by product; customer-sector and channel baselines; landing page review', 'Profitability shortlist and KPI dashboard'),
    period('Days 31–60', 'Small paid-media tests; creator content; email flows', 'CAC, conversion and contribution assessment'),
    period('Days 61–90', 'Reallocate to profitable campaigns; gifting and retention tests', 'Scale or stop decisions and a revised forecast'),
  ],
  priorities: priorities([
    ['Identify the highest-contribution hero products', 'Contribution margin by product'],
    ['Acquire qualified customers in the target sectors', 'CAC, conversion rate, new customers'],
    ['Build repeat purchases and add-on sales', 'Repeat rate, average order value, attachment rate'],
    ['Test partnerships without excessive stock risk', 'Contribution by channel'],
    MONTHLY_REVIEW,
  ]),
};

const HOSPITALITY: IndustryTemplate = {
  key: 'hospitality',
  label: 'Hospitality & food',
  keywords: [
    'hospitality', 'restaurant', 'cafe', 'coffee', 'coffee shop', 'bar', 'pub', 'hotel', 'guest house', 'b&b', 'bed and breakfast', 'catering',
    'caterer', 'food', 'drink', 'beverage', 'bakery', 'patisserie', 'takeaway', 'brewery', 'distillery', 'winery', 'wine', 'deli', 'street food',
    'events venue', 'venue', 'dining', 'bistro', 'tea room', 'ice cream', 'pizza', 'food and drink',
  ],
  positioning: 'Sell the experience as much as the menu: the setting, the people, the signature dishes or drinks and the reasons regulars come back. Compete on atmosphere, quality and consistency rather than on discounting, and make booking or ordering effortless.',
  competitorTypes: [
    { label: 'Direct local competitor', find: 'a direct local or regional competitor with a similar offer and price point', learning: 'Benchmark menu pricing, opening hours, booking experience and review ratings.' },
    { label: 'Admired independent', find: 'a well-known independent admired for its brand and social content', learning: 'Learn from their storytelling, photography and community presence.' },
    { label: 'Chain benchmark', find: 'a national chain as a benchmark for booking, loyalty and delivery', learning: 'Benchmark loyalty mechanics, online ordering and consistency of experience.' },
    { label: 'Occasion specialist', find: 'a specialist in the occasion the business wants to win (events, private dining or catering)', learning: 'Study how they package and sell group, corporate and celebration bookings.' },
  ],
  customerSectors: [
    sector('Local regulars', 'Live or work nearby; value familiarity and consistency', 'Loyalty rewards, weekly specials, community presence'),
    sector('Occasions & celebrations', 'Birthdays, anniversaries and group bookings', 'Set menus, pre-booking offers, private-area promotion'),
    sector('Corporate & groups', 'Team lunches, client entertaining and events', 'Corporate packages, simple invoicing, follow-up after each event'),
    sector('Visitors & tourists', 'Searching on maps and review sites', 'Google Business Profile, reviews, partnerships with local attractions'),
    sector('Delivery & takeaway', 'Convenience at home or at work', 'Own ordering channel; delivery-platform menus tuned for margin'),
    sector('Food & drink enthusiasts', 'Seek new experiences, chefs and producers', 'Tasting events, producer stories, creator visits'),
  ],
  effortSplit: [
    share('Local regulars', 30), share('Occasions & celebrations', 25), share('Corporate & groups', 15),
    share('Visitors & tourists', 15), share('Delivery & takeaway', 15),
  ],
  productLines: [
    line('Signature dishes & drinks', 'What the venue is known for', 'Hero-item photography and short video; featured on maps and review profiles'),
    line('Set menus & occasions', 'Easy, good-value celebrations', 'Pre-bookable packages; occasion landing pages; reminder emails'),
    line('Events & private hire', 'Memorable gatherings for groups and companies', 'Enquiry page, corporate outreach, events calendar'),
    line('Takeaway, delivery & retail', 'The venue at home', 'Own ordering link first; margin-aware platform menus; gift vouchers'),
  ],
  acquisition: [
    'Keep the Google Business Profile complete, current and rich in photographs, and respond to every review.',
    'Short-form Instagram and TikTok video of signature dishes, drinks, the team and the room.',
    'Local search and social advertising within a set radius, timed to quieter days and seasonal peaks.',
    'A simple, mobile-first booking and ordering path with clear menus and prices.',
    'Measure covers, booking conversion, average spend per head and cost per booking.',
  ],
  retention: [
    'A light loyalty scheme or visit rewards for regulars.',
    'Birthday and anniversary capture with timely invitations.',
    'Email and SMS for new menus, events and quieter-day offers, subject to consent.',
    'Gift vouchers that bring new guests through existing ones.',
    'Ask for reviews after good visits and act on recurring feedback.',
  ],
  concepts: [
    concept('Meet the Kitchen', 'Behind-the-scenes content on the chef, the producers and how the signature dishes are made.', 'Brand awareness and differentiation'),
    concept('Your Table, Your Occasion', 'Packaged celebrations and group bookings with a simple pre-booking offer.', 'Bookings and average spend'),
    concept('Local Favourite', 'Community partnerships, regulars\' stories and neighbourhood events.', 'Local loyalty and word of mouth'),
    concept('Taste at Home', 'Takeaway, retail or gift products that carry the brand beyond the venue.', 'New revenue and reach'),
  ],
  budget: [
    channel('Meta / Instagram advertising', 30, 'Local discovery and event promotion'),
    channel('Google Search / Maps', 25, 'Capture "near me" and booking intent'),
    channel('Content / photography', 20, 'Menu, venue and team imagery'),
    channel('Creators / local partnerships', 10, 'Reach and social proof'),
    channel('Email / SMS & loyalty', 10, 'Repeat visits'),
    channel('Testing / optimisation', 5, 'Offer and booking-path experiments'),
  ],
  first90Days: [
    period('Days 1–30', 'Menu margin review; booking and review baselines; Google Business Profile and website audit', 'Margin shortlist and KPI dashboard'),
    period('Days 31–60', 'Local paid tests; occasion packages; content shoot; email capture', 'Cost per booking and spend-per-head assessment'),
    period('Days 61–90', 'Scale what fills quieter days; launch loyalty; corporate outreach', 'Scale or stop decisions and a revised forecast'),
  ],
  priorities: priorities([
    ['Protect gross margin on the menu', 'Gross margin by dish and drink'],
    ['Fill quieter days and times', 'Covers by day-part, booking conversion'],
    ['Grow average spend per visit', 'Spend per head, drinks and dessert attachment'],
    ['Build repeat visits', 'Repeat-visit rate, loyalty sign-ups'],
    MONTHLY_REVIEW,
  ]),
};

const PROFESSIONAL: IndustryTemplate = {
  key: 'professional-services',
  label: 'Professional services',
  keywords: [
    'professional services', 'accountant', 'accountancy', 'accounting', 'bookkeeping', 'bookkeeper', 'tax adviser', 'tax advisor', 'legal',
    'law firm', 'lawyer', 'solicitor', 'barrister', 'consultancy', 'consulting', 'consultant', 'advisory', 'adviser', 'advisor', 'recruitment',
    'staffing', 'marketing agency', 'agency', 'financial advice', 'financial adviser', 'wealth management', 'insurance broker', 'broker',
    'architect', 'architecture', 'surveyor', 'design studio', 'human resources', 'hr consultancy', 'training', 'coaching', 'coach',
    'public relations', 'pr agency', 'translation', 'management consulting',
  ],
  positioning: 'Position the firm on specialist expertise and outcomes for a clearly defined client type, not on hourly rates. Make credibility visible — named people, case studies, credentials and clear fixed-fee packages — so choosing the firm feels low-risk.',
  competitorTypes: [
    { label: 'Direct competitor', find: 'a direct competitor of similar size serving the same client type', learning: 'Benchmark service packages, published pricing, response times and reviews.' },
    { label: 'Specialist boutique', find: 'a respected specialist or boutique firm known for thought leadership', learning: 'Learn how expertise is shown through guides, commentary and events.' },
    { label: 'Large-firm benchmark', find: 'a larger national or international firm as a credibility benchmark', learning: 'Benchmark credentials, case studies and how services are described.' },
    { label: 'Productised challenger', find: 'a digital-first or productised challenger offering fixed-fee packages', learning: 'Study their onboarding, online booking and fixed-fee clarity.' },
  ],
  customerSectors: [
    sector('Owner-managed businesses', 'Growing firms needing practical, trusted advice', 'Fixed-fee packages, case studies, referral partnerships'),
    sector('Established mid-sized companies', 'Complexity, compliance and growth projects', 'Sector insight, seminars, account-based outreach'),
    sector('Start-ups & scale-ups', 'Setting up properly; funding and growth milestones', 'Starter packages, accelerator and investor partnerships'),
    sector('Private individuals', 'Life events and personal obligations', 'Clear guides, search visibility, review-led trust'),
    sector('Referral partners', 'Banks, brokers and complementary firms', 'Partner programme, co-hosted events, introductions tracking'),
    sector('Specialist sector niche', 'A sector the firm knows deeply', 'Niche content, sector events and memberships'),
  ],
  effortSplit: [
    share('Owner-managed businesses', 35), share('Established mid-sized companies', 20), share('Start-ups & scale-ups', 15),
    share('Referral partners', 20), share('Specialist sector niche', 10),
  ],
  productLines: [
    line('Core recurring service', 'Dependable, proactive support', 'Fixed-fee tiers; onboarding journey; annual review meetings'),
    line('Advisory & projects', 'Specialist expertise for key decisions', 'Case studies, diagnostic offers, partner-led outreach'),
    line('Entry offer', 'A low-risk first step', 'A fixed-price review or health check with a clear next-step proposal'),
  ],
  acquisition: [
    'A website that states who the firm serves, the problems it solves and its fixed-fee packages, with named people and case studies.',
    'LinkedIn content and outreach from the partners and senior staff, not only the company page.',
    'Google Search campaigns and search-optimised guides for high-intent service queries.',
    'Referral partnerships with complementary firms, tracked by source.',
    'Measure enquiries, enquiry-to-proposal and proposal-to-client conversion, and cost per client won.',
  ],
  retention: [
    'A structured onboarding and an annual review meeting with every client.',
    'Proactive updates on deadlines, regulation and opportunities relevant to the client.',
    'Cross-sell advisory services identified at review meetings.',
    'Ask satisfied clients for reviews, testimonials and introductions.',
    'Track client profitability and renewal risk, and act early.',
  ],
  concepts: [
    concept('Proof, Not Promises', 'Client case studies and outcomes told in the client\'s own words, with permission.', 'Credibility and conversion'),
    concept('The Expert Next Door', 'Partners publishing practical guides, short videos and commentary on the issues clients face.', 'Visibility and thought leadership'),
    concept('Start Right', 'A fixed-price entry offer (a review, audit or health check) that leads to an ongoing service.', 'Lead generation and a lower-risk first purchase'),
    concept('Partners in Growth', 'Co-hosted events and content with banks, brokers and complementary firms.', 'Referral volume and new audiences'),
  ],
  budget: [
    channel('LinkedIn content & advertising', 30, 'Reach decision-makers'),
    channel('Google Search / SEO content', 25, 'Capture high-intent enquiries'),
    channel('Events & webinars', 15, 'Demonstrate expertise'),
    channel('Website & case studies', 15, 'Credibility and conversion'),
    channel('Email / CRM nurturing', 10, 'Convert and retain clients'),
    channel('Testing / optimisation', 5, 'Offer and landing page experiments'),
  ],
  first90Days: [
    period('Days 1–30', 'Client profitability review; ideal-client definition; website and proposal audit', 'Target client list and KPI dashboard'),
    period('Days 31–60', 'Case studies; partner-led LinkedIn content; entry-offer and search tests', 'Cost per enquiry and conversion assessment'),
    period('Days 61–90', 'Referral partner programme; events; scale the best-converting channels', 'Scale or stop decisions and a revised pipeline forecast'),
  ],
  priorities: priorities([
    ['Focus on the most profitable client types and services', 'Profit by client and service line'],
    ['Generate qualified enquiries', 'Enquiries, cost per enquiry, conversion to proposal'],
    ['Win more proposals', 'Proposal win rate, average fee'],
    ['Retain and grow existing clients', 'Client retention, fee growth per client'],
    MONTHLY_REVIEW,
  ]),
};

const CONSTRUCTION: IndustryTemplate = {
  key: 'construction',
  label: 'Construction & trades',
  keywords: [
    'construction', 'builder', 'building contractor', 'contractor', 'trades', 'tradesman', 'plumber', 'plumbing', 'heating', 'electrician',
    'electrical contractor', 'roofer', 'roofing', 'joinery', 'joiner', 'carpentry', 'carpenter', 'landscaping', 'landscaper', 'renovation',
    'refurbishment', 'property maintenance', 'civil engineering', 'groundworks', 'scaffolding', 'flooring', 'fitted kitchen', 'bathroom',
    'decorating', 'decorator', 'painter', 'glazing', 'hvac', 'damp proofing', 'house extension', 'home extension', 'loft conversion', 'home improvement', 'fit-out',
    'surfacing', 'paving', 'fencing', 'building services',
  ],
  positioning: 'Win on trust and reliability: qualified people, clear quotes, tidy work, finishing on time and standing behind the job. Show finished projects and genuine customer reviews, and specialise where the margin and the reputation are strongest.',
  competitorTypes: [
    { label: 'Direct local competitor', find: 'a direct local competitor of similar size and trade', learning: 'Benchmark quoting speed, guarantees, review ratings and service area.' },
    { label: 'Well-reviewed regional firm', find: 'a well-reviewed regional firm known for its reputation and finished-project content', learning: 'Learn from their project galleries, case studies and review-led marketing.' },
    { label: 'National brand benchmark', find: 'a national brand or franchise as a benchmark for process and guarantees', learning: 'Benchmark booking, guarantees, finance options and customer communication.' },
    { label: 'Job-type specialist', find: 'a specialist in the highest-margin job type the business wants more of', learning: 'Study how they position and price specialist work.' },
  ],
  customerSectors: [
    sector('Homeowners — planned projects', 'Extensions, renovations and upgrades; research and compare quotes', 'Project galleries, reviews, finance options, clear quoting'),
    sector('Homeowners — urgent repairs', 'Something has broken and needs fixing now', 'Search visibility, fast-response promise, call tracking'),
    sector('Landlords & letting agents', 'Compliance, turnaround between tenants, reliability', 'Maintenance agreements, account terms, quick reporting'),
    sector('Commercial clients', 'Offices, shops and facilities needing dependable contractors', 'Case studies, accreditations, framework and tender lists'),
    sector('Main contractors & developers', 'Subcontract capacity and quality', 'Relationship building, health and safety credentials, capacity planning'),
    sector('Public sector & housing associations', 'Framework-based, compliance-led buying', 'Accreditations, tender readiness, social value evidence'),
  ],
  effortSplit: [
    share('Homeowners — planned projects', 35), share('Homeowners — urgent repairs', 15), share('Landlords & letting agents', 20),
    share('Commercial clients', 20), share('Main contractors & developers', 10),
  ],
  productLines: [
    line('Core trade service', 'Reliable, qualified, on time', 'Service pages by job type; reviews; fast quote response'),
    line('Larger projects', 'Planned, well-managed projects', 'Before-and-after galleries; project case studies; finance options'),
    line('Maintenance agreements', 'Predictable care and priority response', 'Annual plans for homeowners, landlords and commercial clients'),
  ],
  acquisition: [
    'A complete Google Business Profile and a steady flow of genuine reviews.',
    'Google Search and Local Services advertising for high-intent job searches in the service area.',
    'Before-and-after photography and short videos of finished work on Instagram and Facebook.',
    'Listings on trusted trade directories and accreditation bodies.',
    'Measure enquiries, quote-to-win rate, average job value and cost per job won.',
  ],
  retention: [
    'Follow up every completed job for a review and a referral.',
    'Annual service or maintenance reminders.',
    'Maintenance agreements for landlords and commercial clients.',
    'A referral reward for customers and partner trades.',
    'Keep a record of past customers\' properties to suggest timely upgrades.',
  ],
  concepts: [
    concept('Built to Last', 'Finished projects, before-and-after stories and the craftsmanship behind them.', 'Trust and differentiation'),
    concept('On Time, As Quoted', 'A clear promise on quoting, communication and tidy, punctual work, backed by reviews.', 'Conversion of quotes into jobs'),
    concept('Peace of Mind Plans', 'Maintenance and service agreements with priority response.', 'Recurring revenue and retention'),
    concept('Trusted by the Trade', 'Relationships with main contractors, letting agents and property managers.', 'Larger and repeat contracts'),
  ],
  budget: [
    channel('Google Search / Local Services', 35, 'Capture urgent and planned job searches'),
    channel('Meta / Instagram advertising', 20, 'Show finished work locally'),
    channel('Reviews & directories', 15, 'Trust and visibility'),
    channel('Content / photography', 15, 'Project galleries and case studies'),
    channel('Email / CRM & referrals', 10, 'Repeat work and referrals'),
    channel('Testing / optimisation', 5, 'Landing page and offer experiments'),
  ],
  first90Days: [
    period('Days 1–30', 'Job-type margin review; enquiry and win-rate baselines; Google profile and website audit', 'Profitable job-type shortlist and KPI dashboard'),
    period('Days 31–60', 'Local search tests; project photography; review requests; referral offer', 'Cost per enquiry and quote-to-win assessment'),
    period('Days 61–90', 'Scale profitable job types; launch maintenance plans; commercial outreach', 'Scale or stop decisions and a revised forecast'),
  ],
  priorities: priorities([
    ['Focus on the highest-margin job types', 'Gross margin by job type'],
    ['Generate qualified enquiries in the service area', 'Enquiries, cost per enquiry'],
    ['Convert more quotes into jobs', 'Quote-to-win rate, average job value'],
    ['Build recurring and repeat work', 'Maintenance agreements, repeat customers'],
    MONTHLY_REVIEW,
  ]),
};

const TECHNOLOGY: IndustryTemplate = {
  key: 'technology',
  label: 'Technology & software',
  keywords: [
    'software', 'saas', 'technology', 'tech', 'app', 'platform', 'it services', 'it support', 'managed services', 'cloud', 'cyber security',
    'cybersecurity', 'data', 'analytics', 'ai', 'artificial intelligence', 'machine learning', 'digital', 'web development', 'web design',
    'development agency', 'hosting', 'fintech', 'edtech', 'healthtech', 'proptech', 'telecoms', 'telecommunications', 'electronics',
    'hardware', 'device', 'iot', 'gaming', 'video game',
  ],
  positioning: 'Lead with the problem solved and the measurable result for a clearly defined customer, not with features. Make the product easy to try, show proof from similar customers, and position on reliability, support and time to value rather than on price alone.',
  competitorTypes: [
    { label: 'Direct competitor', find: 'a direct competitor solving the same problem for the same customer type', learning: 'Benchmark positioning, pricing pages, trial or demo path and reviews.' },
    { label: 'Category leader', find: 'a category leader as a benchmark for positioning, pricing and onboarding', learning: 'Learn from their onboarding, documentation and customer proof.' },
    { label: 'Fast-growing challenger', find: 'a fast-growing challenger known for product-led growth or content', learning: 'Study their content engine, community and free-to-paid conversion.' },
    { label: 'Alternative solution', find: 'an adjacent tool or service the customer might use instead (the status quo alternative)', learning: 'Understand why customers stay with the alternative and what makes them switch.' },
  ],
  customerSectors: [
    sector('Small businesses', 'Need simple, affordable tools that work quickly', 'Self-serve trials, templates, comparison and review sites'),
    sector('Mid-market companies', 'Integration, security and support matter', 'Demos, case studies, account-based outreach'),
    sector('Enterprise', 'Procurement, compliance and scale', 'Security documentation, references, partner channels'),
    sector('Specialist vertical', 'An industry with specific workflows', 'Vertical landing pages, sector events and integrations'),
    sector('Channel & integration partners', 'Resellers, consultants and platforms', 'Partner programme, marketplace listings, co-marketing'),
    sector('Existing customers', 'Expansion, upgrades and renewals', 'In-product prompts, customer success reviews, advocacy'),
  ],
  effortSplit: [
    share('Small businesses', 30), share('Mid-market companies', 30), share('Specialist vertical', 15),
    share('Channel & integration partners', 15), share('Enterprise', 10),
  ],
  productLines: [
    line('Core product', 'The main problem solved, quickly', 'Free trial or demo; onboarding emails; use-case pages'),
    line('Premium tier & add-ons', 'More value for growing customers', 'In-product upgrade prompts; feature-led campaigns'),
    line('Services & support', 'Faster time to value', 'Implementation packages; customer success reviews'),
  ],
  acquisition: [
    'Search-optimised content and Google Search campaigns for problem-led and comparison queries.',
    'LinkedIn content and targeted advertising to decision-makers in the target sectors.',
    'A free trial, demo or freemium path with clear onboarding.',
    'Listings and reviews on software comparison and marketplace sites.',
    'Measure trial or demo conversion, CAC, payback period and pipeline by channel.',
  ],
  retention: [
    'Structured onboarding to first value within days.',
    'Customer success check-ins and usage-based health scores.',
    'In-product prompts for upgrades and add-ons.',
    'Annual billing incentives and renewal reminders.',
    'A customer advisory group, case studies and referral rewards.',
  ],
  concepts: [
    concept('Problem Solved', 'Before-and-after stories showing the time or money customers saved.', 'Differentiation and conversion'),
    concept('Try It Today', 'A friction-free trial or demo with guided onboarding and quick wins.', 'Acquisition and activation'),
    concept('Built for Your Industry', 'Vertical editions, templates and case studies for one priority sector.', 'Focused growth in a niche'),
    concept('Better Together', 'Integrations and co-marketing with complementary platforms.', 'New channels and reach'),
  ],
  budget: [
    channel('Google Search / SEO content', 30, 'Capture problem and comparison searches'),
    channel('LinkedIn advertising & content', 25, 'Reach decision-makers'),
    channel('Content / product marketing', 15, 'Case studies, demos and guides'),
    channel('Email / lifecycle', 15, 'Activation, upgrades and renewals'),
    channel('Review & marketplace sites', 10, 'Social proof and discovery'),
    channel('Testing / optimisation', 5, 'Pricing and onboarding experiments'),
  ],
  first90Days: [
    period('Days 1–30', 'Unit economics by plan; funnel and churn baselines; positioning and pricing page review', 'Ideal-customer profile and KPI dashboard'),
    period('Days 31–60', 'Search and LinkedIn tests; onboarding improvements; two case studies', 'CAC, activation and payback assessment'),
    period('Days 61–90', 'Scale profitable channels; partner and marketplace listings; upgrade campaigns', 'Scale or stop decisions and a revised forecast'),
  ],
  priorities: priorities([
    ['Focus on the most valuable customer segment', 'Revenue and retention by segment'],
    ['Acquire customers efficiently', 'CAC, trial or demo conversion'],
    ['Shorten time to value', 'Activation rate, time to first value'],
    ['Reduce churn and grow accounts', 'Net revenue retention, churn rate'],
    MONTHLY_REVIEW,
  ]),
};

const MANUFACTURING: IndustryTemplate = {
  key: 'manufacturing',
  label: 'Manufacturing & wholesale',
  keywords: [
    'manufacturing', 'manufacturer', 'factory', 'wholesale', 'wholesaler', 'distribution', 'distributor', 'industrial',
    'engineering', 'fabrication', 'machining', 'packaging', 'component', 'spare part', 'supplier', 'b2b', 'import', 'export', 'printing',
    'textile', 'chemical', 'plastic', 'metalwork', 'food production', 'food manufacturing', 'trade supplier', 'oem',
  ],
  positioning: 'Position on reliability, quality and partnership: consistent specification, dependable lead times, technical support and the ability to solve a customer\'s problem. Compete on total value and service, and make it easy for buyers to specify, order and reorder.',
  competitorTypes: [
    { label: 'Direct competitor', find: 'a direct competitor making or supplying similar products', learning: 'Benchmark range, lead times, certifications and trade terms.' },
    { label: 'Large supplier benchmark', find: 'a larger national or international supplier as a benchmark for range and service', learning: 'Learn from their online catalogue, ordering experience and account service.' },
    { label: 'Niche specialist', find: 'a specialist niche manufacturer known for quality or innovation', learning: 'Study how they show technical capability and win specification.' },
    { label: 'Distributor or marketplace', find: 'a distributor or marketplace that reaches the same buyers', learning: 'Understand the margin, reach and service expectations of indirect channels.' },
  ],
  customerSectors: [
    sector('Trade & wholesale buyers', 'Reliable supply, margin and range', 'Trade catalogue, account terms, reorder reminders'),
    sector('Retail stockists', 'Sell-through and merchandising support', 'Retailer packs, point-of-sale material, co-promotion'),
    sector('OEM & industrial customers', 'Specification, quality and lead times', 'Technical content, certifications, account management'),
    sector('Public sector & large contracts', 'Frameworks and compliance', 'Tender readiness, accreditations, case studies'),
    sector('Direct online buyers', 'Smaller orders bought online', 'Online catalogue, search visibility, simple checkout'),
    sector('Export markets', 'Overseas distributors and buyers', 'Distributor partnerships, trade shows, localised materials'),
  ],
  effortSplit: [
    share('Trade & wholesale buyers', 35), share('Retail stockists', 20), share('OEM & industrial customers', 25),
    share('Public sector & large contracts', 10), share('Direct online buyers', 10),
  ],
  productLines: [
    line('Core product range', 'Consistent quality and availability', 'Range catalogue, specification sheets, account-based reorder campaigns'),
    line('Specialist & custom products', 'Problem-solving capability', 'Case studies, technical content, sales engineering support'),
    line('New products', 'Innovation and range extension', 'Launch to existing accounts first; samples; trade-show demonstrations'),
  ],
  acquisition: [
    'A website and online catalogue with full specifications, certifications and a simple enquiry or trade-account path.',
    'Google Search campaigns and search-optimised product pages for specification-led queries.',
    'LinkedIn content and outreach to buyers, engineers and procurement teams.',
    'Selected trade shows and industry directories, with leads followed up within days.',
    'Measure enquiries, quote conversion, new accounts, order value and cost per account won.',
  ],
  retention: [
    'Account management for the top customers by contribution.',
    'Reorder reminders and replenishment programmes.',
    'Cross-sell complementary products to existing accounts.',
    'Regular reviews with key accounts on quality and lead times.',
    'Volume or loyalty terms tested against margin before roll-out.',
  ],
  concepts: [
    concept('Made to Specification', 'Quality, certifications and engineering capability shown through case studies and factory content.', 'Credibility with technical buyers'),
    concept('Never Out of Stock', 'A dependable supply promise with reorder programmes and clear lead times.', 'Retention and order frequency'),
    concept('Partner in Production', 'Co-development and problem-solving stories with customers.', 'Higher-value contracts'),
    concept('New Markets', 'Distributor and export partnerships tested in one region first.', 'New revenue streams'),
  ],
  budget: [
    channel('Google Search / SEO', 25, 'Capture specification and product searches'),
    channel('LinkedIn advertising & outreach', 20, 'Reach buyers and engineers'),
    channel('Trade shows & directories', 20, 'Meet buyers and generate leads'),
    channel('Content / technical material', 15, 'Specifications, case studies and product imagery'),
    channel('Email / account marketing', 15, 'Reorders and cross-selling'),
    channel('Testing / optimisation', 5, 'Website and offer experiments'),
  ],
  first90Days: [
    period('Days 1–30', 'Margin review by product and customer; account and pipeline baselines; website and catalogue audit', 'Profitable product and account shortlist and KPI dashboard'),
    period('Days 31–60', 'Search and LinkedIn tests; key-account reviews; technical content', 'Cost per lead and quote conversion assessment'),
    period('Days 61–90', 'Scale profitable channels; reorder programmes; trade-show plan', 'Scale or stop decisions and a revised forecast'),
  ],
  priorities: priorities([
    ['Focus on the highest-contribution products and accounts', 'Contribution by product and customer'],
    ['Win new trade accounts', 'New accounts, quote conversion'],
    ['Grow order frequency and value', 'Reorder rate, average order value'],
    ['Protect margin on pricing and input costs', 'Gross margin, price realisation'],
    MONTHLY_REVIEW,
  ]),
};

const HEALTH: IndustryTemplate = {
  key: 'health',
  label: 'Health & wellbeing',
  keywords: [
    'health', 'healthcare', 'clinic', 'medical', 'dental', 'dentist', 'orthodontist', 'physio', 'physiotherapy', 'osteopath', 'chiropractor',
    'wellbeing', 'wellness', 'fitness', 'gym', 'personal trainer', 'yoga', 'pilates', 'spa', 'beauty salon', 'salon', 'hair', 'hairdresser',
    'barber', 'aesthetics', 'skin clinic', 'care home', 'home care', 'care services', 'pharmacy', 'nutrition', 'nutritionist', 'supplement',
    'therapy', 'therapist', 'counselling', 'massage', 'optician', 'optometrist', 'veterinary', 'vet', 'mental health', 'beauty', 'nails',
  ],
  positioning: 'Build trust first: qualified practitioners, clear outcomes, transparent prices and genuine reviews. Position on the quality of care and the experience, make booking effortless, and keep every claim responsible and within the rules that apply to health and wellbeing advertising.',
  competitorTypes: [
    { label: 'Direct local competitor', find: 'a direct local competitor offering similar treatments or services', learning: 'Benchmark prices, booking experience, practitioner profiles and reviews.' },
    { label: 'Admired independent', find: 'a well-regarded independent known for its reputation and content', learning: 'Learn from their educational content and client stories.' },
    { label: 'Chain benchmark', find: 'a national chain or franchise as a benchmark for booking and memberships', learning: 'Benchmark memberships, packages and online booking.' },
    { label: 'Digital alternative', find: 'a digital or at-home alternative competing for the same customer', learning: 'Understand the convenience they offer and where in-person care is stronger.' },
  ],
  customerSectors: [
    sector('New local clients', 'Searching nearby for a trusted provider', 'Google profile, reviews, introductory offers'),
    sector('Regular & membership clients', 'Ongoing care, routines and convenience', 'Memberships, packages, rebooking prompts'),
    sector('Specific needs & conditions', 'A defined problem or goal', 'Condition-led content, practitioner expertise, clear outcomes'),
    sector('Life events & occasions', 'Weddings, events, the new year and similar moments', 'Seasonal packages and gift vouchers'),
    sector('Corporate & insured clients', 'Employer schemes and insurers', 'Corporate wellbeing packages, insurer registrations'),
    sector('Referral network', 'GPs, practitioners and complementary providers', 'Professional referral relationships, educational content'),
  ],
  effortSplit: [
    share('New local clients', 30), share('Regular & membership clients', 25), share('Specific needs & conditions', 20),
    share('Life events & occasions', 10), share('Corporate & insured clients', 15),
  ],
  productLines: [
    line('Core treatments or services', 'Trusted, effective care', 'Service pages, practitioner profiles, reviews, online booking'),
    line('Packages & memberships', 'Better results through regular care', 'Course packages, memberships, rebooking reminders'),
    line('Retail & aftercare products', 'Continue the results at home', 'Aftercare recommendations, bundles, online shop'),
  ],
  acquisition: [
    'A complete Google Business Profile, practitioner profiles and a steady flow of genuine reviews.',
    'Google Search campaigns for treatment and service searches in the local area.',
    'Instagram and TikTok content showing the practitioners, the setting and responsibly presented results.',
    'Online booking with clear prices, availability and an introductory offer.',
    'Measure new clients, booking conversion, cost per new client and client lifetime value.',
  ],
  retention: [
    'Rebooking at the end of each visit and automated reminders.',
    'Memberships or packages that reward regular care.',
    'Aftercare guidance and product recommendations.',
    'Referral rewards for existing clients.',
    'Ask for reviews and act on feedback.',
  ],
  concepts: [
    concept('Meet Your Practitioner', 'The people, qualifications and care behind every treatment.', 'Trust and differentiation'),
    concept('Your First Visit', 'A clear, welcoming introductory offer and what to expect.', 'New client acquisition'),
    concept('Results That Last', 'Programmes, memberships and aftercare that support long-term results.', 'Retention and lifetime value'),
    concept('Well at Work', 'Corporate wellbeing packages for local employers.', 'New audiences and contracted revenue'),
  ],
  budget: [
    channel('Google Search / Maps', 30, 'Capture local treatment searches'),
    channel('Meta / Instagram advertising', 25, 'Local awareness and offers'),
    channel('Content / photography', 15, 'Practitioners, setting and results'),
    channel('Email / SMS & rebooking', 15, 'Retention and repeat visits'),
    channel('Reviews & directories', 10, 'Trust and visibility'),
    channel('Testing / optimisation', 5, 'Offer and booking-path experiments'),
  ],
  first90Days: [
    period('Days 1–30', 'Service margin and capacity review; new-client and rebooking baselines; booking-path audit', 'Profitable service shortlist and KPI dashboard'),
    period('Days 31–60', 'Local search and social tests; introductory offer; practitioner content', 'Cost per new client and conversion assessment'),
    period('Days 61–90', 'Launch memberships or packages; corporate outreach; scale profitable channels', 'Scale or stop decisions and a revised forecast'),
  ],
  priorities: priorities([
    ['Fill available capacity with profitable services', 'Utilisation, revenue per hour'],
    ['Acquire new clients efficiently', 'New clients, cost per new client'],
    ['Build regular, repeat visits', 'Rebooking rate, membership numbers'],
    ['Grow value per client', 'Average spend, retail attachment'],
    MONTHLY_REVIEW,
  ]),
};

const OTHER: IndustryTemplate = {
  key: 'other',
  label: 'General business',
  keywords: [],
  positioning: 'Define the customer the business serves best and the one or two reasons it is chosen over the alternatives — quality, expertise, service or convenience — and say that consistently everywhere. Compete on value rather than on price alone.',
  competitorTypes: [
    { label: 'Direct competitor', find: 'a direct competitor of similar size and offer', learning: 'Benchmark offer, pricing, service promise and reviews.' },
    { label: 'Category leader', find: 'a well-regarded leader in the category as a benchmark', learning: 'Learn from their positioning, website and customer proof.' },
    { label: 'Fast-growing challenger', find: 'a digital-first or fast-growing challenger', learning: 'Study their content, social presence and customer acquisition.' },
    { label: 'Alternative choice', find: 'an alternative the customer might choose instead', learning: 'Understand why customers choose the alternative and what would make them switch.' },
  ],
  customerSectors: [
    sector('Core customers', 'The buyers who already value the business most', 'Testimonials, referrals and offers that reward loyalty'),
    sector('Growth customers', 'Similar buyers not yet reached', 'Targeted digital advertising and search visibility'),
    sector('Business customers', 'Organisations buying for their teams or operations', 'Account offers, case studies, LinkedIn outreach'),
    sector('Occasional & seasonal buyers', 'Purchases tied to dates, seasons or events', 'Seasonal campaigns and reminders'),
    sector('Partners & referrers', 'Complementary businesses that reach the same customers', 'Partnerships, co-promotion and referral rewards'),
  ],
  effortSplit: [
    share('Core customers', 35), share('Growth customers', 30), share('Business customers', 15),
    share('Occasional & seasonal buyers', 10), share('Partners & referrers', 10),
  ],
  productLines: [
    line('Core offer', 'What the business is best known for', 'Hero campaigns, testimonials and clear calls to action'),
    line('Entry offer', 'A low-risk first purchase', 'Introductory offer, simple landing page, follow-up emails'),
    line('Premium & add-ons', 'More value for existing customers', 'Upgrades and bundles offered after the first purchase'),
  ],
  acquisition: [
    'A clear website and Google Business Profile that state who the business serves and why it is chosen.',
    'Google Search campaigns for high-intent searches.',
    'Social media content showing the product or service, the people and customer results.',
    'Partnerships with complementary businesses that reach the same customers.',
    'Measure enquiries or orders, conversion rate, cost per customer and contribution per sale.',
  ],
  retention: [
    'Follow up every sale for feedback, a review and a referral.',
    'Email updates and offers for existing customers, subject to consent.',
    'Bundles, upgrades and repeat-purchase reminders.',
    'A simple loyalty or referral reward.',
    'Segment customers by value and frequency, and focus effort on the best.',
  ],
  concepts: [
    concept('Why Customers Choose Us', 'Real customer stories and the reasons they chose the business.', 'Differentiation and trust'),
    concept('Start Here', 'A simple, low-risk first purchase or introductory offer.', 'Acquisition and conversion'),
    concept('Better Together', 'Partnerships and co-promotions with complementary businesses.', 'Reach and new audiences'),
    concept('Come Back Soon', 'Reminders, loyalty and referral rewards for existing customers.', 'Repeat business'),
  ],
  budget: [
    channel('Google Search', 30, 'Capture high purchase intent'),
    channel('Meta / Instagram advertising', 25, 'Discovery and retargeting'),
    channel('Content / photography', 15, 'Creative and presentation'),
    channel('Email / retention', 15, 'Repeat business'),
    channel('Partnerships', 10, 'Reach and social proof'),
    channel('Testing / optimisation', 5, 'Conversion experiments'),
  ],
  first90Days: [
    period('Days 1–30', 'Margin review by product or service; customer and channel baselines; website review', 'Profitability shortlist and KPI dashboard'),
    period('Days 31–60', 'Small paid-media tests; content; email flows; partner conversations', 'CAC, conversion and contribution assessment'),
    period('Days 61–90', 'Reallocate to profitable campaigns; retention and referral tests', 'Scale or stop decisions and a revised forecast'),
  ],
  priorities: priorities([
    ['Identify the highest-contribution products or services', 'Contribution margin by product or service'],
    ['Acquire qualified customers in the target sectors', 'CAC, conversion rate, new customers'],
    ['Build repeat business', 'Repeat rate, average order value'],
    ['Test partnerships before committing budget', 'Contribution by channel'],
    MONTHLY_REVIEW,
  ]),
};

/** In tie-break order: when two templates match equally, the earlier one wins. `other` is last. */
export const INDUSTRY_TEMPLATES: readonly IndustryTemplate[] = [
  RETAIL, HOSPITALITY, PROFESSIONAL, CONSTRUCTION, TECHNOLOGY, MANUFACTURING, HEALTH, OTHER,
];

export function industryTemplate(key: IndustryKey): IndustryTemplate {
  return INDUSTRY_TEMPLATES.find((t) => t.key === key) ?? OTHER;
}

/* ------------------------------------------------------------------------------------------------ */
/* Matching                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

/** Lower case, accents folded ("Café" → "cafe"), runs of space collapsed. */
function fold(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, whole-phrase, singular or plural: "bag" finds "Bags", never "baggage"; "app" never "apparel". */
const patterns = new Map(INDUSTRY_TEMPLATES.map((t) => [
  t.key,
  t.keywords.map((k) => new RegExp(`(?<![a-z0-9])${escapeRegExp(fold(k))}(?:e?s)?(?![a-z0-9])`)),
]));

function hits(template: IndustryTemplate, text: string): number {
  if (text.length === 0) return 0;
  return (patterns.get(template.key) ?? []).filter((p) => p.test(text)).length;
}

/**
 * The template for a company, from the industry the analyst typed and what it sells. Each distinct
 * keyword found counts once; the industry counts double (it is the analyst's own classification),
 * what the company sells once. The highest score wins; on a tie, the template the INDUSTRY matched
 * more often, then the earlier template; no match at all is `other` — a sound general playbook,
 * never an error.
 */
export function templateFor(industry: string | null, productsServices: string | null): IndustryTemplate {
  const inIndustry = fold(industry ?? '');
  const inProducts = fold(productsServices ?? '');
  let best = OTHER;
  let bestScore = 0;
  let bestIndustry = 0;
  for (const template of INDUSTRY_TEMPLATES) {
    if (template.key === 'other') continue;
    const fromIndustry = hits(template, inIndustry);
    const score = 2 * fromIndustry + hits(template, inProducts);
    if (score > bestScore || (score === bestScore && score > 0 && fromIndustry > bestIndustry)) {
      best = template;
      bestScore = score;
      bestIndustry = fromIndustry;
    }
  }
  return best;
}

/* ------------------------------------------------------------------------------------------------ */
/* Offline: the template as Sections 01 and 02                                                      */
/* ------------------------------------------------------------------------------------------------ */

export interface TemplateSectionsInput {
  readonly organisationName: string;
  readonly productsServices: string | null;
  readonly industry: string | null;
  /** The example monthly test budget, already formatted in the organisation's currency ("£3,000"). */
  readonly exampleMonthlyBudget: string;
  /** The same, annualised ("£36,000"). */
  readonly exampleAnnualBudget: string;
}

const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);

/** "Bags, wallets and belts" → ["Bags", "wallets", "belts"] (at most six, each clipped to fit the schema). */
export function productList(productsServices: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (productsServices ?? '').split(/,|;|\/|\n|\band\b|&|\+/i)) {
    const item = raw.trim().replace(/\s+/g, ' ');
    if (item.length === 0 || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    out.push(clip(item.charAt(0).toUpperCase() + item.slice(1), 80));
    if (out.length === 6) break;
  }
  return out;
}

/**
 * The deterministic narrative's opening and Sections 01 and 02, for offline mode: the template as it
 * stands, with the company's name and products dropped in. Competitors are KINDS of comparator, not
 * named businesses, and the note says so — offline mode never invents a business.
 */
export function templateSections(template: IndustryTemplate, input: TemplateSectionsInput): {
  objective: string; competitors: CompetitorSection; strategy: StrategySection;
} {
  const name = clip(input.organisationName.trim() || 'The company', 120);
  const field = clip((input.industry?.trim() || input.productsServices?.trim() || template.label).toLowerCase(), 120);
  const budgeted = new Set(template.effortSplit.map((s) => s.sector));
  const overlays = template.customerSectors.map((s) => s.sector).filter((s) => !budgeted.has(s));
  const products = productList(input.productsServices);
  const productCampaigns = products.length >= 2
    ? products.map((product, i) => {
      const generic = template.productLines[i % template.productLines.length]!;
      return { product, positioning: 'A focused campaign for this line', execution: generic.execution };
    })
    : [...template.productLines];
  const [c1, c2, c3, c4] = template.concepts;

  return {
    objective: `Strategic objective: strengthen ${name}'s position in ${field}, acquire higher-quality customers, improve repeat business and protect margins. ${template.positioning}`,
    competitors: {
      brandPositioning: template.positioning,
      competitors: template.competitorTypes.map((t) => ({ name: `${t.label} (example)`, positioning: clip(t.find, 120), learning: t.learning, website: null, social: null })),
      competitorNote: 'Offline template: these are the kinds of comparator to benchmark, not named businesses. A report written by ChatGPT names comparable brands; those are directional comparators, not a ranking by market share or verified digital engagement.',
      customerSectors: [...template.customerSectors],
      effortSplit: [...template.effortSplit],
      effortNote: overlays.length === 0 ? null : `${overlays.join(' and ')} ${overlays.length === 1 ? 'is' : 'are'} treated as an overlay across the other sectors, not an additional budget line.`,
    },
    strategy: {
      digitalAcquisition: [...template.acquisition],
      productCampaigns,
      retention: [...template.retention],
      concepts: [...template.concepts],
      recommendedCombination: `Recommended combination: use "${c1?.title}" and "${c2?.title}" as the always-on foundation, "${c3?.title}" for seasonal or campaign peaks and "${c4?.title}" as a controlled pilot.`,
      budget: [...template.budget],
      budgetNote: `Example: a ${input.exampleMonthlyBudget} monthly test budget equates to ${input.exampleAnnualBudget} annualised. This is an illustrative allocation, not an approved spend recommendation. Final spend must be constrained by product contribution, customer acquisition cost and cash availability.`,
      first90Days: [...template.first90Days],
      priorities: [...template.priorities],
    },
  };
}
