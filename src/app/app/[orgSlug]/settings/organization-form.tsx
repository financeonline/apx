'use client';

import { useActionState } from 'react';
import { updateOrganizationAction } from './actions';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { MONTHS } from '@/components/labels';

export function OrganizationForm(props: {
  orgSlug: string;
  name: string;
  timezone: string;
  fiscalYearStartMonth: number;
}) {
  const [state, action] = useActionState(updateOrganizationAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="org_slug" value={props.orgSlug} />
      <Field label="Business name" htmlFor="name">
        <Input id="name" name="name" defaultValue={props.name} required maxLength={200} />
      </Field>
      <Field label="Financial year starts in" htmlFor="fiscal_year_start_month">
        <Select
          id="fiscal_year_start_month"
          name="fiscal_year_start_month"
          defaultValue={String(props.fiscalYearStartMonth)}
        >
          {MONTHS.map((month, index) => (
            <option key={month} value={index + 1}>{month}</option>
          ))}
        </Select>
      </Field>
      <Field label="Time zone" htmlFor="timezone">
        <Input id="timezone" name="timezone" defaultValue={props.timezone} />
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
    </form>
  );
}
