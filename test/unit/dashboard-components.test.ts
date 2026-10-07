import { describe, it, expect } from 'vitest';
import {
  ACTIONS_NONE,
  ALERTS_NONE,
  ANALYST_NO_CONVERSATIONS,
  ANALYST_NO_DATA,
  ANALYST_SUGGESTIONS,
  CUSTOMERS_NONE,
  HOME_FIRST_RUN,
  INSIGHTS_NEEDS_TWO_PERIODS,
  MONEY_NO_INVOICES,
  PLATFORM_NO_ORGANISATIONS,
  PORTFOLIO_NO_ASSIGNMENTS,
  REPORTS_BEFORE_FIRST_MONTH,
  homeAwaitingReview,
  homeBankDataOnly,
  insightsNoAdjacentMonth,
} from '@/components/dashboard/empty-state-copy';
import {
  DENIED_TITLE,
  ERROR_COPY,
  NOT_FOUND_TITLE,
  RECALCULATING_TITLE,
  SLOW_LOADING_TEXT,
  STALE_FIGURE_TEXT,
  SUSPENDED_TITLE,
  deniedBody,
  duplicateAtConfirmBody,
  recalculatingProgress,
} from '@/components/dashboard/state-copy';
import {
  BADGE_SIZE_CLASS,
  BASIS_DIFFERS_TEXT,
  CHART_STROKE,
  STATUS_LABELS,
  chartClass,
  chartDash,
  changeToneClass,
  changeToneWord,
  scaleFor,
  segmentsFor,
  statusTone,
  toPeriodOptions,
  type TrendSeriesView,
} from '@/components/dashboard/presentation';
import { statusFor, type StatusKind } from '@/modules/dashboard';

/**
 * The pure half of the dashboard component library.
 *
 * No DOM library is installed, and none is added for this: the components are deliberately thin
 * wrappers round the functions and constants below, so the rules worth protecting — the exact
 * empty-state wording of §6, the canonical badge table of §8.1, the gap in a chart line — are all
 * testable without rendering anything. What the JSX adds on top is arrangement, and arrangement is
 * checked by eye on `/dev/components`.
 *
 * The expected strings here are transcribed from UX_ARCHITECTURE.md §6–§7 rather than imported
 * twice, so a change to the copy fails the test instead of quietly agreeing with itself.
 */

