/**
 * The department dashboard's view model (ADR-180) — the CONTRACT between the data services
 * (`services/dashboard/*`) and the components (`src/components/department-dashboard/*`).
 *
 * It mirrors the client's prototype (`~/Downloads/apx-prototype`, `model.js#getDashboard`) field for
 * field, with the sample numbers replaced by the company's own. Every string a reader sees is final
 * (formatted by the service); numbers are only for drawing. Pure types and constants: no I/O.
 */

export const DEPARTMENT_IDS = ['analysis', 'banking', 'capture', 'workflow', 'clients'] as const;
export type DepartmentId = (typeof DEPARTMENT_IDS)[number];

export const PERIOD_MONTHS = [1, 3, 6] as const;
export type PeriodMonths = (typeof PERIOD_MONTHS)[number];
export type ReportView = 'current' | 'last';

export interface DashboardParams {
  readonly dept: DepartmentId;
  readonly months: PeriodMonths;
  readonly view: ReportView;
}

/** The prototype's `departments` table, verbatim. */
export const DEPARTMENT_META: Readonly<Record<DepartmentId, {
  readonly name: string; readonly caption: string; readonly icon: 'chart' | 'bank' | 'capture' | 'workflow' | 'client';
  readonly kicker: string; readonly chart: string; readonly series: readonly [string, string];
  readonly unit: 'money' | 'count'; readonly mix: string;
}>> = {
  analysis: { name: 'Financial Analysis', caption: 'Understand performance', icon: 'chart', kicker: 'UNDERSTAND YOUR PERFORMANCE', chart: 'Revenue & operating costs', series: ['Revenue', 'Operating costs'], unit: 'money', mix: 'Revenue mix' },
  banking: { name: 'Banking', caption: 'Control cash & funding', icon: 'bank', kicker: 'CONTROL YOUR CASH POSITION', chart: 'Cash received & paid', series: ['Cash received', 'Cash paid'], unit: 'money', mix: 'Spending by category' },
  capture: { name: 'Data Capture', caption: 'Build reliable foundations', icon: 'capture', kicker: 'BUILD RELIABLE FOUNDATIONS', chart: 'Documents received & processed', series: ['Received', 'Processed'], unit: 'count', mix: 'Document sources' },
  workflow: { name: 'Manage Workflow', caption: 'Assign, track & review', icon: 'workflow', kicker: 'TURN PRIORITIES INTO PROGRESS', chart: 'Tasks created & completed', series: ['Tasks created', 'Tasks completed'], unit: 'count', mix: 'Open tasks by workstream' },
  clients: { name: 'Client Management', caption: 'Connect, support & grow', icon: 'client', kicker: 'BUILD STRONGER CLIENT RELATIONSHIPS', chart: 'Requests & completed reviews', series: ['Requests', 'Completed'], unit: 'count', mix: 'Customers by revenue' },
};

/** A small three-month line (the prototype's `monthSpark`) or a plain line (`spark`). */
export interface Spark {
  readonly values: readonly number[];
  /** Month labels under the points ("Jul"), or null for the plain spark. */
  readonly labels: readonly string[] | null;
  /** "Jul £214,000" — the point titles. */
  readonly titles: readonly string[];
}

export interface Metric {
  readonly label: string;
  readonly value: string;
  /** The bold first line ("18.0%", "3 accounts"). */
  readonly change: string;
  /** The second line ("vs baseline", "operating margin"). */
  readonly note: string;
  readonly spark: Spark | null;
}

export interface ChartRow {
  readonly period: string;
  readonly first: string;
  readonly second: string;
  readonly baseline: string;
}

export interface MainChart {
  readonly kicker: string;            // "PERFORMANCE OVER TIME" | "WORKFLOW PROGRESS"
  readonly title: string;             // DEPARTMENT_META.chart
  readonly series: readonly [string, string];
  readonly unit: 'money' | 'count';
  readonly labels: readonly string[]; // "Apr" …
  /** Values for drawing; null is a gap (no figure), never zero. */
  readonly first: readonly (number | null)[];
  readonly second: readonly (number | null)[];
  /** Same months a year earlier (money) or null when there is no such series. */
  readonly baseline: readonly (number | null)[] | null;
  readonly baselineLabel: string;     // "Same months last year"
  /** Formatted point titles: "Apr · Revenue: £170,000". */
  readonly firstTitles: readonly string[];
  readonly secondTitles: readonly string[];
  /** The y-axis tick labels, bottom to top, and the cap value they are drawn against. */
  readonly ticks: readonly string[];
  readonly cap: number;
  readonly insight: string;           // "Operating profit is 29.6% of revenue."
  readonly figure: string;            // "£379k"
  readonly rows: readonly ChartRow[]; // the data table and the CSV
  readonly description: string;       // the screen-reader summary
}

