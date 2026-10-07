'use client';

import { useActionState } from 'react';
import { addPlatformUserAction, revokePlatformRoleAction } from '../actions';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { TR, TD } from '@/components/ui/table';
import { Badge } from '@/components/ui/surfaces';
import { PLATFORM_ROLE_LABELS } from '@/components/labels';

export function AddPlatformUserForm() {
  const [state, action] = useActionState(addPlatformUserAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <Field label="Email" htmlFor="email" hint="A new address is sent an invitation. An account that belongs to a company cannot be used.">
        <Input id="email" name="email" type="email" required />
      </Field>
      <Field label="Role" htmlFor="platform_role">
        <Select id="platform_role" name="platform_role" defaultValue="employee">
          <option value="employee">Staff</option>
          <option value="super_admin">Super admin</option>
        </Select>
      </Field>
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
  twoStep: boolean;
}) {
  const [state, action] = useActionState(revokePlatformRoleAction, null);
  return (
    <TR>
      <TD className="break-all">{props.email ?? <code className="text-xs">{props.userId}</code>}</TD>
      <TD>{props.fullName ?? '—'}</TD>
      <TD>{PLATFORM_ROLE_LABELS[props.platformRole] ?? props.platformRole}</TD>
      <TD>{props.status}</TD>
      <TD>{props.twoStep ? <Badge tone="accent">Set up</Badge> : <Badge tone="warn">Not set up</Badge>}</TD>
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