describe('empty-state copy is word for word (UX_ARCHITECTURE.md §6)', () => {
  it('Home, first run', () => {
    expect(HOME_FIRST_RUN.title).toBe("Let's get your first numbers on screen.");
    expect(HOME_FIRST_RUN.body).toBe(
      "MOTION works from files you already have. Upload a bank statement (CSV or PDF) or an export from your accounting software and we'll show you how the business is doing, what's changed and what needs attention.",
    );
    expect(HOME_FIRST_RUN.hint).toBe(
      "Start with a bank statement to see your cash position. Add a ledger export, trial balance or invoice list when you can, and we'll add profit and customer figures.",
    );
    expect(HOME_FIRST_RUN.primaryLabel).toBe('Add data');
    expect(HOME_FIRST_RUN.secondaryLabel).toBe('What files can I upload?');
  });

  it('Home, bank data only', () => {
    const copy = homeBankDataOnly('March');
    expect(copy.title).toBe("Here's what your bank statement tells us.");
    expect(copy.body).toBe(
      'Money in, money out and the change in cash for March. To see your cash balance, enter the balance at the start of the statement. To see profit and customers, add a ledger export or your invoice lists.',
    );
    expect(copy.primaryLabel).toBe('Enter opening balance');
    expect(copy.secondaryLabel).toBe('Add data');
  });

  it('Home, bank data only names the organisation own month', () => {
    expect(homeBankDataOnly('September').body).toContain('the change in cash for September.');
  });

  it('Home, data uploaded but not yet committed', () => {
    const copy = homeAwaitingReview({ rowCount: 312, filename: 'march-statement.csv', issueCount: 4 });
    expect(copy.title).toBe('Your import is waiting for review.');
    expect(copy.body).toBe(
      'We found 312 rows in march-statement.csv. Check the 4 items we flagged, then confirm, and your numbers will appear here.',
    );
    expect(copy.primaryLabel).toBe('Review import');
  });

  it('Insights, fewer than two periods of data', () => {
    expect(INSIGHTS_NEEDS_TWO_PERIODS.title).toBe('We need two months to show what changed.');
    expect(INSIGHTS_NEEDS_TWO_PERIODS.body).toBe(
      'Insights compares this month with last month. Add another month of data and this page will show you the biggest movements and why they happened.',
    );
    expect(INSIGHTS_NEEDS_TWO_PERIODS.primaryLabel).toBe('Add data');
  });

  it('Insights, no adjacent month', () => {
    const copy = insightsNoAdjacentMonth({ period: 'March', comparison: 'January', missing: 'February' });
    expect(copy.title).toBe('Comparing March with January.');
    expect(copy.body).toBe(
      "We don't have February yet, so changes are shown against the nearest earlier month we do have. Add February to compare month to month.",
    );
    expect(copy.primaryLabel).toBe('Add data');
  });

  it('Money → Owed to you / You owe, no invoices', () => {
    expect(MONEY_NO_INVOICES.title).toBe('No invoices yet.');
    expect(MONEY_NO_INVOICES.body).toBe(
      "Upload a sales invoice list or purchase invoice list to see who owes you, who you owe, and what's overdue. If you only use bank statements, this page will stay empty — that's fine.",
    );
    expect(MONEY_NO_INVOICES.primaryLabel).toBe('Add data');
  });

  it('Customers, no invoices or customer-tagged entries', () => {
    expect(CUSTOMERS_NONE.title).toBe("We don't know your customers yet.");
    expect(CUSTOMERS_NONE.body).toBe(
      "Customer insights come from invoices. Upload your sales invoice list and we'll show you who your biggest customers are and how much you rely on them.",
    );
    expect(CUSTOMERS_NONE.primaryLabel).toBe('Add data');
  });

  it('Actions, none', () => {
    expect(ACTIONS_NONE.title).toBe('Nothing to do right now.');
    expect(ACTIONS_NONE.body).toBe(
      'Actions appear here when you turn an alert or an analyst recommendation into a task, or create one yourself.',
    );
    expect(ACTIONS_NONE.primaryLabel).toBe('Create an action');
  });

  it('AI Analyst, no committed data', () => {
    expect(ANALYST_NO_DATA.title).toBe('The analyst needs some numbers first.');
    expect(ANALYST_NO_DATA.body).toBe(
      'Once you\'ve added at least one month of data, you can ask questions like "Why did profit fall?" or "Which expenses went up the most?" and get answers backed by your own records.',
    );
    expect(ANALYST_NO_DATA.primaryLabel).toBe('Add data');
  });

  it('AI Analyst, data present, no conversations', () => {
    expect(ANALYST_NO_CONVERSATIONS.title).toBe('Ask anything about the numbers.');
    expect(ANALYST_NO_CONVERSATIONS.body).toBe('Suggested:');
    expect(ANALYST_SUGGESTIONS).toEqual([
      'How did we do in March?',
      'Which expenses went up the most?',
      'Who are our biggest customers?',
      'What should I focus on this month?',
    ]);
  });

  it('Reports, before the first full month', () => {
    expect(REPORTS_BEFORE_FIRST_MONTH.title).toBe(
      'Your first monthly report will be ready once a full month of data is in.',
    );
    expect(REPORTS_BEFORE_FIRST_MONTH.body).toBe(
      'Reports are generated from the same numbers you see on Home, so nothing here will surprise you.',
    );
    expect(REPORTS_BEFORE_FIRST_MONTH.primaryLabel).toBe('Add data');
  });

  it('Insights → Alerts filter, no open alerts', () => {
    expect(ALERTS_NONE.title).toBe('No open alerts.');
    expect(ALERTS_NONE.body).toBe(
      'That means nothing crossed the thresholds we watch this month. You can see resolved and dismissed alerts under History.',
    );
    // Nothing needs doing, which is the point: no action.
    expect(ALERTS_NONE.primaryLabel).toBeUndefined();
  });

  it('Portfolio (employee), no assignments', () => {
    expect(PORTFOLIO_NO_ASSIGNMENTS.title).toBe(
      "You haven't been assigned to any organisations yet.",
    );
    expect(PORTFOLIO_NO_ASSIGNMENTS.body).toBe(
      "A MOTION administrator assigns organisations to you. When that happens they'll appear here.",
    );
    expect(PORTFOLIO_NO_ASSIGNMENTS.primaryLabel).toBeUndefined();
  });

  it('Platform → Organizations, none', () => {
    expect(PLATFORM_NO_ORGANISATIONS.title).toBe('No organisations yet.');
    expect(PLATFORM_NO_ORGANISATIONS.primaryLabel).toBe('Create the first organisation');
  });

  it('is UK English, second person, and never exclaims (§8)', () => {
    const everything = [
      HOME_FIRST_RUN, INSIGHTS_NEEDS_TWO_PERIODS, MONEY_NO_INVOICES, CUSTOMERS_NONE,
      ACTIONS_NONE, ANALYST_NO_DATA, ANALYST_NO_CONVERSATIONS, REPORTS_BEFORE_FIRST_MONTH,
      ALERTS_NONE, PORTFOLIO_NO_ASSIGNMENTS, PLATFORM_NO_ORGANISATIONS,
      homeBankDataOnly('March'),
      homeAwaitingReview({ rowCount: 1, filename: 'a.csv', issueCount: 1 }),
      insightsNoAdjacentMonth({ period: 'March', comparison: 'January', missing: 'February' }),
    ];

    for (const copy of everything) {
      const text = `${copy.title} ${copy.body} ${copy.hint ?? ''}`;
      expect(text).not.toContain('!');
      expect(text).not.toMatch(/\borganization/i);
      expect(text).not.toMatch(/\bcategorize/i);
    }
  });
});

