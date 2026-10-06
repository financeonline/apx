'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import type { ActionResult } from '@/components/action-result';
import { Input, NativeSelect, Textarea } from '@/components/ui/shadcn';

/** The small forms of Team/Client Management (ADR-144). Each posts to a server action passed in. */

type Action = (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;

const FIELD = 'px-2 py-1';

export function CommentForm({ action, hidden, label = 'Add a comment' }: { action: Action; hidden: Record<string, string>; label?: string }) {
  const [state, submit] = useActionState(action, null);
  const field = hidden.item_id === undefined ? 'body' : 'note';
  return (
    <form action={submit} className="flex flex-col gap-2">
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-muted">{label}</span>
        <Textarea name={field} rows={3} maxLength={4000} required className={FIELD} />
      </label>
      <div className="flex items-center gap-3">
        <SubmitButton tone="secondary">Post</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}

export function NewItemForm({ action, orgSlug, kinds }: { action: Action; orgSlug: string; kinds: readonly ('request' | 'deliverable')[] }) {
  const [state, submit] = useActionState(action, null);
  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      {kinds.length === 1 ? <input type="hidden" name="kind" value={kinds[0]} /> : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">What is it?</span>
          <NativeSelect name="kind" className={FIELD} defaultValue="request">
            <option value="request">A request of the team</option>
            <option value="deliverable">A deliverable for the client</option>
          </NativeSelect>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-muted">Title</span>
        <Input name="title" required maxLength={200} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-muted">Details (optional)</span>
        <Textarea name="detail" rows={3} maxLength={4000} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-muted">Wanted by (optional)</span>
        <Input type="date" name="due_date" className={`${FIELD} max-w-xs`} />
      </label>
      <div className="flex items-center gap-3">
        <SubmitButton>{kinds.length === 1 && kinds[0] === 'request' ? 'Send the request' : 'Add it'}</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}

export function StatusForm({ action, orgSlug, itemId, options }: {
  action: Action; orgSlug: string; itemId: string; options: readonly { value: string; label: string }[];
}) {
  const [state, submit] = useActionState(action, null);
  return (
    <form action={submit} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="item_id" value={itemId} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-muted">Move it to</span>
        <NativeSelect name="status" className={FIELD}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </NativeSelect>
      </label>
      <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm">
        <span className="text-ink-muted">Note (optional)</span>
        <Input name="note" maxLength={4000} className={FIELD} />
      </label>
      <SubmitButton tone="secondary">Update</SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}

export function MarkAllReadForm({ action, orgSlug }: { action: Action; orgSlug: string }) {
  const [state, submit] = useActionState(action, null);
  return (
    <form action={submit} className="flex items-center gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <SubmitButton tone="quiet">Mark all as read</SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}
