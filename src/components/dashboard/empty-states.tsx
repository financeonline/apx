import type { ReactNode } from 'react';
import Link from 'next/link';
import { ButtonLink } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/surfaces';
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
  type EmptyStateCopy,
} from './empty-state-copy';

/**
 * Every empty state in UX_ARCHITECTURE.md §6, with the copy exactly as written.
 *
 * §1 calls a blank table with "No rows" an anti-pattern, and it is: the reader who most needs
 * telling what this page is for is the one who has nothing on it yet. Each state says what will
 * appear here, what to do to fill it, and gives one button that does it.
 *
 * The wording lives in `empty-state-copy.ts` so it can be asserted against the specification. These
 * components are the arrangement, not the words.
 */

/** The shared shape: title, body, the optional italic third line, one primary action. */
function CopyState({
  copy,
  primaryHref,
  secondaryHref,
  secondaryNode,
}: {
  copy: EmptyStateCopy;
  primaryHref?: string;
  secondaryHref?: string;
  secondaryNode?: ReactNode;
}) {
  const secondary = secondaryNode
    ?? (copy.secondaryLabel && secondaryHref ? (
      <Link href={secondaryHref} className="text-accent underline underline-offset-2">
        {copy.secondaryLabel}
      </Link>
    ) : undefined);

  return (
    <EmptyState
      title={copy.title}
      actionLabel={copy.primaryLabel && primaryHref ? copy.primaryLabel : undefined}
      actionHref={copy.primaryLabel && primaryHref ? primaryHref : undefined}
      secondary={secondary}
    >
      {copy.body ? <p>{copy.body}</p> : null}
      {copy.hint ? <p className="mt-3 italic text-ink-faint">{copy.hint}</p> : null}
    </EmptyState>
  );
}

// -----------------------------------------------------------------------------------------------
// Home
// -----------------------------------------------------------------------------------------------

/** Home, first run: no committed data at all. */
export function HomeFirstRunEmpty({
  addDataHref,
  helpHref,
}: {
  addDataHref: string;
  helpHref: string;
}) {
  return <CopyState copy={HOME_FIRST_RUN} primaryHref={addDataHref} secondaryHref={helpHref} />;
}

/**
 * Home, bank data only (ADR-035): the statement is in, the ledger is not. The opening balance is
 * the primary action because it is the one thing that turns money in and out into a cash balance.
 */
export function HomeBankDataOnlyEmpty({
  periodLabel,
  openingBalanceHref,
  addDataHref,
}: {
  periodLabel: string;
  openingBalanceHref: string;
  addDataHref: string;
}) {
  return (
    <CopyState
      copy={homeBankDataOnly(periodLabel)}
      primaryHref={openingBalanceHref}
      secondaryNode={
        <ButtonLink href={addDataHref} tone="secondary">
          Add data
        </ButtonLink>
      }
    />
  );
}

/** Home, data uploaded but not yet committed. */
export function HomeAwaitingReviewEmpty({
  rowCount,
  filename,
  issueCount,
  reviewHref,
}: {
  rowCount: number;
  filename: string;
  issueCount: number;
  reviewHref: string;
}) {
  return (
    <CopyState copy={homeAwaitingReview({ rowCount, filename, issueCount })} primaryHref={reviewHref} />
  );
}

// -----------------------------------------------------------------------------------------------
// Insights
// -----------------------------------------------------------------------------------------------

/** Insights, fewer than two periods of data. */
export function InsightsNeedsTwoPeriodsEmpty({ addDataHref }: { addDataHref: string }) {
  return <CopyState copy={INSIGHTS_NEEDS_TWO_PERIODS} primaryHref={addDataHref} />;
}

/** Insights, a gap in the data: the comparison is against the nearest earlier month we have. */
export function InsightsNoAdjacentMonthEmpty({
  period,
  comparison,
  missing,
  addDataHref,
}: {
  period: string;
  comparison: string;
  missing: string;
  addDataHref: string;
}) {
  return (
    <CopyState copy={insightsNoAdjacentMonth({ period, comparison, missing })} primaryHref={addDataHref} />
  );
}

