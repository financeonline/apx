/**
 * Data progress (owner, 2026-11-02: "click on that and show the actual progress of where it is and
 * what we are stuck on"): the dashboard's Compliance View card and the page it opens,
 * `/app/<slug>/data/progress`. Pure builders over facts the service reads — each upload's place in
 * the import pipeline, which months each source covers, and the blockers in the order to fix them.
 * No I/O, no clock: `today` and every date arrive as ISO strings.
 */

// ---------------------------------------------------------------------------------------------
// Dates (ISO `YYYY-MM-DD`, `YYYY-MM`)
// ---------------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const DAY_MS = 86_400_000;

/** "29 Oct 2026" from an ISO date or timestamp (its UTC day, as `formatDate`); "—" when unreadable. */
export function shortDate(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '—';
  const month = Number(iso.slice(5, 7));
  if (month < 1 || month > 12) return '—';
  const day = iso.length > 10 ? new Date(iso) : null;
  if (day !== null && !Number.isNaN(day.getTime())) {
    return `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
  }
  return `${Number(iso.slice(8, 10))} ${MONTHS[month - 1]} ${iso.slice(0, 4)}`;
}

/** "Aug 2026" from `2026-08` or `2026-08-01`. */
export function monthLabel(ym: string): string {
  const month = Number(ym.slice(5, 7));
  return `${MONTHS[month - 1] ?? '?'} ${ym.slice(0, 4)}`;
}

/** `count` month keys ending at `endYm`, oldest first. */
export function monthKeys(endYm: string, count: number): string[] {
  const y = Number(endYm.slice(0, 4)), m = Number(endYm.slice(5, 7));
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const index = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Every month key from `fromYm` to `toYm` inclusive (empty when `from` is after `to`). */
export function monthsBetween(fromYm: string, toYm: string): string[] {
  const index = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
  const count = index(toYm) - index(fromYm) + 1;
  return count <= 0 ? [] : monthKeys(toYm, count);
}

/** The month before `ym`. */
export function previousMonth(ym: string): string {
  return monthKeys(ym, 2)[0]!;
}

const dayNumber = (iso: string) => Math.floor(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS);

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

export type ProgressSource = 'bank' | 'accounts' | 'sales' | 'purchases' | 'balance_sheet' | 'budget';

export const PROGRESS_SOURCES: readonly ProgressSource[] = ['bank', 'accounts', 'sales', 'purchases', 'balance_sheet', 'budget'];

export const SOURCE_LABELS: Readonly<Record<ProgressSource, string>> = {
  bank: 'Bank statements',
  accounts: 'Accounts (ledger or trial balance)',
  sales: 'Sales invoices',
  purchases: 'Purchase invoices',
  balance_sheet: 'Balance sheet',
  budget: 'Budget',
};

/** Which source an import type feeds; null for a type the page does not track. */
export function sourceOf(importType: string): ProgressSource | null {
  switch (importType) {
    case 'bank_statement': return 'bank';
    case 'general_ledger': case 'trial_balance': case 'pnl_report': return 'accounts';
    case 'sales_invoices': case 'sales_report': return 'sales';
    case 'purchase_invoices': case 'purchase_report': case 'receipts': return 'purchases';
    case 'balance_sheet': return 'balance_sheet';
    case 'budget': return 'budget';
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------
// One upload's place in the pipeline
// ---------------------------------------------------------------------------------------------

export const PIPELINE_STEPS = [
  'Uploaded', 'Read', 'Columns matched', 'Checked', 'Waiting for your review', 'In the books', 'Figures recalculated',
] as const;

export type StepState = 'done' | 'current' | 'waiting' | 'failed' | 'stopped' | 'todo';
export type PipelineTone = 'good' | 'active' | 'attention' | 'failed' | 'muted';

export interface PipelineView {
  readonly steps: readonly { readonly label: string; readonly state: StepState }[];
  /** The upload's state in words: "In your figures", "Needs your review", … */
  readonly summary: string;
  readonly tone: PipelineTone;
  /** Something the reader must do (review it, or fix a failed file). */
  readonly needsYou: boolean;
}

export interface PipelineInput {
  readonly status: string;
  readonly committedAt: string | null;
  /** `error_summary.stage` of a failed upload. */
  readonly errorStage: string | null;
  /** When the latest SUCCESSFUL calculation finished; null before the first. */
  readonly recalculatedAt: string | null;
  /** A calculation is queued or running now. */
  readonly recalculating: boolean;
  /** The latest calculation run failed, and started after this upload went into the books. */
  readonly runFailedSinceCommit: boolean;
}

/** The step a failed upload stopped at, from the stage `fail_import_batch` recorded. */
function failedStep(stage: string | null): number {
  const s = (stage ?? '').toLowerCase();
  if (s.startsWith('map')) return 2;
  if (s.startsWith('valid') || s.startsWith('check') || s.startsWith('dedupe')) return 3;
  if (s.startsWith('commit')) return 5;
  return 1;
}

function pipeline(done: number, at: StepState | null, summary: string, tone: PipelineTone, needsYou = false): PipelineView {
  return {
    steps: PIPELINE_STEPS.map((label, i) => ({
      label, state: i < done ? 'done' : i === done && at !== null ? at : 'todo',
    })),
    summary, tone, needsYou,
  };
}

/** `import_batches.status` (and the latest calculation) → the seven steps the page draws. */
export function batchPipeline(input: PipelineInput): PipelineView {
  switch (input.status) {
    case 'created': return pipeline(1, 'current', 'Waiting to be read', 'active');
    case 'parsing': return pipeline(1, 'current', 'Being read', 'active');
    case 'mapping': return pipeline(2, 'current', 'Matching its columns', 'active');
    case 'validating': return pipeline(3, 'current', 'Being checked', 'active');
    case 'awaiting_review': return pipeline(4, 'waiting', 'Needs your review', 'attention', true);
    case 'committing': return pipeline(5, 'current', 'Going into the books', 'active');
    case 'committed': {
      const counted = input.committedAt !== null && input.recalculatedAt !== null && input.recalculatedAt >= input.committedAt;
      if (counted) return pipeline(7, null, 'In your figures', 'good');
      if (input.recalculating) return pipeline(6, 'current', 'Recalculating your figures', 'active');
      if (input.runFailedSinceCommit) return pipeline(6, 'failed', 'In the books — the recalculation failed', 'failed');
      return pipeline(6, 'waiting', 'In the books — waiting for the next recalculation', 'active');
    }
    case 'rolled_back': return pipeline(6, 'stopped', 'Removed from your figures', 'muted');
    case 'rejected': return pipeline(4, 'stopped', 'Discarded at review', 'muted');
    case 'failed': {
      const step = failedStep(input.errorStage);
      return pipeline(step, 'failed', step === 1 ? 'Could not be read' : `Stopped at “${PIPELINE_STEPS[step]}”`, 'failed', true);
    }
    default: return pipeline(1, 'current', 'In progress', 'active');
  }
}

// ---------------------------------------------------------------------------------------------
// Month coverage
// ---------------------------------------------------------------------------------------------

export interface DateRange { readonly start: string; readonly end: string }
export type MonthCoverage = 'full' | 'partial' | 'none';

/** Ranges merged where they overlap or touch, sorted. */
function merged(ranges: readonly DateRange[]): Array<[number, number]> {
  const spans = ranges
    .filter((r) => /^\d{4}-\d{2}-\d{2}/.test(r.start) && /^\d{4}-\d{2}-\d{2}/.test(r.end) && r.start <= r.end)
    .map((r) => [dayNumber(r.start), dayNumber(r.end)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const span of spans) {
    const last = out.at(-1);
    if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else out.push([...span]);
  }
  return out;
}

/**
 * How much of each month the DECLARED ranges cover (ADR-047.6: the range the reviewer confirmed, not
 * the first and last posting date): every day, some days, or none.
 */
export function coverageByMonth(ranges: readonly DateRange[], months: readonly string[]): MonthCoverage[] {
  const spans = merged(ranges);
  return months.map((ym) => {
    const first = dayNumber(`${ym}-01`);
    const last = first + daysIn(ym) - 1;
    let covered = 0;
    for (const [s, e] of spans) {
      const from = Math.max(s, first), to = Math.min(e, last);
      if (from <= to) covered += to - from + 1;
    }
    return covered === 0 ? 'none' : covered >= last - first + 1 ? 'full' : 'partial';
  });
}

function daysIn(ym: string): number {
  return new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
}

export type CoverageCell = MonthCoverage | 'gap';

/**
 * The strip's cells with the gaps marked: a month no upload touches, from the source's first covered
 * month up to `toYm` (the last month the company's data reaches, never the month still running).
 */
export function markGaps(cells: readonly MonthCoverage[], months: readonly string[], toYm: string | null): CoverageCell[] {
  const first = cells.findIndex((c) => c !== 'none');
  return cells.map((cell, i) => (cell === 'none' && first >= 0 && i > first && toYm !== null && months[i]! <= toYm ? 'gap' : cell));
}

/** The months between `fromYm` and `toYm` that no range touches at all. */
export function missingMonths(ranges: readonly DateRange[], fromYm: string, toYm: string): string[] {
  const months = monthsBetween(fromYm, toYm);
  const coverage = coverageByMonth(ranges, months);
  return months.filter((_, i) => coverage[i] === 'none');
}

/** "Aug 2026", "Jun and Aug 2026", "Jun, Jul and Aug 2026"; long runs end "and 5 more". */
export function monthList(months: readonly string[], max = 4): string {
  const shown = months.slice(0, max).map(monthLabel);
  const rest = months.length - shown.length;
  const sameYear = months.length > 0 && months.every((m) => m.slice(0, 4) === months[0]!.slice(0, 4));
  const words = sameYear && rest === 0 ? shown.map((label, i) => (i === shown.length - 1 ? label : label.slice(0, 3))) : shown;
  if (rest > 0) return `${words.join(', ')} and ${rest} more`;
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

// ---------------------------------------------------------------------------------------------
// What we are stuck on
// ---------------------------------------------------------------------------------------------

export type BlockerKind =
  | 'run_failed' | 'upload_failed' | 'awaiting_review' | 'no_opening_balance' | 'no_statement' | 'bank_gap'
  | 'month_gap' | 'behind' | 'unmapped_accounts' | 'uncategorised' | 'balances_missing' | 'waiting_recalc'
  | 'vat_setup' | 'ct_overdue' | 'ct_unknown';

export interface Blocker {
  readonly kind: BlockerKind;
  /** One plain-English sentence: what is wrong and what it stops. */
  readonly sentence: string;
  /** A second line (an upload's error, the file's name); null when there is none. */
  readonly detail: string | null;
  /** The page that fixes it; null when the reader can only wait. */
  readonly action: { readonly label: string; readonly href: string } | null;
  /** Counts towards "N things need you"; false for what only needs waiting for. */
  readonly needsYou: boolean;
  /** For ties within a kind: the newest first. */
  readonly at?: string | null;
}

/** The order to fix things in: what stops every figure first, then each source, then tax. */
const BLOCKER_RANK: Readonly<Record<BlockerKind, number>> = {
  run_failed: 0,
  upload_failed: 1,
  awaiting_review: 2,
  no_opening_balance: 3,
  no_statement: 4,
  bank_gap: 5,
  month_gap: 6,
  behind: 7,
  unmapped_accounts: 8,
  uncategorised: 9,
  balances_missing: 10,
  waiting_recalc: 11,
  vat_setup: 12,
  ct_overdue: 13,
  ct_unknown: 14,
};

export function orderBlockers(blockers: readonly Blocker[]): Blocker[] {
  return [...blockers].sort((a, b) => BLOCKER_RANK[a.kind] - BLOCKER_RANK[b.kind]
    || (b.at ?? '').localeCompare(a.at ?? '')
    || a.sentence.localeCompare(b.sentence));
}

export type HeadlineKind = 'failed' | 'updating' | 'needs_you' | 'up_to_date';

export interface Headline {
  readonly kind: HeadlineKind;
  readonly title: string;
  readonly line: string;
}

/** The page's one-line state. A failed run outranks a waiting list: every figure is affected. */
export function headlineStatus(f: {
  readonly recalculating: boolean; readonly lastRunFailed: boolean; readonly needsYou: number;
  /** Uploads in the books that the figures do not include yet (no recalculation since). */
  readonly waitingForUpdate?: number;
}): Headline {
  const things = `${f.needsYou} ${f.needsYou === 1 ? 'thing needs' : 'things need'} you`;
  if (f.lastRunFailed && !f.recalculating) {
    return { kind: 'failed', title: 'Last update failed', line: 'Your figures are from the last update that worked. The list below says what to check.' };
  }
  if (f.recalculating) {
    return { kind: 'updating', title: 'Updating your numbers', line: f.needsYou > 0 ? `APX is recalculating your figures. Meanwhile, ${things}.` : 'APX is recalculating your figures from the latest data.' };
  }
  if (f.needsYou > 0) return { kind: 'needs_you', title: things, line: 'Each item below says what is wrong and opens the page that fixes it.' };
  const waiting = f.waitingForUpdate ?? 0;
  if (waiting > 0) {
    return {
      kind: 'up_to_date', title: 'Up to date',
      line: `Nothing needs you. ${waiting === 1 ? 'One upload goes' : `${waiting} uploads go`} into your figures at the next update.`,
    };
  }
  return { kind: 'up_to_date', title: 'Up to date', line: 'Nothing is waiting for you: your uploads are in and your figures are current.' };
}

// ---------------------------------------------------------------------------------------------
// The dashboard's Compliance View card (the older Home "Workspace status" lines, ADR-179)
// ---------------------------------------------------------------------------------------------

export interface ComplianceRowView {
  readonly key: 'uploads' | 'last' | 'vat' | 'ct';
  readonly title: string;
  readonly value: string;
  readonly attention: boolean;
  /** The row's own page, above the card's link. */
  readonly href: string;
}

export interface ComplianceCardView {
  readonly recalculating: boolean;
  /** "Figures up to date" / "Updating your numbers". */
  readonly status: string;
  /** "Based on your accounts, bank statements and invoices · Last data added 29 Oct 2026 · Sep 2026 (latest complete month)". */
  readonly basisLine: string;
  readonly rows: readonly ComplianceRowView[];
  /** The whole card's link — the Data progress page; null for a reader who may not open it. */
  readonly progressHref: string | null;
}

export interface ComplianceCardFacts {
  readonly base: string;
  readonly recalculating: boolean;
  readonly basisLine: string;
  /** Null when the reader may not see imports (`imports.review`): the upload lines are left out. */
  readonly imports: { readonly awaitingReview: number; readonly failed: number } | null;
  readonly lastDataAdded: string | null;
  readonly canAddData: boolean;
  /** Null when the reader may not see the tax dates: the VAT and Corporation Tax lines are left out. */
  readonly tax: {
    readonly vatRegistered: boolean | null;
    readonly vatQuarter: { readonly end: string } | null;
    readonly corporationTax: { readonly dueDate: string } | null;
  } | null;
  readonly today: string;
}

/** The card's lines, as the older Home's "Workspace status" worded them; a line the reader may not see is left out. */
export function complianceCard(f: ComplianceCardFacts): ComplianceCardView {
  const rows: ComplianceRowView[] = [];
  if (f.imports !== null) {
    rows.push({
      key: 'uploads', title: 'Uploads waiting for review', href: `${f.base}/data/imports`,
      value: f.imports.failed > 0 ? `${f.imports.awaitingReview} · ${f.imports.failed} failed` : String(f.imports.awaitingReview),
      attention: f.imports.awaitingReview > 0 || f.imports.failed > 0,
    });
    rows.push({
      key: 'last', title: 'Last data added', href: f.canAddData ? `${f.base}/data/imports/new` : `${f.base}/data/imports`,
      value: f.lastDataAdded === null ? 'Nothing yet' : shortDate(f.lastDataAdded), attention: false,
    });
  }
  if (f.tax !== null) {
    rows.push({
      key: 'vat', title: 'VAT', href: `${f.base}/money/tax`, attention: false,
      value: f.tax.vatQuarter === null
        ? (f.tax.vatRegistered === true ? 'Set your quarter months' : 'Not set up')
        : `Quarter ends ${shortDate(f.tax.vatQuarter.end)}`,
    });
    rows.push({
      key: 'ct', title: 'Corporation Tax', href: `${f.base}/money/tax`,
      value: f.tax.corporationTax === null ? 'No date yet' : `Due ${shortDate(f.tax.corporationTax.dueDate)}`,
      attention: f.tax.corporationTax !== null && f.tax.corporationTax.dueDate < f.today,
    });
  }
  return {
    recalculating: f.recalculating,
    status: f.recalculating ? 'Updating your numbers' : 'Figures up to date',
    basisLine: f.basisLine,
    rows,
    progressHref: f.imports === null ? null : `${f.base}/data/progress`,
  };
}
