'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { Input } from '@/components/ui/shadcn';
import { confirmItsYouAction } from './actions';

/**
 * Changes on the platform pages need a sign-in from the last ten minutes. This bar renews it with the
 * super admin's password, without signing out.
 */
export function ConfirmItsYou() {
  const [state, confirm] = useActionState(confirmItsYouAction, null);
  return (
    <form action={confirm} className="panel mb-6 flex flex-wrap items-end gap-3 px-4 py-3">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <span className="text-ink">Confirm it is you</span>
        <span className="text-xs text-ink-muted">
          Changes here need your password from the last ten minutes. If one is refused, confirm here and try again.
        </span>
        <Input name="current_password" type="password" required autoComplete="current-password" className="mt-1 max-w-xs" aria-label="Your password" />
      </label>
      <SubmitButton pendingLabel="Confirming…">Confirm</SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}
