'use client';

import { useActionState } from 'react';
import { createOrganizationAction } from './actions';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { MONTHS } from '@/components/labels';

export function OnboardingForm() {
  const [state, action] = useActionState(createOrganizationAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <Field label="Business name" htmlFor="name">
        <Input id="name" name="name" required maxLength={200} autoFocus />
      </Field>
      <Field label="Country" htmlFor="country_code">
        <Select id="country_code" name="country_code" defaultValue="GB">
          <option value="GB">United Kingdom</option>
          <option value="IE">Ireland</option>
          <option value="AE">United Arab Emirates</option>
          <option value="IN">India</option>
        </Select>
      </Field>
      <Field label="Currency" htmlFor="base_currency" hint="Everything is reported in this currency.">
        <Select id="base_currency" name="base_currency" defaultValue="GBP">
          <option value="GBP">Pounds (GBP)</option>
          <option value="EUR">Euro (EUR)</option>
          <option value="USD">US dollars (USD)</option>
          <option value="AED">UAE dirham (AED)</option>
          <option value="INR">Indian rupee (INR)</option>
        </Select>
      </Field>
      <Field
        label="Financial year starts in"
        htmlFor="fiscal_year_start_month"
        hint="Most UK businesses start in April; many start in January."
      >
        <Select id="fiscal_year_start_month" name="fiscal_year_start_month" defaultValue="1">
          {MONTHS.map((month, index) => (
            <option key={month} value={index + 1}>{month}</option>
          ))}
        </Select>
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Creating…">Create organisation</SubmitButton>
    </form>
  );
}
