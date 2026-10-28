'use client';

import { useActionState } from 'react';
import { setTaxSettingsAction } from './actions';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';

/**
 * The tax settings the indicative VAT return and Corporation Tax estimate read (ADR-156). The VAT
 * quarters are never assumed: until one is chosen the select shows "Not set yet" and saving requires
 * a choice.
 */
export function TaxForm(props: {
  orgSlug: string;
  vatQuarterEndMonth: 1 | 2 | 3 | null;
  vatScheme: 'standard' | 'cash_accounting' | 'flat_rate';
  ctAssociatedCompanies: number;
}) {
  const [state, action] = useActionState(setTaxSettingsAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="org_slug" value={props.orgSlug} />
      <Field
        label="VAT quarters end in"
        htmlFor="vat_quarter_end_month"
        hint="The months your VAT returns run to — shown on your VAT registration or past returns."
      >
        <Select
          id="vat_quarter_end_month"
          name="vat_quarter_end_month"
          defaultValue={props.vatQuarterEndMonth === null ? '' : String(props.vatQuarterEndMonth)}
          required
        >
          {props.vatQuarterEndMonth === null ? <option value="">Not set yet</option> : null}
          <option value="3">March, June, September, December</option>
          <option value="1">January, April, July, October</option>
          <option value="2">February, May, August, November</option>
        </Select>
      </Field>
      <Field
        label="VAT scheme"
        htmlFor="vat_scheme"
        hint="Standard: VAT counts when an invoice is issued. Cash accounting: VAT counts when money is paid or received. APX does not calculate the Flat Rate Scheme's return."
      >
        <Select id="vat_scheme" name="vat_scheme" defaultValue={props.vatScheme}>
          <option value="standard">Standard (invoice basis)</option>
          <option value="cash_accounting">Cash accounting</option>
          <option value="flat_rate">Flat Rate Scheme</option>
        </Select>
      </Field>
      <Field
        label="Associated companies"
        htmlFor="ct_associated_companies"
        hint="Other companies controlled by the same people as this one — often 0. They share the UK Corporation Tax limits, which can change the rate this company pays."
      >
        <Input
          id="ct_associated_companies"
          name="ct_associated_companies"
          type="number"
          inputMode="numeric"
          min={0}
          max={50}
          step={1}
          required
          defaultValue={props.ctAssociatedCompanies}
        />
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save tax settings</SubmitButton>
    </form>
  );
}
