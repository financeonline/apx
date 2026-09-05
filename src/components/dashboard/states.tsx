import type { ReactNode } from 'react';
import { Banner, Card, CardBody, Skeleton, type BannerTone } from '@/components/ui/surfaces';
import { ButtonLink } from '@/components/ui/button';
import {
  DENIED_TITLE,
  ERROR_COPY,
  NOT_FOUND_BODY,
  NOT_FOUND_TITLE,
  RECALCULATING_TITLE,
  STALE_FIGURE_TEXT,
  SUSPENDED_TITLE,
  deniedBody,
  recalculatingProgress,
  type ErrorVariant,
} from './state-copy';

export { SlowLoadingNotice } from './slow-loading-notice';

/**
 * Loading, error, denied and not-found states (UX_ARCHITECTURE.md §7).
 *
 * These are the states a reader spends the most time in when something is wrong, and the ones most
 * often left as a spinner and a shrug. Each of them says what happened, whether the data is safe,
 * and what to do next.
 */

// -----------------------------------------------------------------------------------------------
// §7.1 Loading
// -----------------------------------------------------------------------------------------------

/**
 * A card-shaped skeleton with the dimensions of the loaded card, so nothing on the page moves when
 * the figure arrives (§7.1).
 *
 * The heights are the heights `MetricCard` renders — label, figure, change line, "Why?" — because a
 * skeleton that is merely card-ish still shifts the layout, and a page that jumps as it settles
 * reads as unreliable however accurate the numbers turn out to be.
 */
