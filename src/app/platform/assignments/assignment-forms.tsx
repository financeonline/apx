'use client';

import { useActionState } from 'react';
import { createAssignmentAction, revokeAssignmentAction } from '../actions';
import { Field, Input } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { TR, TD } from '@/components/ui/table';

export function CreateAssignmentForm() {
  const [state, action] = useActionState(createAssignmentAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <Field label="Organisation id" htmlFor="organization_id">
        <Input id="organization_id" name="organization_id" required />
      </Field>
      <Field label="Adviser user id" htmlFor="employee_user_id" hint="Must already hold the MOTION adviser platform role.">
        <Input id="employee_user_id" name="employee_user_id" required />
      </Field>
      <Field label="Access ends" htmlFor="ends_at" hint="Leave blank for the default of twelve months.">
        <Input id="ends_at" name="ends_at" type="date" />
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Assigning…">Assign adviser</SubmitButton>
    </form>
  );
}

export function AssignmentRow(props: {
  assignmentId: string;
  organizationId: string;
  employeeUserId: string;
  endsAt: string | null;
}) {
  const [state, action] = useActionState(revokeAssignmentAction, null);
  return (
    <TR>
      <TD><code className="text-xs">{props.organizationId}</code></TD>
      <TD><code className="text-xs">{props.employeeUserId}</code></TD>
      <TD>{props.endsAt ? new Date(props.endsAt).toLocaleDateString('en-GB') : '—'}</TD>
      <TD>
        <form action={action}>
          <input type="hidden" name="assignment_id" value={props.assignmentId} />
          <SubmitButton pendingLabel="…" tone="danger">Revoke</SubmitButton>
        </form>
        <ActionMessage state={state} />
      </TD>
    </TR>
  );
}
