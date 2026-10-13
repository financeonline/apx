/**
 * The wording of every loading, error and denied state (UX_ARCHITECTURE.md §7).
 *
 * Here for the same reason as the empty-state copy: it can be asserted, and it cannot drift into a
 * second wording somewhere else. §7.2 fixes several of these sentences exactly — a commit that was
 * interrupted must say that nothing was saved, or the reader will assume half their month is in the
 * accounts — so they are quoted rather than paraphrased.
 *
 * Nothing here is an apology for the user's benefit or a stack trace for ours: plain words, what
 * happened, and what they can do (§8.3).
 */

export interface StateCopy {
  readonly title: string;
  readonly body: string;
}

// -----------------------------------------------------------------------------------------------
// §7.1 Loading
// -----------------------------------------------------------------------------------------------

/** Appears when a skeleton has been on screen for three seconds (§7.1). */
export const SLOW_LOADING_TEXT = 'Taking longer than usual';

/**
 * §7.1 and ADR-047.7. The banner is keyed off a queued or running `calculation.run` job, never off
 * `calculation_runs.status` (ADR-031) — a run row can be finished while the job that will supersede
 * it is still waiting, and the reader would be told their numbers are settled when they are not.
 */
export const RECALCULATING_TITLE = 'Updating your numbers…';

export function recalculatingProgress(done: number, total: number): string {
  return `${done} of ${total} months`;
}

/** A figure that is being recomputed is greyed and tagged, never hidden (§7.1). */
export const STALE_FIGURE_TEXT = 'being updated';

// -----------------------------------------------------------------------------------------------
// §7.2 Errors
// -----------------------------------------------------------------------------------------------

export type ErrorVariant =
  | 'upload_rejected'
  | 'import_failed'
  | 'commit_interrupted'
  | 'duplicate_at_confirm'
  | 'calculation_failed'
  | 'ai_unavailable'
  | 'ai_grounding_failed'
  | 'offline'
  | 'session_expired'
  | 'unknown';

export const ERROR_COPY: Readonly<Record<ErrorVariant, StateCopy>> = {
  upload_rejected: {
    title: 'We could not use that file.',
    body:
      'This looks like a scanned PDF. We can keep it as a document, but to see the numbers please '
      + 'export a CSV from your bank.',
  },
  import_failed: {
    title: 'We could not read this import.',
    body:
      'Nothing has been saved and nothing has been discarded. You can try again from where it '
      + 'stopped, or go back and change how the columns are matched.',
  },
  commit_interrupted: {
    title: 'We could not finish saving this import.',
    body: 'Nothing was saved; please confirm again.',
  },
  duplicate_at_confirm: {
    title: 'Some of these rows have already been added.',
    body: 'Another import added some of these rows while you were reviewing.',
  },
  calculation_failed: {
    title: 'We could not update your numbers.',
    body: "Your data is safe; we're looking into it.",
  },
  ai_unavailable: {
    title: "The analyst isn't available right now",
    body:
      'Here are the figures we can show you for this period from your own records, without the '
      + 'analyst.',
  },
  ai_grounding_failed: {
    title: "Some of this answer couldn't be verified against your data, so we've left it out.",
    body: 'What remains is drawn from figures we could check.',
  },
  offline: {
    title: "You're offline",
    body: 'You can keep reading this page. Anything that changes your data will wait until you are back.',
  },
  session_expired: {
    title: "You've been signed out for security. Sign in again to continue.",
    body: 'We have kept the page you were on, so you will come straight back to it.',
  },
  unknown: {
    title: 'Something went wrong on our side. Please try again.',
    body: 'If it keeps happening, send the reference below to support and we will look into it.',
  },
};

/** "Another import added 12 of these rows while you were reviewing" (§7.2). */
export function duplicateAtConfirmBody(rowCount: number): string {
  return `Another import added ${rowCount} of these rows while you were reviewing.`;
}

// -----------------------------------------------------------------------------------------------
// §7.4 Denied and not found
// -----------------------------------------------------------------------------------------------

/**
 * A page the role cannot view says nothing about what it contains (§7.4). "You don't have access to
 * the audit log" would confirm there is an audit log and that this organisation has one.
 */
export function deniedBody(organisationName?: string): string {
  const who = organisationName ? `of ${organisationName}` : 'of this organisation';
  return `You don't have access to this page. Ask an owner or admin ${who} if you need it.`;
}

export const DENIED_TITLE = 'You do not have access to this page.';

/**
 * The identical answer for "this organisation does not exist" and "this organisation is not yours"
 * (§7.4, RBAC §5). Two different answers would let anyone enumerate the customer list.
 */
export const NOT_FOUND_TITLE = "We couldn't find that page";

export const NOT_FOUND_BODY =
  'It may have moved, or the link may be wrong. If you think you should be able to see it, ask an '
  + 'owner or administrator to check.';

export const SUSPENDED_TITLE = 'This organisation is suspended. Contact APX support.';
