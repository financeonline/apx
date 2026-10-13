'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import type { ButtonTone } from '@/components/ui/button';
import { requestMarketingReportAction } from '../actions';

/**
 * The one control that spends AI on Marketing: create, refresh or retry the report (ADR-170). The
 * permission and the allowance are the action's and the database's to decide, not this button's
 * (ADR-026); a refusal comes back as a plain sentence beside it.
 */
export function RequestReportControl({
  orgSlug,
  label,
  tone = 'primary',
}: {
  orgSlug: string;
  label: string;
  tone?: ButtonTone;
}) {
  const [state, submit] = useActionState(requestMarketingReportAction, null);
  return (
    <form action={submit} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <SubmitButton tone={tone} pendingLabel="Starting…">{label}</SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}
