'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { recordOpportunityAction } from '../opportunity-actions';

/** "Record as an action" for one opportunity; the server works the opportunity out again (ADR-148). */
export function RecordOpportunity({ orgId, kind }: { orgId: string; kind: string }) {
  const [state, submit] = useActionState(recordOpportunityAction, null);
  return (
    <form action={submit} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="kind" value={kind} />
      <SubmitButton tone="secondary">Record as an action</SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}