export interface MixSlice { readonly label: string; readonly share: number; readonly shareDisplay: string }
export interface Mix {
  readonly title: string;
  readonly total: string;     // the donut centre ("£1.28m", "1,240")
  readonly caption: string;   // "total revenue"
  readonly slices: readonly MixSlice[]; // at most 3, shares 0–100 summing to ≤ 100
}

export type PriorityIcon = 'chart' | 'search' | 'file' | 'bank' | 'shield' | 'capture' | 'link' | 'workflow' | 'client';

export interface PriorityItem {
  /** Stable id: `<kind>:<record id>`. */
  readonly id: string;
  readonly kind: 'alert' | 'action' | 'batch' | 'customer';
  readonly recordId: string;
  readonly title: string;
  readonly subtitle: string;
  readonly tag: string;
  readonly icon: PriorityIcon;
  /** Dialog: "What we see" and "Suggested next step". */
  readonly context: string;
  readonly nextStep: string;
  /** The real page for this item. */
  readonly href: string;
  readonly reviewed: boolean;
  /** A review request (engagement item) already exists for it. */
  readonly requested: boolean;
}

export interface Queue {
  readonly kicker: string;   // "YOUR NEXT MOVES" | "OWNERS · DEADLINES · REVIEW" | "YOUR REVIEW WORKSPACE"
  readonly title: string;    // "Priorities & observations" | "Tasks & approvals" | "Analyst review queue"
  readonly footnote: string;
  readonly reviewedWord: 'Reviewed' | 'Completed';
  readonly items: readonly PriorityItem[];
}

export interface ClientRow {
  readonly id: string;
  readonly name: string;
  readonly sector: string;   // "Customer · 12 invoices"
  readonly owner: string;    // "£48,200 sales"
  readonly nextReview: string;
  readonly status: 'attention' | 'on-track';
  readonly service: string;
  readonly nextStep: string;
  readonly href: string;
  readonly reviewRecorded: boolean;
}

export interface DepartmentView {
  readonly id: DepartmentId;
  readonly name: string;
  readonly kicker: string;          // "01 / UNDERSTAND YOUR PERFORMANCE"
  readonly periodCaption: string;   // "Apr – Sep 2026"
  readonly snapshotLabel: string;   // "Current · Sep 2026"
  readonly reportingCutoff: string; // "Reporting cutoff · September 2026"
  readonly metrics: readonly Metric[];
  readonly chart: MainChart;
  readonly mix: Mix;
  readonly queue: Queue;
  /** Client Management only. */
  readonly clients: readonly ClientRow[] | null;
  /** Shown when the company has no figures for this department yet. */
  readonly empty: string | null;
}

// ---------------------------------------------------------------------------------------------
// The panels below the department view (shared by every department)
// ---------------------------------------------------------------------------------------------

/** From `modules/marketing` (`domain/annual.ts`): kept structural here so this file stays pure. */
export interface KeyIndicatorCardView {
  readonly number: string; readonly change: string | null; readonly title: string; readonly value: string;
  readonly valueNote: string; readonly sentence: string; readonly focus: string;
}
export interface KeyIndicatorsPanel { readonly period: string; readonly cards: readonly KeyIndicatorCardView[]; readonly source: string }

export interface GrowthRowView { readonly rate: number; readonly revenue: string; readonly cost: string; readonly profit: string; readonly uplift: string }
export interface GrowthBaselineView {
  readonly key: string; readonly label: string; readonly profitLabel: string;
  /** Decimal strings, for the investment adjustment (done by the server action, never in a component). */
  readonly revenue: string; readonly grossProfit: string; readonly profit: string;
  readonly revenueDisplay: string; readonly profitDisplay: string;
  readonly rows: Readonly<Record<'fixed' | 'scale', readonly GrowthRowView[]>>;
}

export interface ComparativeYearView {
  readonly year: string; readonly sales: number | null; readonly cost: number | null;
  readonly salesDisplay: string; readonly costDisplay: string; readonly profitDisplay: string;
}
export interface ComparativePanel {
  readonly span: string;              // "2024–2026"
  readonly years: readonly ComparativeYearView[];
  readonly ticks: readonly string[];  // y-axis labels bottom→top
  readonly cap: number;
}

export interface MarketingPanel {
  readonly period: string;
  readonly share: number | null;      // 0–1
  readonly revenueDisplay: string; readonly spendDisplay: string; readonly shareDisplay: string;
  readonly source: string;            // where the spend comes from, in plain words
  readonly rows: readonly { readonly month: string; readonly revenue: string; readonly spend: string; readonly ratio: string }[];
}

export interface ComplianceCheck {
  readonly title: string; readonly text: string; readonly status: string;
  readonly type: 'ok' | 'warning' | 'unverified';
}

