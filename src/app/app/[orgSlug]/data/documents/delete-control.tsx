'use client';

import { useActionState, useState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { deleteDocumentAction } from './actions';
import { Button } from '@/components/ui/shadcn';

export function DeleteDocumentControl({ orgSlug, documentId, filename }: { orgSlug: string; documentId: string; filename: string }) {
  const [state, submit] = useActionState(deleteDocumentAction, null);
  const [armed, setArmed] = useState(false);
  if (state?.ok) return <ActionMessage state={state} />;
  if (!armed) {
    return <Button type="button" variant="link" onClick={() => setArmed(true)} className="py-0 text-danger">Delete</Button>;
  }
  return (
    <form action={submit} className="flex flex-wrap items-center gap-2 text-sm">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="document_id" value={documentId} />
      <span className="min-w-0 text-ink-muted [overflow-wrap:anywhere]">Delete {filename}? No import rests on it.</span>
      <SubmitButton tone="danger" pendingLabel="Deleting…">Yes, delete it</SubmitButton>
      <Button type="button" variant="ghost" onClick={() => setArmed(false)}>Keep it</Button>
      <ActionMessage state={state} />
    </form>
  );
}
