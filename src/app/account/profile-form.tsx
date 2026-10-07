'use client';

import { useActionState } from 'react';
import { updateProfileAction } from './actions';
import { Field, Input, Select } from '@/components/ui/field';
import type { TimeZoneOption } from '@/components/time-zones';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';

export function ProfileForm(props: {
  fullName: string; email: string; timezone: string;
  timeZones: { first: readonly TimeZoneOption[]; rest: readonly TimeZoneOption[] };
}) {
  const [state, action] = useActionState(updateProfileAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <Field label="Your name" htmlFor="full_name">
        <Input id="full_name" name="full_name" defaultValue={props.fullName} maxLength={120} />
      </Field>
      <Field
        label="Email address"
        htmlFor="email"
        hint="Your email is how you sign in and how invitations are matched, so it is changed through sign-in settings, not here."
      >
        <Input id="email" name="email" defaultValue={props.email} disabled readOnly />
      </Field>
      <Field label="Time zone" htmlFor="timezone">
        <Select id="timezone" name="timezone" defaultValue={props.timezone}>
          <optgroup label="Common">
            {props.timeZones.first.map((z) => <option key={z.value} value={z.value}>{z.label}</option>)}
          </optgroup>
          <optgroup label="All time zones">
            {props.timeZones.rest.map((z) => <option key={z.value} value={z.value}>{z.label}</option>)}
          </optgroup>
        </Select>
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
    </form>
  );
}
