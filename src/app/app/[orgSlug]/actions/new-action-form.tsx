'use client';

import { useActionState, useState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { createActionAction } from './actions';

/**
 * Adding an action by hand (SOW §17).
 *
 * Collapsed until asked for. The Action Centre's job is to show what is outstanding; a form sitting
 * open above the list makes creating work look like the primary activity, when reading it is.
 */
export function NewActionForm({ orgSlug }: { orgSlug: string }) {
  const [open, setOpen] = useState(false);
  const [state, submit, pending] = useActionState(createActionAction, null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-accent underline underline-offset-2"
      >
        Add something to do
      </button>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-muted">What needs doing?</span>
        <input
          name="title"
          required
          maxLength={200}
          className="rounded-md border border-line px-3 py-2 text-ink"
          placeholder="Chase the overdue invoices"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-muted">Why? (optional)</span>
        <textarea
          name="issue"
          rows={2}
          className="rounded-md border border-line px-3 py-2 text-ink"
        />
      </label>

      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">How urgent?</span>
          <select name="priority" defaultValue="medium" className="rounded-md border border-line px-3 py-2 text-ink">
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">Due by (optional)</span>
          <input type="date" name="due_date" className="rounded-md border border-line px-3 py-2 text-ink" />
        </label>
      </div>

      <input type="hidden" name="org_slug" value={orgSlug} />

      <div className="flex items-center gap-3">
        <SubmitButton>Add it</SubmitButton>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="text-sm text-ink-muted underline underline-offset-2"
        >
          Cancel
        </button>
      </div>

      <ActionMessage state={state} />
    </form>
  );
}
