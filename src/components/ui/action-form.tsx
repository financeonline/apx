'use client';

import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';
import type { ActionState } from '@/components/action-result';
import { buttonClass, type ButtonTone } from './button';

/** A submit button that reports the pending state of the form it lives in. */
export function SubmitButton({
  children,
  pendingLabel,
  tone = 'primary',
  className = '',
  pending: sentByHand = false,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  pendingLabel?: string;
  tone?: ButtonTone;
  className?: string;
  /** For a form that dispatches its action from `onSubmit` (so `useFormStatus` never sees it pending). */
  pending?: boolean;
  /** For a button whose visible word is the same on every row ("Deactivate"), naming what it acts on. */
  'aria-label'?: string;
}) {
  const pending = useFormStatus().pending || sentByHand;
  return (
    <button type="submit" disabled={pending} aria-label={ariaLabel} className={buttonClass(tone, className)}>
      {pending ? (pendingLabel ?? 'Working…') : children}
    </button>
  );
}

/**
 * The result of a server action, in plain words. Validation issues are listed field by field; an
 * unexpected failure shows the request id so support can find it. Errors are never swallowed.
 */
export function ActionMessage({ state }: { state: ActionState }) {
  if (!state) return null;

  if (state.ok) {
    return (
      <p className="text-sm text-good" role="status">
        {state.message ?? 'Saved.'}
      </p>
    );
  }

  const { error } = state;
  return (
    <div className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm" role="alert">
      <p className="text-danger">{error.message}</p>
      {error.issues && error.issues.length > 0 ? (
        <ul className="mt-1 list-disc pl-5 text-ink-muted">
          {error.issues.map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              {issue.path ? `${issue.path}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {error.requestId ? (
        <p className="mt-1 text-xs text-ink-faint">
          Reference for support: <span className="tabular">{error.requestId}</span>
        </p>
      ) : null}
    </div>
  );
}
