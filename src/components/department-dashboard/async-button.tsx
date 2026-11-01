'use client';

import { useState, type ReactNode } from 'react';
import type { ActionResult } from '@/components/action-result';
import { useDash } from './dash-context';

/**
 * A dialog button that runs a server action: disabled while it runs, then closes the dialog and
 * shows the result in the toast (the prototype's `notify`). A refusal or failure is shown as said.
 */
export function AsyncButton({ run, className = 'primary-button', children, disabled }: {
  run: () => Promise<ActionResult>; className?: string; children: ReactNode; disabled?: boolean;
}) {
  const { notify, closeDialog } = useDash();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || busy}
      aria-busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const result = await run();
          if (result.ok) {
            closeDialog();
            if (result.message) notify(result.message);
          } else {
            notify(result.error.message || 'That could not be saved. Try again.');
          }
        } catch {
          notify('That could not be saved. Try again.');
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}
