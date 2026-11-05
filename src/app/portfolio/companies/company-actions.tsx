'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { Field, Input } from '@/components/ui/field';
import { changeOwnerLoginAction, setCompanyStatusAction } from './actions';

/** Deactivate a company or switch it back on (ADR-187). */
export function CompanyStatusButton({ orgId, name, active }: { orgId: string; name: string; active: boolean }) {
  const [state, action] = useActionState(setCompanyStatusAction, null);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="status" value={active ? 'suspended' : 'active'} />
      <SubmitButton pendingLabel="…" tone={active ? 'danger' : 'secondary'} aria-label={`${active ? 'Deactivate' : 'Activate'} ${name}`}>
        {active ? 'Deactivate' : 'Activate'}
      </SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}

/** The owner's sign-in email and password (as the super admin's ADR-167 edit). */
export function OwnerLoginForm({ orgId, email }: { orgId: string; email: string }) {
  const [state, action] = useActionState(changeOwnerLoginAction, null);
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs font-medium text-accent hover:underline">Owner login</summary>
      <form action={action} className="mt-3 flex max-w-sm flex-col gap-4">
        <input type="hidden" name="org_id" value={orgId} />
        <input type="hidden" name="owner_email_before" value={email} />
        <Field label="Owner's email" htmlFor={`owner-email-${orgId}`} hint="Changing it signs them out everywhere.">
          <Input id={`owner-email-${orgId}`} name="owner_email" type="email" required defaultValue={email} autoComplete="off" />
        </Field>
        <Field label="New password (optional)" htmlFor={`owner-pw-${orgId}`} hint="At least 8 characters. Leave empty to keep their password.">
          <Input id={`owner-pw-${orgId}`} name="owner_password" type="password" minLength={8} maxLength={72} autoComplete="new-password" />
        </Field>
        <ActionMessage state={state} />
        <SubmitButton pendingLabel="Saving…">Save owner login</SubmitButton>
      </form>
    </details>
  );
}
