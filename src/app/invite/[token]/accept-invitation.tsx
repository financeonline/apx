'use client';

import { useActionState } from 'react';
import { acceptInvitationAction } from './actions';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';

export function AcceptInvitation({ token }: { token: string }) {
  const [state, action] = useActionState(acceptInvitationAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Accepting…">Accept invitation</SubmitButton>
    </form>
  );
}
