/**
 * The systems a company may use (ADR-158; owner, 2026-10-07: "only super admin can decide which
 * systems they can use"). Pure.
 *
 * Each switchable system is a key in `organizations.features`. A key that is ABSENT means the system
 * is on — every company that existed before this decision keeps everything it had — except the two
 * systems that were already switches and default off (Funding Readiness, AI document reading), which
 * keep their own keys and semantics. Home, Money (profit and loss, cash, what is owed), Insights,
 * Departments, Data & Forms, Notifications and Settings are always on: they are what MOTION is.
 *
 * Only a super admin changes these (`api.set_org_module`). A system that is off is gone, not
 * disabled: its sidebar item, tabs and Departments tile are absent, its pages answer "not found",
 * and the AI Analyst neither offers nor runs its tools.
 */

export const MODULE_KEYS = [
  'banking', 'customers', 'actions', 'reports', 'analyst', 'planning', 'tax', 'funding', 'documents_ai',
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export interface ModuleDefinition {
  readonly key: ModuleKey;
  readonly label: string;
  readonly description: string;
  /** The `organizations.features` key that holds the switch. */
  readonly featureKey: string;
  /** Whether an absent key means on (new switches) or off (the two that were already opt-in). */
  readonly defaultOn: boolean;
}

export const MODULES: readonly ModuleDefinition[] = [
  { key: 'banking', label: 'Banking', description: 'Bank accounts, statements, transactions and reconciliation.', featureKey: 'module_banking', defaultOn: true },
  { key: 'customers', label: 'Customers', description: 'Customers, products, sales and marketing.', featureKey: 'module_customers', defaultOn: true },
  { key: 'actions', label: 'Actions & Requests', description: 'The Action Centre, and requests and deliverables.', featureKey: 'module_actions', defaultOn: true },
  { key: 'reports', label: 'Reports', description: 'Daily, weekly, monthly, adviser and custom reports.', featureKey: 'module_reports', defaultOn: true },
  { key: 'analyst', label: 'AI Analyst', description: 'Questions answered by the AI Analyst, and the AI in custom reports.', featureKey: 'module_analyst', defaultOn: true },
  { key: 'planning', label: 'Planning', description: 'Forecast, What-if scenarios and Budget.', featureKey: 'module_planning', defaultOn: true },
  { key: 'tax', label: 'Tax & Balance sheet', description: 'VAT return, Corporation Tax, and assets and loans.', featureKey: 'module_tax', defaultOn: true },
  { key: 'funding', label: 'Funding Readiness', description: 'The indicative funding readiness assessment and report.', featureKey: 'funding_readiness', defaultOn: false },
  { key: 'documents_ai', label: 'AI document reading', description: 'Reading PDF statements and receipts with AI.', featureKey: 'ai_pdf_extraction', defaultOn: false },
];

const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function moduleDefinition(key: ModuleKey): ModuleDefinition {
  return BY_KEY.get(key)!;
}

/** The systems a company's features switch on. */
export function enabledModules(features: Readonly<Record<string, unknown>> | null | undefined): ReadonlySet<ModuleKey> {
  const out = new Set<ModuleKey>();
  for (const m of MODULES) {
    const value = features?.[m.featureKey];
    if (value === true || (value === undefined && m.defaultOn)) out.add(m.key);
  }
  return out;
}

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}
