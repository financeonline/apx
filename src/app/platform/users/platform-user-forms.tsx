'use client';

import { useActionState } from 'react';
import { grantPlatformRoleAction, revokePlatformRoleAction } from '../actions';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { TR, TD } from '@/components/ui/table';
import { PLATFORM_ROLE_LABELS } from '@/components/labels';

export function GrantRoleForm() {
  const [state, action] = useActionState(grantPlatformRoleAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <Field label="User id" htmlFor="user_id" hint="The account must already exist and hold no organisation membership.">
        <Input id="user_id" name="user_id" required />
      </Field>
      <Field label="Role" htmlFor="platform_role">
        <Select id="platform_role" name="platform_role" defaultValue="employee">
          <option value="employee">MOTION adviser</option>
          <option value="super_admin">Super admin</option>
        </Select>
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Granting…">Grant role</SubmitButton>
    </form>
  );
}

export function PlatformUserRow(props: { userId: string; platformRole: string; status: string }) {
  const [state, action] = useActionState(revokePlatformRoleAction, null);
  return (
    <TR>
      <TD><code className="text-xs">{props.userId}</code></TD>
      <TD>{PLATFORM_ROLE_LABELS[props.platformRole] ?? props.platformRole}</TD>
      <TD>{props.status}</TD>
      <TD>
        <form action={action}>
          <input type="hidden" name="user_id" value={props.userId} />
          <SubmitButton pendingLabel="…" tone="danger">Revoke</SubmitButton>
        </form>
        <ActionMessage state={state} />
      </TD>
    </TR>
  );
}
