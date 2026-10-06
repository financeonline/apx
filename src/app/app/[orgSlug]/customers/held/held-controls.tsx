'use client';

import { useActionState } from 'react';
import { Input } from '@/components/ui/field';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { mergeHeldAction, renameHeldAction } from './actions';

/** D-5: keep one record of a held group and merge the others into it. */
export function MergeHeldForm({ orgSlug, members }: {
  orgSlug: string; members: ReadonlyArray<{ id: string; name: string }>;
}) {
  const [state, action] = useActionState(mergeHeldAction, null);
  return (
    <form action={action} className="flex flex-col gap-2 text-sm">
      <input type="hidden" name="org_slug" value={orgSlug} />
      {members.map((m) => <input key={m.id} type="hidden" name="member_id" value={m.id} />)}
      <label className="flex flex-col gap-1">
        <span className="text-ink">They are the same business. Keep:</span>
        <select name="into_id" required defaultValue="" className="rounded-md border border-line bg-surface px-2 py-1"
          onChange={(e) => {
            const chosen = members.find((m) => m.id === e.currentTarget.value);
            const hidden = e.currentTarget.form?.elements.namedItem('into_name') as HTMLInputElement | null;
            if (hidden && chosen) hidden.value = chosen.name;
          }}>
          <option value="" disabled>Choose the record to keep</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      <input type="hidden" name="into_name" defaultValue="" />
      <div><SubmitButton pendingLabel="Merging…">Merge into the chosen record</SubmitButton></div>
      <ActionMessage state={state} />
    </form>
  );
}

/** D-5: rename one record so the two are different names; re-save the last one to release it. */
export function RenameHeldForm({ orgSlug, id, name }: { orgSlug: string; id: string; name: string }) {
  const [state, action] = useActionState(renameHeldAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 text-sm">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="counterparty_id" value={id} />
      <label className="flex flex-col gap-1">
        <span className="text-ink-muted">Name</span>
        <Input name="name" defaultValue={name} required maxLength={200} aria-label={`New name for ${name}`} />
      </label>
      <SubmitButton pendingLabel="Saving…">Save name</SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}
