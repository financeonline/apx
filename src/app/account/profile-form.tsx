'use client';

import { useActionState } from 'react';
import { updateProfileAction } from './actions';
import { Field, Input } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';

export function ProfileForm(props: { fullName: string; email: string; timezone: string }) {
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
        <Input id="timezone" name="timezone" defaultValue={props.timezone} />
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
    </form>
  );
}
