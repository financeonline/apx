'use client';

import { useActionState } from 'react';
import { createAssignmentAction, revokeAssignmentAction } from '../actions';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { TR, TD } from '@/components/ui/table';

interface Choice { readonly id: string; readonly name: string }

export function CreateAssignmentForm({
  companies, analysts,
}: { companies: readonly (Choice & { readonly slug: string })[]; analysts: readonly Choice[] }) {
  const [state, action] = useActionState(createAssignmentAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <Field label="Organisation" htmlFor="organization_id">
        <Select id="organization_id" name="organization_id" required defaultValue="">
          <option value="" disabled>Choose a company</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.slug})</option>)}
        </Select>
      </Field>
      <Field
        label="Financial Analyst"
        htmlFor="employee_user_id"
        hint={analysts.length === 0 ? 'Nobody holds the Financial Analyst role yet: add one on Platform accounts first.' : 'Only people who hold the Financial Analyst platform role are listed.'}
      >
        <Select id="employee_user_id" name="employee_user_id" required defaultValue="">
          <option value="" disabled>Choose a Financial Analyst</option>
          {analysts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      </Field>
      <Field label="Access ends" htmlFor="ends_at" hint="Leave blank for the default of twelve months.">
        <Input id="ends_at" name="ends_at" type="date" />
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Assigning…">Assign Financial Analyst</SubmitButton>
    </form>
  );
}

export function AssignmentRow(props: {
  assignmentId: string;
  organizationId: string;
  organizationName?: string | null;
  employeeUserId: string;
  employeeName?: string | null;
  endsAt: string | null;
}) {
  const [state, action] = useActionState(revokeAssignmentAction, null);
  return (
    <TR>
      <TD>{props.organizationName ?? <code className="text-xs">{props.organizationId}</code>}</TD>
      <TD>{props.employeeName ?? <code className="text-xs">{props.employeeUserId}</code>}</TD>
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
