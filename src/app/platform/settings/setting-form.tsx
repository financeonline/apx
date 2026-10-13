'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { updateSettingAction } from './actions';
import { Input } from '@/components/ui/shadcn';

export function SettingForm({ settingKey, label, hint, value, numeric }: {
  settingKey: string; label: string; hint: string; value: string; numeric: boolean;
}) {
  const [state, submit] = useActionState(updateSettingAction, null);
  return (
    <form action={submit} className="flex flex-col gap-2 border-t border-line pt-4 first:border-0 first:pt-0">
      <input type="hidden" name="key" value={settingKey} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink">{label}</span>
        <span className="text-xs text-ink-muted">{hint}</span>
        <Input name="value" defaultValue={value} inputMode={numeric ? 'numeric' : 'text'}
          className={`mt-1 ${numeric ? 'tabular w-48' : 'font-mono text-xs'}`} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton tone="secondary" pendingLabel="Saving…">Save</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}
