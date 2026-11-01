/**
 * Pure builders for the panels below the department view (ADR-180): the masthead's greeting and last
 * login, the year panels (from `modules/marketing`'s annual figures), Compliance View, the workflow
 * infographic and the templates' finance line — the prototype's `operations.js` wording with the
 * company's own counts. No I/O, no clock.
 */
import { Decimal, ROUND_HALF_UP, formatMoney } from '@/core/money';
import type {
  ComparativeYear, GrowthBaseline, KeyIndicatorsView, MarketingSource, MarketingWindow,
} from '@/modules/marketing';
import {
  chartScale,
  type ComparativePanel, type ComplianceCheck, type GrowthBaselineView, type KeyIndicatorsPanel, type MarketingPanel,
  type WorkflowNode, type WorkflowPanel,
} from './dashboard';
import { compactMoney, formatCount } from './dashboard-ops';

// ---------------------------------------------------------------------------------------------
// The masthead
// ---------------------------------------------------------------------------------------------

/** "Carl" from "Carl Jones"; the email's local part, or null, when there is no name. */
export function firstName(fullName: string | null, email: string | null): string | null {
  const name = fullName?.trim();
  if (name) return name.split(/\s+/)[0]!;
  const local = email?.split('@')[0]?.trim();
  return local ? local : null;
}

/** The prototype's two greetings: the company's, and the analyst's (APX staff). */
export function greeting(name: string | null, staff: boolean): string {
  const who = name ?? 'there';
  return staff ? `Welcome back, ${who}. Turn information into action.` : `Welcome back, ${who}. Your business, in perspective.`;
}

/** "17 Oct 2026 · 09:42" and the zone ("BST", "GMT+4") in `timeZone`; null for an unreadable time. */
export function lastLoginLabel(iso: string | null, timeZone: string): { time: string; zone: string } | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone }).format(date);
  } catch {
    zone = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZone: zone, timeZoneName: 'short',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const month = get('month').replace('Sept', 'Sep');
  return { time: `${get('day')} ${month} ${get('year')} · ${get('hour')}:${get('minute')}`, zone: get('timeZoneName') || zone };
}

// ---------------------------------------------------------------------------------------------
// The year panels
// ---------------------------------------------------------------------------------------------

export function keyIndicatorsPanel(view: KeyIndicatorsView): KeyIndicatorsPanel {
  return { period: view.period, cards: view.cards.map((c) => ({ ...c })), source: view.source };
}

export function growthView(baselines: readonly GrowthBaseline[], currency: string): GrowthBaselineView[] {
  const whole = (v: string) => formatMoney(new Decimal(v).toFixed(2), { currency, showMinorUnits: false });
  return baselines.map((b) => ({
    key: b.key, label: b.label, profitLabel: b.profitLabel,
    revenue: b.revenue, grossProfit: b.grossProfit, profit: b.profit,
    revenueDisplay: whole(b.revenue), profitDisplay: whole(b.profit),
    rows: { fixed: b.rows.fixed.map((r) => ({ ...r })), scale: b.rows.scale.map((r) => ({ ...r })) },
  }));
}

/** The calendar year a Section 03 label names: "2026 (9 months)" → "2026". */
const yearOfLabel = (label: string) => /^\d{4}/.exec(label)?.[0] ?? label;

export function comparativePanel(years: readonly ComparativeYear[], currency: string): ComparativePanel | null {
  if (years.length === 0) return null;
  const num = (v: string | null) => (v === null ? null : new Decimal(v).toNumber());
  const drawn = years.map((y) => ({ sales: num(y.sales), cost: num(y.cost) }));
  const scale = chartScale(drawn.flatMap((d) => [d.sales, d.cost]));
  const first = yearOfLabel(years[0]!.year), last = yearOfLabel(years[years.length - 1]!.year);
  return {
    span: first === last ? first : `${first}–${last}`,
    years: years.map((y, i) => ({
      year: y.year, sales: drawn[i]!.sales, cost: drawn[i]!.cost,
      salesDisplay: y.salesDisplay, costDisplay: y.costDisplay, profitDisplay: y.profitDisplay,
    })),
    ticks: scale.ticks.map((t) => compactMoney(new Decimal(t), currency)),
    cap: scale.cap,
  };
}

const SOURCE_WORDS: Readonly<Record<'accounts' | 'campaigns' | 'none', string>> = {
  accounts: 'Marketing spend is the spend on accounts classified as Marketing in APX.',
  campaigns: 'Marketing spend is the campaign spend recorded in APX; no spend is recorded on accounts classified as Marketing.',
  none: 'No marketing spend is recorded in APX for these months: no account classified as Marketing carries any, and no campaign spend is recorded.',
};

export function marketingPanel(m: MarketingWindow, currency: string): MarketingPanel {
  const whole = (v: string | null) => (v === null ? '—' : formatMoney(new Decimal(v).toFixed(2), { currency, showMinorUnits: false }));
  const ratio = (spend: string | null, revenue: string | null) => {
    if (spend === null || revenue === null || !new Decimal(revenue).greaterThan(0)) return '—';
    return `${new Decimal(spend).dividedBy(revenue).times(100).toDecimalPlaces(1, ROUND_HALF_UP).toFixed(1)}%`;
  };
  const source: MarketingSource = m.source;
  return {
    period: m.period,
    share: m.share,
    revenueDisplay: m.revenueDisplay,
    spendDisplay: m.spendDisplay,
    shareDisplay: m.shareDisplay,
    source: SOURCE_WORDS[source ?? 'none'],
    rows: m.months.map((r) => ({ month: r.label, revenue: whole(r.revenue), spend: whole(r.spend), ratio: ratio(r.spend, r.revenue) })),
  };
}