describe('loading, error and denied copy (UX_ARCHITECTURE.md §7)', () => {
  it('names the slow-loading line, the recalculation banner and the stale tag', () => {
    expect(SLOW_LOADING_TEXT).toBe('Taking longer than usual');
    expect(RECALCULATING_TITLE).toBe('Updating your numbers…');
    expect(STALE_FIGURE_TEXT).toBe('being updated');
  });

  it('shows recalculation progress in months (ADR-047.7)', () => {
    expect(recalculatingProgress(3, 12)).toBe('3 of 12 months');
  });

  it('says nothing was saved when a commit was interrupted (ADR-031.3)', () => {
    expect(ERROR_COPY.commit_interrupted.body).toBe('Nothing was saved; please confirm again.');
  });

  it('says the data is safe when a calculation run failed', () => {
    expect(ERROR_COPY.calculation_failed.body).toBe("Your data is safe; we're looking into it.");
  });

  it('uses the specification wording for the analyst states', () => {
    expect(ERROR_COPY.ai_unavailable.title).toBe("The analyst isn't available right now");
    expect(ERROR_COPY.ai_grounding_failed.title).toBe(
      "Some of this answer couldn't be verified against your data, so we've left it out.",
    );
  });

  it('uses the specification wording for offline, session expiry and the unknown error', () => {
    expect(ERROR_COPY.offline.title).toBe("You're offline");
    expect(ERROR_COPY.session_expired.title).toBe(
      "You've been signed out for security. Sign in again to continue.",
    );
    expect(ERROR_COPY.unknown.title).toBe('Something went wrong on our side. Please try again.');
  });

  it('counts the rows another import added while you were reviewing (ADR-029.5)', () => {
    expect(duplicateAtConfirmBody(12)).toBe(
      'Another import added 12 of these rows while you were reviewing.',
    );
  });

  it('never shows a stack trace or an internal code', () => {
    for (const copy of Object.values(ERROR_COPY)) {
      expect(`${copy.title} ${copy.body}`).not.toMatch(/Error:|stack|undefined|null/i);
    }
  });

  it('names who to ask, and nothing about what the page contains (§7.4)', () => {
    expect(DENIED_TITLE).toBe('You do not have access to this page.');
    expect(deniedBody('Acme Ltd')).toBe(
      "You don't have access to this page. Ask an owner or admin of Acme Ltd if you need it.",
    );
    // With no organisation to name it still says nothing about the page.
    expect(deniedBody()).toBe(
      "You don't have access to this page. Ask an owner or admin of this organisation if you need it.",
    );
  });

  it('gives one answer for a page that does not exist and one that is not yours (RBAC §5)', () => {
    expect(NOT_FOUND_TITLE).toBe("We couldn't find that page");
  });

  it('tells a suspended organisation who to contact (§7.4)', () => {
    expect(SUSPENDED_TITLE).toBe('This organisation is suspended. Contact MOTION support.');
  });
});

