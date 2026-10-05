'use client';

import { useActionState } from 'react';
import { setVatRegistrationAction } from './actions';
import { Field, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';

/**
 * The organisation's VAT status (ADR-133). Three answers, and "Not set" is one of them: MOTION never
 * assumes a business is not registered. The days figures compare what is owed (which includes VAT)
 * with sales and costs, and only this answer says whether the books record those with VAT or without.
 */
export function VatForm(props: { orgSlug: string; status: 'registered' | 'not_registered' | 'unknown' }) {
  const [state, action] = useActionState(setVatRegistrationAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="org_slug" value={props.orgSlug} />
      <Field
        label="Is the business registered for VAT?"
        htmlFor="vat_status"
        hint="Used to compare what customers owe you, and what you owe suppliers, with your sales and costs. Changing it recalculates your figures."
      >
        <Select id="vat_status" name="vat_status" defaultValue={props.status}>
          <option value="unknown">Not set</option>
          <option value="registered">Yes, registered for VAT</option>
          <option value="not_registered">No, not registered</option>
        </Select>
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save VAT status</SubmitButton>
    </form>
  );
}
