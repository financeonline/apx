'use client';

import { useActionState } from 'react';
import { setCurrencyAndCountryAction } from './actions';
import { Field, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';

/**
 * Currency and country after creation (ADR-156). Country can change at any time; the currency only
 * while the organisation holds no financial records — the database refuses it afterwards, because
 * amounts are stored as stated and never converted.
 */
export function CurrencyForm(props: { orgSlug: string; currency: string; country: string }) {
  const [state, action] = useActionState(setCurrencyAndCountryAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="org_slug" value={props.orgSlug} />
      <Field label="Country" htmlFor="country" hint="Decides which VAT and tax rules apply.">
        <Select id="country" name="country" defaultValue={props.country}>
          <option value="GB">United Kingdom</option>
          <option value="AE">United Arab Emirates</option>
          <option value="IE">Ireland</option>
          <option value="IN">India</option>
        </Select>
      </Field>
      <Field
        label="Currency"
        htmlFor="currency"
        hint="The currency your figures are shown in. It can only be changed before any records are added, because APX never converts amounts."
      >
        <Select id="currency" name="currency" defaultValue={props.currency}>
          <option value="GBP">Pounds (GBP)</option>
          <option value="AED">UAE dirham (AED)</option>
          <option value="EUR">Euro (EUR)</option>
          <option value="USD">US dollars (USD)</option>
          <option value="INR">Indian rupee (INR)</option>
        </Select>
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save currency and country</SubmitButton>
    </form>
  );
}
