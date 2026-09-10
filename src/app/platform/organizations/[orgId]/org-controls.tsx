'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { setOrgFeatureAction, setOrgQuotasAction, setOrgStatusAction } from './actions';

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

export function OrgFeatureToggle({ orgId, feature, label, hint, enabled, features }: {
  orgId: string; feature: string; label: string; hint: string; enabled: boolean; features: Record<string, unknown>;
}) {
  const [state, submit] = useActionState(setOrgFeatureAction, null);
  return (
    <form action={submit} className="flex flex-wrap items-center gap-3 text-sm">
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="feature" value={feature} />
      <input type="hidden" name="enabled" value={enabled ? 'no' : 'yes'} />
      <input type="hidden" name="current_features" value={JSON.stringify(features)} />
      <span className="text-ink">{label}</span>
      <span className="text-ink-muted">{enabled ? 'on' : 'off'} — {hint}</span>
      <SubmitButton tone="secondary" pendingLabel="Saving…">{enabled ? 'Turn off' : 'Turn on'}</SubmitButton>
      <ActionMessage state={state} />
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
      <input name={name} inputMode="numeric" defaultValue={value ?? ''} placeholder="platform default"
        className="rounded-md border border-line bg-surface px-3 py-2 text-ink tabular" />
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
        <input name="notes" defaultValue={quotas.notes ?? ''} maxLength={1000} className="rounded-md border border-line bg-surface px-3 py-2 text-ink" />
      </label>
      <div className="flex items-center gap-3">
        <SubmitButton tone="secondary" pendingLabel="Saving…">Save limits</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}