describe('the canonical status badge (UX_ARCHITECTURE.md §8.1)', () => {
  const quality = (over: Partial<{ completeness: number; proxy: boolean; warnings: string[]; missing: string[] }> = {}) => ({
    completeness: 1,
    proxy: false,
    warnings: [],
    missing: [],
    ...over,
  }) as never;

  it('gives a verified, complete figure no badge at all', () => {
    const status = statusFor({ value: '100', assurance: 'verified', dataQuality: quality() });
    expect(status.kind).toBe('none');
    expect(STATUS_LABELS[status.kind]).toBeNull();
  });

  it('maps every kind to the label in the §8.1 table', () => {
    expect(STATUS_LABELS).toEqual({
      none: null,
      calculated: 'Calculated',
      partial: 'Partial data',
      estimate: 'Estimate',
      check: 'Please check',
      not_available: '—',
    });
  });

  it('labels each derived status exactly as the table says', () => {
    const cases: ReadonlyArray<[StatusKind, ReturnType<typeof statusFor>]> = [
      ['calculated', statusFor({ value: '1', assurance: 'calculated', dataQuality: quality() })],
      ['partial', statusFor({ value: '1', assurance: 'verified', dataQuality: quality({ completeness: 0.5 }) })],
      ['estimate', statusFor({ value: '1', assurance: 'estimated', dataQuality: quality() })],
      ['check', statusFor({ value: '1', assurance: 'inferred', dataQuality: quality() })],
      ['not_available', statusFor({ value: null, assurance: 'verified', dataQuality: quality() })],
    ];

    for (const [kind, status] of cases) {
      expect(status.kind).toBe(kind);
      expect(status.label).toBe(STATUS_LABELS[kind]);
    }
  });

  it('reserves colour for the two states that qualify how far a figure can be trusted', () => {
    expect(statusTone('partial')).toBe('warn');
    expect(statusTone('check')).toBe('warn');
    // Method, not a problem: no colour.
    expect(statusTone('calculated')).toBe('neutral');
    expect(statusTone('estimate')).toBe('neutral');
    expect(statusTone('none')).toBe('neutral');
    expect(statusTone('not_available')).toBe('neutral');
  });

  it('offers the two sizes §5 allows and no others', () => {
    expect(Object.keys(BADGE_SIZE_CLASS).sort()).toEqual(['md', 'sm']);
    expect(BADGE_SIZE_CLASS.md).toBe('');
  });
});

