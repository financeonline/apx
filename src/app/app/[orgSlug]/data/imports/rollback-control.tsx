'use client';

import { useActionState } from 'react';
import { Input } from '@/components/ui/field';
import { ActionMessage } from '@/components/ui/action-form';
import { rollbackBatchAction } from './actions';

/**
 * Rolling an import back (IMPORT_ENGINE.md §12).
 *
 * A reason is required, not optional. A rollback removes rows that other figures were computed
 * from; six months later the only account of why will be this sentence, and "no reason given" is
 * not an account.
 */
export function RollbackControl({ orgSlug, batchId }: { orgSlug: string; batchId: string }) {
  const [state, action] = useActionState(rollbackBatchAction, null);

  return (
    <details>
      <summary className="cursor-pointer list-none text-sm text-ink-muted hover:text-ink">
        Roll back
      </summary>
      <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="org_slug" value={orgSlug} />
        <input type="hidden" name="batch_id" value={batchId} />
        <Input name="reason" placeholder="Why are you rolling this back?" required className="max-w-xs" />
        <button
          type="submit"
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:border-line-strong"
        >
          Remove these rows
        </button>
        <ActionMessage state={state} />
      </form>
    </details>
  );
}