export function LoadingCard({
  compact = false,
  secondaryLine = false,
  label = 'Loading a figure',
}: {
  compact?: boolean;
  /** Match a card that carries a second line, such as profit after interest and tax. */
  secondaryLine?: boolean;
  label?: string;
}) {
  return (
    <Card className="h-full">
      <CardBody className={compact ? 'px-4 py-3' : ''}>
        <div aria-busy="true" aria-label={label} role="status">
          <div className="flex items-start justify-between gap-3">
            <Skeleton className={compact ? 'h-4 w-20' : 'h-5 w-28'} />
            <Skeleton className={compact ? 'h-4 w-16' : 'h-5 w-20'} />
          </div>
          <Skeleton className={compact ? 'mt-2 h-7 w-24' : 'mt-2 h-9 w-32'} />
          {secondaryLine ? <Skeleton className="mt-1 h-5 w-40" /> : null}
          <Skeleton className={compact ? 'mt-2 h-5 w-32' : 'mt-3 h-5 w-44'} />
          <Skeleton className="mt-3 h-5 w-12" />
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * "Updating your numbers…" (§7.1, ADR-047.7).
 *
 * Shown while a `calculation.run` job for the organisation is queued or running — the caller passes
 * that, and passes nothing derived from `calculation_runs.status` (ADR-031). A finished run row does
 * not mean the figures are settled if another job is still waiting behind it.
 *
 * Progress is in months, because that is the unit the reader thinks in.
 */
export function RecalculatingBanner({
  active,
  monthsDone,
  monthsTotal,
}: {
  /** True while a calculation job is queued or running. False renders nothing. */
  active: boolean;
  monthsDone?: number;
  monthsTotal?: number;
}) {
  if (!active) return null;

  const showProgress =
    typeof monthsDone === 'number' && typeof monthsTotal === 'number' && monthsTotal > 0;

  return (
    <Banner tone="info" title={RECALCULATING_TITLE}>
      {showProgress ? (
        <span className="tabular">{recalculatingProgress(monthsDone, monthsTotal)}</span>
      ) : (
        'Your figures will refresh on this page when it is done.'
      )}
    </Banner>
  );
}

/**
 * The tag on a figure that is mid-recalculation (§7.1).
 *
 * Stale figures are greyed and tagged, never hidden. A reader who came to check last month's cash
 * and finds the number gone will assume something is broken; a number they can see, marked as being
 * updated, tells them the truth without taking the page away from them.
 */
export function StaleFigureTag() {
  return (
    <span className="ml-2 align-middle text-xs text-ink-faint">
      <span aria-hidden="true">({STALE_FIGURE_TEXT})</span>
      <span className="sr-only"> This figure is {STALE_FIGURE_TEXT}.</span>
    </span>
  );
}

/** Wraps a figure that is being recalculated: greyed, tagged, still readable. */
export function StaleFigure({ stale, children }: { stale: boolean; children: ReactNode }) {
  if (!stale) return <>{children}</>;
  return (
    <span className="text-ink-faint">
      {children}
      <StaleFigureTag />
    </span>
  );
}

// -----------------------------------------------------------------------------------------------
// §7.2 Errors
// -----------------------------------------------------------------------------------------------

/**
 * The tone each error wears. Danger is kept for the cases where something the reader did has not
 * happened; a slow analyst or a lost connection is a warning, not a failure of their data.
 */
const ERROR_TONES: Readonly<Record<ErrorVariant, BannerTone>> = {
  upload_rejected: 'warn',
  import_failed: 'danger',
  commit_interrupted: 'danger',
  duplicate_at_confirm: 'warn',
  calculation_failed: 'danger',
  ai_unavailable: 'warn',
  ai_grounding_failed: 'warn',
  offline: 'warn',
  session_expired: 'info',
  unknown: 'danger',
};

/**
 * Every §7.2 state, as one component with a variant.
 *
 * `body` overrides the standard wording where the sentence carries a count or a specific reason —
 * "Another import added 12 of these rows while you were reviewing". `actions` is where the caller
 * puts the Try again, Retry or Confirm the table prescribes: those are server actions and forms,
 * which belong to the page, not to the state.
 */
export function ErrorState({
  variant,
  body,
  requestId,
  actions,
}: {
  variant: ErrorVariant;
  body?: string;
  /** Shown for support. Never a stack trace (§7.2). */
  requestId?: string;
  actions?: ReactNode;
}) {
  const copy = ERROR_COPY[variant];

  return (
    <Banner tone={ERROR_TONES[variant]} title={copy.title}>
      <p>{body ?? copy.body}</p>
      {requestId ? (
        <p className="mt-2 text-xs text-ink-faint">
          Reference for support: <span className="tabular">{requestId}</span>
        </p>
      ) : null}
      {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </Banner>
  );
}

// -----------------------------------------------------------------------------------------------
// §7.4 Denied, not found, suspended
// -----------------------------------------------------------------------------------------------

/**
 * A page the role cannot view (§7.4).
 *
 * It names who to ask and says nothing at all about what is on the page. "You cannot see the audit
 * log" would confirm that this organisation has one and that somebody is reading it.
 */
export function DeniedState({
  organisationName,
  homeHref,
}: {
  organisationName?: string;
  homeHref?: string;
}) {
  return (
    <div className="mx-auto max-w-lg px-6 py-16 text-center">
      <h1 className="text-2xl">{DENIED_TITLE}</h1>
      <p className="mt-3 text-sm text-ink-muted">{deniedBody(organisationName)}</p>
      {homeHref ? (
        <div className="mt-6">
          <ButtonLink href={homeHref} tone="secondary">
            Back to Home
          </ButtonLink>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The single answer for "there is no such organisation" and "that one is not yours" (§7.4, RBAC §5).
 * Distinguishing them would turn a 404 into a directory of MOTION's customers.
 */
export function NotFoundState({ backHref, backLabel = 'Back to your organisations' }: {
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <div className="mx-auto max-w-lg px-6 py-16 text-center">
      <h1 className="text-2xl">{NOT_FOUND_TITLE}</h1>
      <p className="mt-3 text-sm text-ink-muted">{NOT_FOUND_BODY}</p>
      {backHref ? (
        <div className="mt-6">
          <ButtonLink href={backHref} tone="secondary">
            {backLabel}
          </ButtonLink>
        </div>
      ) : null}
    </div>
  );
}

/** Shown on every page of a suspended organisation; only Home stays reachable (§7.4). */
export function SuspendedBanner() {
  return <Banner tone="danger" title={SUSPENDED_TITLE} />;
}
