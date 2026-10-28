/**
 * The empty-state copy, word for word (UX_ARCHITECTURE.md §6).
 *
 * The copy lives here rather than inside the JSX for two reasons. It can be asserted against the
 * specification character by character in a unit test — §6 says "exact copy", and a paraphrase is
 * the easiest regression in the product to introduce and the hardest to notice. And a component
 * that renders `{copy.body}` cannot quietly acquire a second, divergent wording somewhere else.
 *
 * UK English, second person, no exclamation marks (§8). Where the specification's example carries a
 * month, a filename or a count, that part is a parameter and everything around it is fixed.
 */

export interface EmptyStateAction {
  readonly label: string;
  readonly href: string;
}

export interface EmptyStateCopy {
  readonly title: string;
  /** The body paragraph. Empty string where §6 gives a title and a button only. */
  readonly body: string;
  /** The italic third line, where §6 has one. */
  readonly hint?: string;
  readonly primaryLabel?: string;
  readonly secondaryLabel?: string;
}

// -----------------------------------------------------------------------------------------------
// Home
// -----------------------------------------------------------------------------------------------

export const HOME_FIRST_RUN: EmptyStateCopy = {
  title: "Let's get your first numbers on screen.",
  body:
    "APX works from files you already have. Upload a bank statement (CSV or PDF) or an export "
    + "from your accounting software and we'll show you how the business is doing, what's changed "
    + 'and what needs attention.',
  hint:
    'Start with a bank statement to see your cash position. Add a ledger export, trial balance or '
    + "invoice list when you can, and we'll add profit and customer figures.",
  primaryLabel: 'Add data',
  secondaryLabel: 'What files can I upload?',
};

/** The month is the organisation's, everything around it is fixed (§6). */
export function homeBankDataOnly(periodLabel: string): EmptyStateCopy {
  return {
    title: "Here's what your bank statement tells us.",
    body:
      `Money in, money out and the change in cash for ${periodLabel}. To see your cash balance, `
      + 'enter the balance at the start of the statement. To see profit and customers, add a ledger '
      + 'export or your invoice lists.',
    primaryLabel: 'Enter opening balance',
    secondaryLabel: 'Add data',
  };
}

export function homeAwaitingReview(input: {
  readonly rowCount: number;
  readonly filename: string;
  readonly issueCount: number;
}): EmptyStateCopy {
  return {
    title: 'Your import is waiting for review.',
    body:
      `We found ${input.rowCount} rows in ${input.filename}. Check the ${input.issueCount} items we `
      + 'flagged, then confirm, and your numbers will appear here.',
    primaryLabel: 'Review import',
  };
}

// -----------------------------------------------------------------------------------------------
// Insights
// -----------------------------------------------------------------------------------------------

export const INSIGHTS_NEEDS_TWO_PERIODS: EmptyStateCopy = {
  title: 'We need two months to show what changed.',
  body:
    'Insights compares this month with last month. Add another month of data and this page will '
    + 'show you the biggest movements and why they happened.',
  primaryLabel: 'Add data',
};

/**
 * The gap variant. Three month names: the period on screen, the nearest earlier month with data,
 * and the month that is missing between them.
 */
export function insightsNoAdjacentMonth(input: {
  readonly period: string;
  readonly comparison: string;
  readonly missing: string;
}): EmptyStateCopy {
  return {
    title: `Comparing ${input.period} with ${input.comparison}.`,
    body:
      `We don't have ${input.missing} yet, so changes are shown against the nearest earlier month `
      + `we do have. Add ${input.missing} to compare month to month.`,
    primaryLabel: 'Add data',
  };
}

export const ALERTS_NONE: EmptyStateCopy = {
  title: 'No open alerts.',
  body:
    'That means nothing crossed the thresholds we watch this month. You can see resolved and '
    + 'dismissed alerts under History.',
};

// -----------------------------------------------------------------------------------------------
// Money and Customers
// -----------------------------------------------------------------------------------------------

export const MONEY_NO_INVOICES: EmptyStateCopy = {
  title: 'No invoices yet.',
  body:
    'Upload a sales invoice list or purchase invoice list to see who owes you, who you owe, and '
    + "what's overdue. If you only use bank statements, this page will stay empty — that's fine.",
  primaryLabel: 'Add data',
};

export const CUSTOMERS_NONE: EmptyStateCopy = {
  title: "We don't know your customers yet.",
  body:
    "Customer insights come from invoices. Upload your sales invoice list and we'll show you who "
    + 'your biggest customers are and how much you rely on them.',
  primaryLabel: 'Add data',
};

// -----------------------------------------------------------------------------------------------
// Actions, Analyst, Reports
// -----------------------------------------------------------------------------------------------

export const ACTIONS_NONE: EmptyStateCopy = {
  title: 'Nothing to do right now.',
  body:
    'Actions appear here when you turn an alert or an analyst recommendation into a task, or '
    + 'create one yourself.',
  primaryLabel: 'Create an action',
};

export const ANALYST_NO_DATA: EmptyStateCopy = {
  title: 'The analyst needs some numbers first.',
  body:
    "Once you've added at least one month of data, you can ask questions like "
    + '"Why did profit fall?" or "Which expenses went up the most?" and get answers backed by '
    + 'your own records.',
  primaryLabel: 'Add data',
};

export const ANALYST_NO_CONVERSATIONS: EmptyStateCopy = {
  title: 'Ask anything about the numbers.',
  body: 'Try one of these (each uses one question):',
};

/**
 * The four suggestions §6 fixes, in order. They are buttons that send the question. The first says
 * "last month" where §6 wrote "in March", so it never points at a month the business has no figures
 * for; the lead-in says each one uses a question from the day's allowance.
 */
export const ANALYST_SUGGESTIONS: readonly string[] = [
  'How did we do last month?',
  'Which expenses went up the most?',
  'Who are our biggest customers?',
  'What should I focus on this month?',
];

export const REPORTS_BEFORE_FIRST_MONTH: EmptyStateCopy = {
  title: 'Your first monthly report will be ready once a full month of data is in.',
  body:
    'Reports are generated from the same numbers you see on Home, so nothing here will surprise '
    + 'you.',
  primaryLabel: 'Add data',
};

// -----------------------------------------------------------------------------------------------
// Portfolio and Platform
// -----------------------------------------------------------------------------------------------

export const PORTFOLIO_NO_ASSIGNMENTS: EmptyStateCopy = {
  title: "You haven't been assigned to any organisations yet.",
  body:
    "An APX administrator assigns organisations to you. When that happens they'll appear here.",
};

export const PLATFORM_NO_ORGANISATIONS: EmptyStateCopy = {
  title: 'No organisations yet.',
  body: '',
  primaryLabel: 'Create the first organisation',
};