/** Insights → Alerts filter, no open alerts. No action: nothing needs doing, which is the point. */
export function AlertsNoneEmpty() {
  return <CopyState copy={ALERTS_NONE} />;
}

// -----------------------------------------------------------------------------------------------
// Money and Customers
// -----------------------------------------------------------------------------------------------

/** Money → Owed to you / You owe, with no invoice list uploaded. */
export function MoneyNoInvoicesEmpty({ addDataHref }: { addDataHref: string }) {
  return <CopyState copy={MONEY_NO_INVOICES} primaryHref={addDataHref} />;
}

/** Customers, with no invoices or customer-tagged entries. */
export function CustomersNoneEmpty({ addDataHref }: { addDataHref: string }) {
  return <CopyState copy={CUSTOMERS_NONE} primaryHref={addDataHref} />;
}

// -----------------------------------------------------------------------------------------------
// Actions, Analyst, Reports
// -----------------------------------------------------------------------------------------------

/**
 * Actions, none open.
 *
 * The button is hidden — not disabled — for a role that cannot create one (§6, §7.4, RBAC §5).
 * Pass `canCreate` from `can(ctx, 'actions.manage')`, or wrap in `PermissionGate`.
 */
export function ActionsNoneEmpty({
  createHref,
  canCreate = true,
}: {
  createHref: string;
  canCreate?: boolean;
}) {
  return <CopyState copy={ACTIONS_NONE} primaryHref={canCreate ? createHref : undefined} />;
}

/** AI Analyst, no committed data. */
export function AnalystNoDataEmpty({ addDataHref }: { addDataHref: string }) {
  return <CopyState copy={ANALYST_NO_DATA} primaryHref={addDataHref} />;
}

/**
 * AI Analyst, data present but no conversations yet.
 *
 * The four suggestions are the ones §6 fixes, and they are links that carry the question into a new
 * conversation — so they work with no client JavaScript, and a reader can open one in a new tab.
 */
export function AnalystNoConversationsEmpty({ askHrefBase }: { askHrefBase: string }) {
  return (
    <EmptyState title={ANALYST_NO_CONVERSATIONS.title}>
      <p>{ANALYST_NO_CONVERSATIONS.body}</p>
      <ul className="mt-3 flex flex-wrap justify-center gap-2">
        {ANALYST_SUGGESTIONS.map((question) => (
          <li key={question}>
            {/* A question is a sentence: on a narrow phone it wraps inside its button. */}
            <ButtonLink
              href={`${askHrefBase}?ask=${encodeURIComponent(question)}`}
              tone="secondary"
              className="whitespace-normal text-center"
            >
              {question}
            </ButtonLink>
          </li>
        ))}
      </ul>
    </EmptyState>
  );
}

/** Reports, before the first full month of data. */
/** `addDataHref` only for someone who may add data; anyone else reads the sentence without a button. */
export function ReportsBeforeFirstMonthEmpty({ addDataHref }: { addDataHref?: string }) {
  return <CopyState copy={REPORTS_BEFORE_FIRST_MONTH} primaryHref={addDataHref} />;
}

// -----------------------------------------------------------------------------------------------
// Portfolio and Platform
// -----------------------------------------------------------------------------------------------

/** Portfolio (MOTION adviser), no assignments. Nothing they can do about it, so no button. */
export function PortfolioNoAssignmentsEmpty() {
  return <CopyState copy={PORTFOLIO_NO_ASSIGNMENTS} />;
}

/** Platform → Organizations, none yet. */
export function PlatformNoOrganisationsEmpty({ createHref }: { createHref: string }) {
  return <CopyState copy={PLATFORM_NO_ORGANISATIONS} primaryHref={createHref} />;
}
