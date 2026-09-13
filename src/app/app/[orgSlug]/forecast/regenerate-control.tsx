'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { regenerateForecastAction } from './actions';

/** The one control on the page: work it out again from the latest figures. */
export function RegenerateControl({ orgSlug, label }: { orgSlug: string; label: string }) {
  const [state, submit] = useActionState(regenerateForecastAction, null);
  return (
    <form action={submit} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <SubmitButton tone="secondary" pendingLabel="Working it out…">{label}</SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}
