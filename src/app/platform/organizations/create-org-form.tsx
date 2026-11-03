'use client';

import { useActionState } from 'react';
import { createCompanyAction } from './actions';
import { Field, Input, Select } from '@/components/ui/field';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';

// The choices `api.platform_create_organization` accepts; the service and the database re-check them.
const COUNTRIES = [
  ['GB', 'United Kingdom'], ['AE', 'United Arab Emirates'], ['IE', 'Ireland'], ['IN', 'India'],
] as const;
const CURRENCIES = ['GBP', 'AED', 'EUR', 'USD', 'INR'] as const;
const MONTHS = [
  ['1', 'January'], ['2', 'February'], ['3', 'March'], ['4', 'April'], ['5', 'May'], ['6', 'June'],
  ['7', 'July'], ['8', 'August'], ['9', 'September'], ['10', 'October'], ['11', 'November'], ['12', 'December'],
] as const;

/** The invitation link at the end of a successful create, so it can be shown ready to copy. */
function invitationLink(message: string | undefined): string | null {
  const match = message?.match(/(\S*\/invite\/\S+)$/);
  return match ? match[1]! : null;
}

export function CreateCompanyForm() {
  const [state, action] = useActionState(createCompanyAction, null);
  const link = state?.ok ? invitationLink(state.message) : null;
  return (
    <form action={action} className="flex flex-col gap-5">
      <Field label="Company name" htmlFor="company_name">
        <Input id="company_name" name="name" required maxLength={200} />
      </Field>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <Field label="Country" htmlFor="country_code">
          <Select id="country_code" name="country_code" defaultValue="GB">
            {COUNTRIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </Select>
        </Field>
        <Field label="Currency" htmlFor="base_currency">
          <Select id="base_currency" name="base_currency" defaultValue="GBP">
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Financial year starts in" htmlFor="fiscal_year_start_month">
          <Select id="fiscal_year_start_month" name="fiscal_year_start_month" defaultValue="1">
            {MONTHS.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="Owner's email" htmlFor="owner_email" hint="Their sign-in email.">
          <Input id="owner_email" name="owner_email" type="email" required autoComplete="off" />
        </Field>
        <Field
          label="Owner's password (optional)" htmlFor="owner_password"
          hint="Set one and they can sign in straight away. Leave it empty to send them an invitation link instead."
        >
          <Input id="owner_password" name="owner_password" type="password" minLength={8} maxLength={72} autoComplete="new-password" />
        </Field>
      </div>
      <ActionMessage state={state} />
      {link ? (
        <Field label="Invitation link" htmlFor="invitation_link">
          <Input id="invitation_link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="w-full font-mono text-xs" />
        </Field>
      ) : null}
      <SubmitButton pendingLabel="Creating…">Create company</SubmitButton>
    </form>
  );
}
