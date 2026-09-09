'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { reviewFeedbackAction } from '../actions';

/** Mark the report reviewed, actioned or dismissed, with a note (§13). */
export function ReviewForm({ feedbackId }: { feedbackId: string }) {
  const [state, submit] = useActionState(reviewFeedbackAction, null);
  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="feedback_id" value={feedbackId} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-muted">Outcome</span>
        <select name="status" required defaultValue="reviewed" className="rounded-md border border-line bg-surface px-3 py-2 text-ink">
          <option value="reviewed">Reviewed — a real problem, noted</option>
          <option value="actioned">Actioned — fixed or an eval case added</option>
          <option value="dismissed">Dismissed — not a defect</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-muted">Note</span>
        <textarea name="note" rows={3} maxLength={1000} className="rounded-md border border-line bg-surface px-3 py-2 text-ink" />
      </label>
      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Saving…">Save review</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}
