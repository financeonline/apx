'use client';

import { useActionState } from 'react';
import { requestDeletionAction, cancelDeletionAction } from '../actions';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';

export function DangerForms({ orgSlug, pendingDeletion }: { orgSlug: string; pendingDeletion: boolean }) {
  const [requestState, requestAction] = useActionState(requestDeletionAction, null);
  const [cancelState, cancelAction] = useActionState(cancelDeletionAction, null);

  if (pendingDeletion) {
    return (
      <form action={cancelAction} className="flex flex-col gap-4">
        <input type="hidden" name="org_slug" value={orgSlug} />
        <ActionMessage state={cancelState} />
        <SubmitButton pendingLabel="Cancelling…">Cancel the deletion</SubmitButton>
      </form>
    );
  }

  return (
    <form action={requestAction} className="flex flex-col gap-4">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <ActionMessage state={requestState} />
      <SubmitButton pendingLabel="Scheduling…" tone="danger">Schedule deletion</SubmitButton>
    </form>
  );
}
