'use client';

import { useActionState } from 'react';
import { addPlatformUserAction, editPlatformUserAction, revokePlatformRoleAction, setAnalystCompaniesAction } from '../actions';
import { Field, Input } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { TR, TD } from '@/components/ui/table';
import { PLATFORM_ROLE_LABELS } from '@/components/labels';

export interface CompanyChoice { readonly id: string; readonly name: string; readonly slug: string }

/**
 * The companies as ticks (ADR-182): the super admin chooses exactly which ones a Financial Analyst
 * can open. `checked` are the ones they can open now.
 */
function CompanyTicks({ companies, checked, idPrefix }: {
  companies: readonly CompanyChoice[]; checked: ReadonlySet<string>; idPrefix: string;
}) {
  if (companies.length === 0) {
    return <p className="text-sm text-ink-muted">There are no companies yet. Create one on Companies first.</p>;
  }
  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink">Companies they can open</legend>
      <p className="text-xs text-ink-muted">Tick each company this person may work on. Unticked companies are hidden from them.</p>
      <ul className="mt-3 grid gap-2 md:grid-cols-2">
        {companies.map((c) => (
          <li key={c.id} className="min-w-0">
            <label
              htmlFor={`${idPrefix}-${c.id}`}
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3 transition-colors hover:border-accent/60 has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40"
            >
              <input
                id={`${idPrefix}-${c.id}`}
                type="checkbox"
                name="organization_id"
                value={c.id}
                defaultChecked={checked.has(c.id)}
                className="mt-1 size-4 shrink-0 accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{c.name}</span>
                <span className="block text-xs text-ink-muted">{c.slug}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

export function AddPlatformUserForm({ companies }: { companies: readonly CompanyChoice[] }) {
  const [state, action] = useActionState(addPlatformUserAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <Field label="Their name" htmlFor="full_name" hint="Shown on this list and in the Command Centre.">
        <Input id="full_name" name="full_name" autoComplete="off" maxLength={120} placeholder="For example, Sam Carter" />
      </Field>
      <Field label="Email (their username)" htmlFor="email" hint="What they will log in with. An account that belongs to a company cannot be used.">
        <Input id="email" name="email" type="email" required autoComplete="off" />
      </Field>
      <Field
        label="Password (optional)"
        htmlFor="password"
        hint="Set it here and they can log in straight away (at least 12 characters). Leave it blank to email them an invitation and let them choose their own."
      >
        <Input id="password" name="password" type="password" minLength={12} maxLength={72} autoComplete="new-password" />
      </Field>
      {/* ADR-159: there is one super admin; everyone added here is staff. */}
      <input type="hidden" name="platform_role" value="employee" />
      <p className="text-sm text-ink-muted">They are added to your team as a Financial Analyst. There is one super admin.</p>
      <CompanyTicks companies={companies} checked={new Set()} idPrefix="new-analyst" />
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Adding…">Add Financial Analyst</SubmitButton>
    </form>
  );
}

/** One analyst's login: name, email (username) and a new password, edited in place (ADR-186). */
function EditLogin({ userId, email, fullName }: { userId: string; email: string | null; fullName: string | null }) {
  const [state, action] = useActionState(editPlatformUserAction, null);
  return (
    <details className="group mt-1">
      <summary className="cursor-pointer text-xs font-medium text-accent hover:underline">Edit login</summary>
      <form action={action} className="mt-3 flex max-w-sm flex-col gap-4">
        <input type="hidden" name="user_id" value={userId} />
        <Field label="Their name" htmlFor={`edit-name-${userId}`}>
          <Input id={`edit-name-${userId}`} name="full_name" defaultValue={fullName ?? ''} maxLength={120} autoComplete="off" />
        </Field>
        <Field label="Email (their username)" htmlFor={`edit-email-${userId}`} hint="Changing it signs them out everywhere.">
          <Input id={`edit-email-${userId}`} name="email" type="email" required defaultValue={email ?? ''} autoComplete="off" />
        </Field>
        <Field label="New password (optional)" htmlFor={`edit-pw-${userId}`} hint="At least 12 characters. Leave empty to keep their password. Setting one signs them out everywhere.">
          <Input id={`edit-pw-${userId}`} name="password" type="password" minLength={12} maxLength={72} autoComplete="new-password" />
        </Field>
        <ActionMessage state={state} />
        <SubmitButton pendingLabel="Saving…">Save login</SubmitButton>
      </form>
    </details>
  );
}

/** One analyst's companies: the names, and the ticks to change them. */
function AnalystCompanies({ userId, companies, assigned }: {
  userId: string; companies: readonly CompanyChoice[]; assigned: ReadonlySet<string>;
}) {
  const [state, action] = useActionState(setAnalystCompaniesAction, null);
  const names = companies.filter((c) => assigned.has(c.id)).map((c) => c.name);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-sm text-ink">{names.length === 0 ? 'No companies yet' : names.join(', ')}</span>
      <details className="group">
        <summary className="cursor-pointer text-xs font-medium text-accent hover:underline">Change companies</summary>
        <form action={action} className="mt-3 flex flex-col gap-4">
          <input type="hidden" name="user_id" value={userId} />
          <CompanyTicks companies={companies} checked={assigned} idPrefix={`analyst-${userId}`} />
          <ActionMessage state={state} />
          <SubmitButton pendingLabel="Saving…">Save companies</SubmitButton>
        </form>
      </details>
    </div>
  );
}

export function PlatformUserRow(props: {
  userId: string;
  email: string | null;
  fullName: string | null;
  platformRole: string;
  status: string;
  companies: readonly CompanyChoice[];
  assigned: readonly string[];
}) {
  const [state, action] = useActionState(revokePlatformRoleAction, null);
  const isSuperAdmin = props.platformRole === 'super_admin';
  return (
    <TR>
      <TD className="break-all">
        {props.email ?? <code className="text-xs">{props.userId}</code>}
        {!isSuperAdmin && props.status === 'active' ? <EditLogin userId={props.userId} email={props.email} fullName={props.fullName} /> : null}
      </TD>
      <TD>{props.fullName ?? '—'}</TD>
      <TD>{PLATFORM_ROLE_LABELS[props.platformRole] ?? props.platformRole}</TD>
      <TD>
        {isSuperAdmin ? (
          <span className="text-xs text-ink-muted">Every company</span>
        ) : props.status === 'active' ? (
          <AnalystCompanies userId={props.userId} companies={props.companies} assigned={new Set(props.assigned)} />
        ) : (
          <span className="text-xs text-ink-muted">—</span>
        )}
      </TD>
      <TD>{props.status}</TD>
      <TD>
        {isSuperAdmin ? (
          <span className="text-xs text-ink-muted">The super admin</span>
        ) : (
          <>
            <form action={action}>
              <input type="hidden" name="user_id" value={props.userId} />
              <SubmitButton pendingLabel="…" tone="danger">Revoke</SubmitButton>
            </form>
            <ActionMessage state={state} />
          </>
        )}
      </TD>
    </TR>
  );
}
