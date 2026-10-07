'use client';

import { useActionState } from 'react';
import { addPlatformUserAction, revokePlatformRoleAction } from '../actions';
import { Field, Input } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { TR, TD } from '@/components/ui/table';
import { PLATFORM_ROLE_LABELS } from '@/components/labels';

export function AddPlatformUserForm() {
  const [state, action] = useActionState(addPlatformUserAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <Field label="Email" htmlFor="email" hint="A new address is sent an invitation. An account that belongs to a company cannot be used.">
        <Input id="email" name="email" type="email" required />
      </Field>
      {/* ADR-159: there is one super admin; everyone added here is staff. */}
      <input type="hidden" name="platform_role" value="employee" />
      <p className="text-sm text-ink-muted">They are added as staff. There is one super admin.</p>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Adding…">Add platform admin</SubmitButton>
    </form>
  );
}

export function PlatformUserRow(props: {
  userId: string;
  email: string | null;
  fullName: string | null;
  platformRole: string;
  status: string;
}) {
  const [state, action] = useActionState(revokePlatformRoleAction, null);
  return (
    <TR>
      <TD className="break-all">{props.email ?? <code className="text-xs">{props.userId}</code>}</TD>
      <TD>{props.fullName ?? '—'}</TD>
      <TD>{PLATFORM_ROLE_LABELS[props.platformRole] ?? props.platformRole}</TD>
      <TD>{props.status}</TD>
      <TD>
        {props.platformRole === 'super_admin' ? (
          <span className="text-xs text-ink-muted">The super admin</span>
        ) : (
          <>
            <form action={action}>
              <input type="hidden" name="user_id" value={props.userId} />
              <SubmitButton pendingLabel="…" tone="danger">Revoke</SubmitButton>
            </form>
            <ActionMessage state={state} />
          </>
        )}
      </TD>
    </TR>
  );
}
