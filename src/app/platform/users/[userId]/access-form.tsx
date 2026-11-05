'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { saveAnalystAccessAction } from './actions';

export interface Choice { readonly key: string; readonly title: string; readonly detail: string }

const BOX = 'flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3 transition-colors hover:border-accent/60 has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40';

function Ticks({ legend, hint, name, choices, checked, idPrefix }: {
  legend: string; hint: string; name: string; choices: readonly Choice[]; checked: ReadonlySet<string>; idPrefix: string;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink">{legend}</legend>
      <p className="text-xs text-ink-muted">{hint}</p>
      <ul className="mt-3 grid gap-2 md:grid-cols-2">
        {choices.map((c) => (
          <li key={c.key} className="min-w-0">
            <label htmlFor={`${idPrefix}-${c.key}`} className={BOX}>
              <input id={`${idPrefix}-${c.key}`} type="checkbox" name={name} value={c.key} defaultChecked={checked.has(c.key)} className="mt-1 size-4 shrink-0 accent-accent" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{c.title}</span>
                <span className="block text-xs text-ink-muted">{c.detail}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** One company's ticks for one analyst: departments, then what they can see and do. */
export function AnalystAccessForm(props: {
  userId: string; orgId: string;
  departments: readonly Choice[]; departmentsOn: readonly string[];
  permissions: readonly Choice[]; permissionsOn: readonly string[];
}) {
  const [state, action] = useActionState(saveAnalystAccessAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="user_id" value={props.userId} />
      <input type="hidden" name="org_id" value={props.orgId} />
      <Ticks
        legend="Departments they can open" hint="Unticked departments are hidden from them in this company."
        name="department" choices={props.departments} checked={new Set(props.departmentsOn)} idPrefix={`dep-${props.orgId}`}
      />
      <Ticks
        legend="What they can see and do" hint="They can give the people in this company only what is ticked here."
        name="permission" choices={props.permissions} checked={new Set(props.permissionsOn)} idPrefix={`perm-${props.orgId}`}
      />
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save access</SubmitButton>
    </form>
  );
}