describe('change lines (§4, ADR-030)', () => {
  it('colours a movement by whether it is good news, not by its sign', () => {
    expect(changeToneClass(true)).toBe('text-good');
    expect(changeToneClass(false)).toBe('text-danger');
    // No inherent direction — working capital can move either way for good reasons.
    expect(changeToneClass(null)).toBe('text-ink-muted');
  });

  it('says favourability in a word as well as a colour (§11)', () => {
    expect(changeToneWord(true)).toBe('Favourable');
    expect(changeToneWord(false)).toBe('Unfavourable');
    expect(changeToneWord(null)).toBeNull();
  });

  it('replaces the percentage when the two months were measured differently', () => {
    expect(BASIS_DIFFERS_TEXT).toBe('compared on a different basis');
  });

  it('never hard-codes a colour', () => {
    for (const tone of [changeToneClass(true), changeToneClass(false), changeToneClass(null)]) {
      expect(tone).not.toMatch(/#[0-9a-f]{3,6}/i);
    }
  });
});

describe('period picker options (§5, ADR-030)', () => {
  const periods = [
    { id: '2026-04', label: 'April 2026', isComplete: false },
    { id: '2026-03', label: 'March 2026', isComplete: true },
    { id: '2026-02', label: 'February 2026', isComplete: true },
  ];

  it('marks the latest complete month and only that one', () => {
    const options = toPeriodOptions(periods, '2026-02');
    expect(options.map((o) => o.isLatestComplete)).toEqual([false, true, false]);
  });

  it('marks the month currently on screen', () => {
    const options = toPeriodOptions(periods, '2026-02');
    expect(options.filter((o) => o.isCurrent).map((o) => o.id)).toEqual(['2026-02']);
  });

  it('marks nothing as current when no period is chosen', () => {
    expect(toPeriodOptions(periods, null).some((o) => o.isCurrent)).toBe(false);
  });

  it('marks nothing as latest complete when no month is complete', () => {
    const partialOnly = [{ id: '2026-04', label: 'April 2026', isComplete: false }];
    expect(toPeriodOptions(partialOnly, null)[0]?.isLatestComplete).toBe(false);
  });

  it('offers nothing when there are no months with data', () => {
    expect(toPeriodOptions([], null)).toEqual([]);
  });
});

describe('trend chart geometry (§4, §5)', () => {
  const point = (periodId: string, value: number | null) => ({
    periodId,
    periodLabel: periodId,
    value,
    display: value === null ? '—' : String(value),
  });

  const series = (key: string, values: ReadonlyArray<number | null>): TrendSeriesView => ({
    key,
    label: key,
    points: values.map((value, index) => point(`m${index}`, value)),
  });

  it('breaks the line at a month with no figure, rather than joining across it', () => {
    const one = series('revenue', [10, 20, null, 40, 50]);
    const segments = segmentsFor(one, scaleFor([one]));
    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveLength(2);
    expect(segments[1]).toHaveLength(2);
  });

  it('never joins the two sides of a gap', () => {
    const one = series('revenue', [10, null, 30]);
    const segments = segmentsFor(one, scaleFor([one]));
    expect(segments.map((s) => s.length)).toEqual([1, 1]);
  });

  it('draws nothing at all for a series with no figures', () => {
    const one = series('revenue', [null, null, null]);
    expect(segmentsFor(one, scaleFor([one]))).toEqual([]);
    expect(scaleFor([one]).empty).toBe(true);
  });

  it('keeps zero inside the plot, so a small profit never looks large', () => {
    const rising = scaleFor([series('profit', [1000, 1200, 1400])]);
    expect(rising.min).toBe(0);
    expect(rising.max).toBe(1400);

    const losing = scaleFor([series('profit', [-500, -200, 100])]);
    expect(losing.min).toBe(-500);
    expect(losing.max).toBe(100);
  });

  it('gives a flat series a band to sit in rather than one pixel row', () => {
    const flat = scaleFor([series('cash', [0, 0, 0])]);
    expect(flat.max).toBeGreaterThan(flat.min);
  });

  it('plots a month that stands between two gaps, rather than dropping it', () => {
    const one = series('cash', [null, 42, null]);
    const segments = segmentsFor(one, scaleFor([one]));
    expect(segments).toHaveLength(1);
    expect(segments[0]?.[0]?.point.display).toBe('42');
  });

  it('puts a later month to the right of an earlier one', () => {
    const one = series('revenue', [10, 20, 30]);
    const [segment] = segmentsFor(one, scaleFor([one]));
    expect(segment?.[0]?.x).toBeLessThan(segment?.[2]?.x ?? 0);
  });

  it('puts a bigger figure higher up the page', () => {
    const one = series('revenue', [10, 90]);
    const [segment] = segmentsFor(one, scaleFor([one]));
    expect(segment?.[1]?.y).toBeLessThan(segment?.[0]?.y ?? 0);
  });
});

describe('the chart palette comes from the tokens (DESIGN.md)', () => {
  it('uses six ordered series colours and no literal hex value', () => {
    expect(CHART_STROKE).toHaveLength(6);
    for (const cls of CHART_STROKE) expect(cls).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it('wraps round the palette rather than running out', () => {
    expect(chartClass(CHART_STROKE, 0)).toBe('stroke-chart-1');
    expect(chartClass(CHART_STROKE, 6)).toBe('stroke-chart-1');
  });

  it('tells series apart by more than colour (§11)', () => {
    // The first series is solid; every other one carries a distinct dash.
    expect(chartDash(0)).toBeUndefined();
    expect(chartDash(1)).not.toBeUndefined();
    expect(chartDash(1)).not.toBe(chartDash(2));
  });
});