// ---------------------------------------------------------------------------------------------
// Compliance View and the workflow infographic
// ---------------------------------------------------------------------------------------------

export interface ReadinessFacts {
  /** Import batches; null when the reader may not see imports. */
  readonly batches: { readonly awaitingReview: number; readonly recordsReceived: number } | null;
  /** Actions; null when the reader may not see the Action Centre. */
  readonly actions: {
    readonly open: number; readonly total: number;
    /** Created in the window, and of those completed. */
    readonly windowTotal: number; readonly windowCompleted: number;
  } | null;
  /** The statutory dates the tax module states, already in words; null when none can be stated. */
  readonly filings: string | null;
  /** A monthly report exists for the window's last month. */
  readonly reportReady: boolean;
}

/** The prototype's `checks()`, with the company's own facts. */
export function complianceChecks(f: ReadinessFacts): ComplianceCheck[] {
  const pending = f.batches?.awaitingReview ?? 0;
  const open = f.actions?.open ?? 0;
  return [
    { title: 'Accounting integration', text: 'Xero is not connected', status: 'Not connected', type: 'warning' },
    f.batches === null
      ? { title: 'Data completion', text: 'Uploads are checked by the people who review imports', status: 'Not verified', type: 'unverified' }
      : {
        title: 'Data completion',
        text: `${formatCount(pending)} ${pending === 1 ? 'upload awaits' : 'uploads await'} review`,
        status: pending > 0 ? 'Incomplete' : 'Complete', type: pending > 0 ? 'warning' : 'ok',
      },
    f.actions === null
      ? { title: 'Workflow review', text: 'Actions are shown to the people who can open the Action Centre', status: 'Not verified', type: 'unverified' }
      : {
        title: 'Workflow review',
        text: `${formatCount(open)} of ${formatCount(f.actions.total)} open actions still to review`,
        status: open > 0 ? 'Pending' : 'Reviewed', type: open > 0 ? 'warning' : 'ok',
      },
    {
      title: 'Statutory filings',
      text: f.filings ?? 'No filing evidence or compliance source is connected',
      status: 'Not verified', type: 'unverified',
    },
  ];
}

/** The prototype's `renderWorkflow()`: Source → Validate → Reconcile → Approve → Report. */
export function workflowPanel(f: ReadinessFacts): WorkflowPanel {
  const pending = f.batches?.awaitingReview ?? 0;
  const approved = f.actions?.windowCompleted ?? 0, inWindow = f.actions?.windowTotal ?? 0;
  const nodes: WorkflowNode[] = [
    {
      dept: 'capture', label: 'Source data', icon: 'file', status: 'ready',
      detail: f.batches === null ? 'Uploads received' : `${formatCount(f.batches.recordsReceived)} records received`,
    },
    { dept: 'capture', label: 'Validate', icon: 'search', detail: `${formatCount(pending)} pending`, status: pending > 0 ? 'warning' : 'ready' },
    { dept: 'banking', label: 'Reconcile', icon: 'link', detail: 'Xero not connected', status: 'warning' },
    {
      dept: 'workflow', label: 'Approve', icon: 'shield',
      detail: `${formatCount(approved)} of ${formatCount(inWindow)} reviewed`, status: approved < inWindow ? 'warning' : 'ready',
    },
    {
      dept: 'analysis', label: 'Report', icon: 'chart',
      detail: f.reportReady ? 'Latest monthly report ready' : 'Complete the readiness checks',
      status: f.reportReady ? 'ready' : 'pending',
    },
  ];
  return {
    nodes,
    toProcess: pending, toProcessLabel: pending === 1 ? 'document to process' : 'documents to process',
    reviewsOpen: f.actions?.open ?? 0, reviewsOpenLabel: (f.actions?.open ?? 0) === 1 ? 'review still open' : 'reviews still open',
  };
}

// ---------------------------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------------------------

/**
 * The prototype's finance string: "Current · Sep 2026 · Apr – Sep 2026: revenue £1,280,000, operating
 * costs £901,000, operating profit £379,000 (29.6% margin)."
 */
export function financeLine(
  snapshotLabel: string, periodCaption: string, revenue: Decimal | null, profit: Decimal | null, currency: string,
): string {
  const whole = (v: Decimal | null) => (v === null ? 'not available' : formatMoney(v.toFixed(2), { currency, showMinorUnits: false }));
  const costs = revenue !== null && profit !== null ? revenue.minus(profit) : null;
  const margin = revenue !== null && profit !== null && revenue.greaterThan(0)
    ? ` (${profit.dividedBy(revenue).times(100).toDecimalPlaces(1, ROUND_HALF_UP).toFixed(1)}% margin)` : '';
  return `${snapshotLabel} · ${periodCaption}: revenue ${whole(revenue)}, operating costs ${whole(costs)}, operating profit ${whole(profit)}${margin}.`;
}
