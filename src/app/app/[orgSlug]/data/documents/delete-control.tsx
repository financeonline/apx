'use client';

import { useActionState, useState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { deleteDocumentAction } from './actions';

export function DeleteDocumentControl({ orgSlug, documentId, filename }: { orgSlug: string; documentId: string; filename: string }) {
  const [state, submit] = useActionState(deleteDocumentAction, null);
  const [armed, setArmed] = useState(false);
  if (state?.ok) return <ActionMessage state={state} />;
  if (!armed) {
    return <button type="button" onClick={() => setArmed(true)} className="text-sm text-danger underline underline-offset-2">Delete</button>;
  }
  return (
    <form action={submit} className="flex flex-wrap items-center gap-2 text-sm">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="document_id" value={documentId} />
      <span className="text-ink-muted">Delete {filename}? No import rests on it.</span>
      <SubmitButton tone="danger" pendingLabel="Deleting…">Yes, delete it</SubmitButton>
      <button type="button" onClick={() => setArmed(false)} className="text-ink-muted">Keep it</button>
      <ActionMessage state={state} />
    </form>
  );
}
