'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { setOrgModuleAction, setOrgQuotasAction, setOrgStatusAction } from './actions';
import { Badge } from '@/components/ui/surfaces';
import { Input } from '@/components/ui/shadcn';

export function OrgStatusControl({ orgId, status }: { orgId: string; status: string }) {
  const [state, submit] = useActionState(setOrgStatusAction, null);
  const next = status === 'suspended' ? 'active' : 'suspended';
  if (status !== 'active' && status !== 'suspended') {
    return <p className="text-sm text-ink-muted">This organisation is {status.replace('_', ' ')}; that is not changed from here.</p>;
  }
  return (
    <form action={submit} className="flex flex-wrap items-center gap-3 text-sm">
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="status" value={next} />
      <span className="text-ink-muted">
        {status === 'active'
          ? 'Suspending freezes the figures: members can read, nothing can be changed.'
          : 'Reactivating lets the organisation change its data again.'}
      </span>
      <SubmitButton tone={status === 'active' ? 'danger' : 'primary'} pendingLabel="Saving…">
        {status === 'active' ? 'Suspend' : 'Reactivate'}
      </SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}

export function OrgModuleSwitch({ orgId, featureKey, label, description, on }: {
  orgId: string; featureKey: string; label: string; description: string; on: boolean;
}) {
  const [state, submit] = useActionState(setOrgModuleAction, null);
  return (
    <form action={submit} className="flex flex-col gap-2 border-b border-line pb-3 last:border-b-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="feature_key" value={featureKey} />
      <input type="hidden" name="on" value={on ? 'no' : 'yes'} />
      <div className="min-w-0 text-sm">
        <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
          {label}
          <Badge tone={on ? 'accent' : 'neutral'}>{on ? 'On' : 'Off'}</Badge>
        </p>
        <p className="text-ink-muted">{description}</p>
        <ActionMessage state={state} />
      </div>
      <SubmitButton tone="secondary" pendingLabel="Saving…" className="shrink-0">{on ? 'Turn off' : 'Turn on'}</SubmitButton>
    </form>
  );
}

export function OrgQuotasForm({ orgId, quotas }: {
  orgId: string;
  quotas: { aiQuotaDaily: number | null; aiTokenCeilingMonthly: number | null; aiExtractionPagesPerDay: number | null; notes: string | null };
}) {
  const [state, submit] = useActionState(setOrgQuotasAction, null);
  const field = (name: string, label: string, value: number | null) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink-muted">{label}</span>
      <Input name={name} inputMode="numeric" defaultValue={value ?? ''} placeholder="platform default"
        className="tabular" />
    </label>
  );
  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="org_id" value={orgId} />
      <div className="flex flex-wrap gap-4">
        {field('ai_quota_daily', 'Analyst questions a day', quotas.aiQuotaDaily)}
        {field('ai_token_ceiling_monthly', 'AI tokens a month', quotas.aiTokenCeilingMonthly)}
        {field('ai_extraction_pages_per_day', 'Pages read by AI a day', quotas.aiExtractionPagesPerDay)}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-muted">Note (why this organisation differs)</span>
        <Input name="notes" defaultValue={quotas.notes ?? ''} maxLength={1000} />
      </label>
      <div className="flex items-center gap-3">
        <SubmitButton tone="secondary" pendingLabel="Saving…">Save limits</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}
