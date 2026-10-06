'use client';

import { useActionState, useState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { createActionAction } from './actions';
import { Button, Input, NativeSelect, Textarea } from '@/components/ui/shadcn';

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
      <Button
        type="button"
        variant="link"
        onClick={() => setOpen(true)}
      >
        Add something to do
      </Button>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-muted">What needs doing?</span>
        <Input
          name="title"
          required
          maxLength={200}
          placeholder="Chase the overdue invoices"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-muted">Why? (optional)</span>
        <Textarea
          name="issue"
          rows={2}
        />
      </label>

      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">How urgent?</span>
          <NativeSelect name="priority" defaultValue="medium">
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </NativeSelect>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">Due by (optional)</span>
          <Input type="date" name="due_date" />
        </label>
      </div>

      <input type="hidden" name="org_slug" value={orgSlug} />

      <div className="flex items-center gap-3">
        <SubmitButton>Add it</SubmitButton>
        <Button
          type="button"
          variant="link"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="text-ink-muted"
        >
          Cancel
        </Button>
      </div>

      <ActionMessage state={state} />
    </form>
  );
}