export interface WorkflowNode {
  readonly dept: DepartmentId; readonly label: string; readonly detail: string;
  readonly icon: 'file' | 'search' | 'link' | 'shield' | 'chart';
  readonly status: 'ready' | 'warning' | 'pending';
}
export interface WorkflowPanel {
  readonly nodes: readonly WorkflowNode[];
  readonly toProcess: number; readonly toProcessLabel: string;   // "documents to process"
  readonly reviewsOpen: number; readonly reviewsOpenLabel: string; // "reviews still open"
}

/** One month's actual figures for the targets check (Decimal strings; null = no figure). */
export interface TargetActuals {
  readonly month: string;             // "2026-09"
  readonly label: string;             // "Sep"
  readonly sales: string | null; readonly costs: string | null; readonly marketing: string | null;
  readonly workflowCompleted: number | null;
}
export interface TargetsPanel {
  /** The last six months with figures, oldest first — the card's sales line and the dialog's months. */
  readonly history: readonly TargetActuals[];
  readonly defaultMonth: string;
  readonly canSave: boolean;
}

export interface Identity {
  readonly name: string;
  readonly role: string;              // "Owner", "Financial Analyst", …
  readonly isAnalyst: boolean;        // may mark reviewed / complete tasks (permission-derived)
  readonly lastLogin: { readonly time: string; readonly zone: string } | null;
}

export interface DashboardExtras {
  readonly companyName: string;
  readonly companyLine: string;       // "Sep 2026 · GBP"
  readonly greeting: string;          // "Welcome back, Carl. Your business, in perspective."
  readonly identity: Identity;
  readonly keyIndicators: KeyIndicatorsPanel | null;
  readonly growth: readonly GrowthBaselineView[];
  readonly comparative: ComparativePanel | null;
  readonly marketing: MarketingPanel | null;
  readonly compliance: readonly ComplianceCheck[];
  readonly workflow: WorkflowPanel;
  readonly targets: TargetsPanel;
  /** "Sep 2026: revenue £…, operating costs £…, operating profit £… (29.6% margin)." — the templates. */
  readonly financeLine: string;
  /** Who may do what (the components hide what the reader may not do; the server refuses anyway). */
  readonly can: {
    readonly requestReview: boolean; readonly markReviewed: boolean; readonly completeTasks: boolean;
    readonly recordClientReview: boolean; readonly askAnalyst: boolean; readonly openWhatIf: boolean;
    readonly openReports: boolean; readonly openImports: boolean; readonly openBanking: boolean;
  };
  readonly links: {
    readonly analyst: string; readonly whatIf: string; readonly reports: string; readonly imports: string;
    readonly actions: string; readonly insights: string; readonly customers: string; readonly money: string;
  };
}

/** Everything the page renders: the selected department, the shared panels, the URL state. */
export interface DepartmentDashboard {
  readonly params: DashboardParams;
  readonly departments: readonly { readonly id: DepartmentId; readonly name: string; readonly caption: string; readonly icon: string }[];
  readonly view: DepartmentView;
  readonly extras: DashboardExtras;
}

// ---------------------------------------------------------------------------------------------
// Shared by every department loader
// ---------------------------------------------------------------------------------------------

export interface WindowMonth {
  readonly periodId: string;
  readonly periodStart: string;   // "2026-04-01"
  readonly label: string;         // "Apr"
  readonly longLabel: string;     // "Apr 2026"
  readonly isComplete: boolean;
  /** The same month a year earlier, when the company has that period. */
  readonly yearEarlierPeriodId: string | null;
}

/** The selected months, oldest first, and the captions the prototype shows. */
export interface MonthWindow {
  readonly months: readonly WindowMonth[];
  readonly periodCaption: string;   // "Apr – Sep 2026"
  readonly snapshotLabel: string;   // "Current · Sep 2026" | "Last Completed · Aug 2026"
  readonly reportingCutoff: string; // "Reporting cutoff · September 2026"
  readonly currency: string;
  /**
   * ADDED (optional): up to six months ending at the same anchor, oldest first, whatever the selected
   * period — the prototype's three-month sparks and the targets history read beyond a one- or
   * three-month window. Always set by `loadWindow`.
   */
  readonly recent?: readonly WindowMonth[];
}

/**
 * The prototype's chart scale (`renderChart`): the largest value × 1.17, rounded up to a step, with
 * five gridlines. Steps follow `deptStep` but adapt to small companies so a chart is never flat.
 */
export function chartScale(values: readonly (number | null)[]): { cap: number; ticks: readonly number[] } {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const max = Math.max(0, ...known) * 1.17;
  if (max <= 0) return { cap: 4, ticks: [0, 1, 2, 3, 4] };
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  const cap = Math.ceil(max / step) * step;
  return { cap, ticks: [0, 1, 2, 3, 4].map((i) => (cap * i) / 4) };
}
