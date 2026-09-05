'use client';

import { buttonClass } from './ui/button';

/**
 * The body of every error boundary (ROUTE_ARCHITECTURE.md §9, UX_ARCHITECTURE.md §7.2):
 * plain words, the request id for support, and a Try again that re-renders the segment.
 * Never a stack trace.
 */
export function ErrorView({
  error,
  reset,
  title = 'Something went wrong on our side.',
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}) {
  return (
    <div className="mx-auto max-w-lg px-6 py-16 text-center">
      <h1 className="text-2xl">{title}</h1>
      <p className="mt-3 text-sm text-ink-muted">
        Your data is safe. Please try again — if it keeps happening, send the reference below to
        support and we will look into it.
      </p>
      {error.digest ? (
        <p className="mt-4 text-xs text-ink-faint">
          Reference for support: <span className="tabular">{error.digest}</span>
        </p>
      ) : null}
      <div className="mt-6">
        <button type="button" onClick={reset} className={buttonClass('primary')}>
          Try again
        </button>
      </div>
    </div>
  );
}
