'use client';

import { useActionState, useEffect, useRef } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { Field, Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { deleteCompanyAction, editCompanyAction, restoreCompanyAction } from './actions';

const COUNTRIES = [['GB', 'United Kingdom'], ['AE', 'United Arab Emirates'], ['IE', 'Ireland'], ['IN', 'India']] as const;
const CURRENCIES = ['GBP', 'AED', 'EUR', 'USD', 'INR'] as const;
const MONTHS = [
  ['1', 'January'], ['2', 'February'], ['3', 'March'], ['4', 'April'], ['5', 'May'], ['6', 'June'],
  ['7', 'July'], ['8', 'August'], ['9', 'September'], ['10', 'October'], ['11', 'November'], ['12', 'December'],
] as const;
const PLANS = [['trial', 'Trial'], ['starter', 'Starter'], ['professional', 'Professional'], ['enterprise', 'Enterprise']] as const;

export interface CompanyRow {
  readonly id: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly countryCode: string | null;
  readonly baseCurrency: string;
  readonly fiscalYearStartMonth: number;
  readonly plan: string;
  readonly status: string;
  /** The owner's login (ADR-167): their email and name, how many owners there are; null when none yet. */
  readonly owner: { readonly email: string; readonly fullName: string | null; readonly count: number } | null;
}

const DIALOG = 'm-auto max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40';

/**
 * Edit and Delete for one company in the list (ADR-166). Each opens a dialog; Delete asks
 * "Are you sure?" first and says what deleting means (erased for good after 30 days, restorable
 * until then). A company already scheduled for deletion offers Restore instead.
 */
export function CompanyRowActions({ company }: { company: CompanyRow }) {
  const editRef = useRef<HTMLDialogElement>(null);
  const deleteRef = useRef<HTMLDialogElement>(null);
  const [edited, edit] = useActionState(editCompanyAction, null);
  const [deleted, remove] = useActionState(deleteCompanyAction, null);
  const [restored, restore] = useActionState(restoreCompanyAction, null);

  // A successful delete closes its dialog; an edit stays open so its confirmation can be read.
  useEffect(() => { if (deleted?.ok) deleteRef.current?.close(); }, [deleted]);

  if (company.status === 'pending_deletion') {
    return (
      <form action={restore} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="org_id" value={company.id} />
        <SubmitButton tone="secondary" pendingLabel="Restoring…" className="h-8 px-3 text-xs" aria-label={`Restore ${company.name}`}>Restore</SubmitButton>
        <ActionMessage state={restored} />
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" tone="secondary" className="h-8 px-3 text-xs" aria-label={`Edit ${company.name}`} onClick={() => editRef.current?.showModal()}>
        Edit
      </Button>
      <Button type="button" tone="danger" className="h-8 px-3 text-xs" aria-label={`Delete ${company.name}`} onClick={() => deleteRef.current?.showModal()}>
        Delete
      </Button>

      <dialog ref={editRef} className={DIALOG} aria-labelledby={`edit-${company.id}`}>
        <form action={edit} className="flex flex-col gap-4 p-6">
          <h2 id={`edit-${company.id}`} className="text-lg font-bold">Edit {company.name}</h2>
          <input type="hidden" name="org_id" value={company.id} />
          <Field label="Company name" htmlFor={`name-${company.id}`}>
            <Input id={`name-${company.id}`} name="name" required maxLength={200} defaultValue={company.name} />
          </Field>
          <Field label="Legal name (optional)" htmlFor={`legal-${company.id}`}>
            <Input id={`legal-${company.id}`} name="legal_name" maxLength={200} defaultValue={company.legalName ?? ''} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Country" htmlFor={`country-${company.id}`}>
              <Select id={`country-${company.id}`} name="country_code" defaultValue={company.countryCode ?? 'GB'}>
                {COUNTRIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </Select>
            </Field>
            <Field label="Currency" htmlFor={`currency-${company.id}`} hint="Only while the company has no records yet.">
              <Select id={`currency-${company.id}`} name="base_currency" defaultValue={company.baseCurrency}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Financial year starts in" htmlFor={`fy-${company.id}`}>
              <Select id={`fy-${company.id}`} name="fiscal_year_start_month" defaultValue={String(company.fiscalYearStartMonth)}>
                {MONTHS.map(([value, m]) => <option key={value} value={value}>{m}</option>)}
              </Select>
            </Field>
            <Field label="Plan" htmlFor={`plan-${company.id}`}>
              <Select id={`plan-${company.id}`} name="plan" defaultValue={company.plan}>
                {PLANS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </Field>
          </div>
          <fieldset className="flex flex-col gap-4 rounded-xl border border-line p-4">
            <legend className="px-1 text-sm font-semibold">Owner login</legend>
            {company.owner === null ? (
              <p className="text-sm text-ink-muted">No owner has joined yet, so there is no login to change. They sign in once they accept the invitation.</p>
            ) : company.owner.count > 1 ? (
              <p className="text-sm text-ink-muted">This company has more than one owner, so their logins are not changed from here.</p>
            ) : (
              <>
                <p className="text-sm text-ink-muted">
                  {company.owner.fullName ? `${company.owner.fullName} signs in` : 'The owner signs in'} as <span className="font-medium text-ink">{company.owner.email}</span>.
                  Changing either signs them out everywhere.
                </p>
                <input type="hidden" name="owner_email_before" value={company.owner.email} />
                <Field label="Sign-in email (username)" htmlFor={`owner-email-${company.id}`}>
                  <Input id={`owner-email-${company.id}`} name="owner_email" type="email" autoComplete="off" defaultValue={company.owner.email} />
                </Field>
                <Field label="New password (optional)" htmlFor={`owner-pw-${company.id}`} hint="At least 8 characters. Leave empty to keep their password.">
                  <Input id={`owner-pw-${company.id}`} name="owner_password" type="password" minLength={8} maxLength={72} autoComplete="new-password" />
                </Field>
                <Field label="Your password" htmlFor={`me-pw-${company.id}`} hint="Needed only when you change the owner's email or password.">
                  <Input id={`me-pw-${company.id}`} name="current_password" type="password" autoComplete="current-password" />
                </Field>
              </>
            )}
          </fieldset>
          <ActionMessage state={edited} />
          <div className="flex flex-wrap justify-end gap-3">
            <Button type="button" tone="secondary" onClick={() => editRef.current?.close()}>{edited?.ok ? 'Close' : 'Cancel'}</Button>
            <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
          </div>
        </form>
      </dialog>

      <dialog ref={deleteRef} className={DIALOG} aria-labelledby={`delete-${company.id}`} role="alertdialog">
        <form action={remove} className="flex flex-col gap-4 p-6">
          <h2 id={`delete-${company.id}`} className="text-lg font-bold">Are you sure you want to delete {company.name}?</h2>
          <p className="text-sm text-ink-muted">
            Its people lose access straight away, and all of its data — figures, documents, reports — is erased for good
            after 30 days. Until then you can restore it from this list.
          </p>
          <input type="hidden" name="org_id" value={company.id} />
          <ActionMessage state={deleted} />
          <div className="flex flex-wrap justify-end gap-3">
            <Button type="button" tone="secondary" onClick={() => deleteRef.current?.close()} autoFocus>No, keep it</Button>
            <SubmitButton tone="danger" pendingLabel="Deleting…">Yes, delete it</SubmitButton>
          </div>
        </form>
      </dialog>
    </div>
  );
}
