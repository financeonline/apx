'use client';

import { useActionState } from 'react';
import { Input } from '@/components/ui/field';
import { ActionMessage } from '@/components/ui/action-form';
import { rollbackBatchAction } from './actions';
import { Button } from '@/components/ui/shadcn';

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
      <summary className="cursor-pointer list-none py-1 text-sm whitespace-nowrap text-ink-muted hover:text-ink pointer-coarse:py-2.5">
        Roll back
      </summary>
      <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="org_slug" value={orgSlug} />
        <input type="hidden" name="batch_id" value={batchId} />
        <Input name="reason" placeholder="Why are you rolling this back?" required className="min-w-48 max-w-xs" />
        <Button
          type="submit"
          variant="secondary"
          className="px-3 py-1.5"
        >
          Remove these rows
        </Button>
        <ActionMessage state={state} />
      </form>
    </details>
  );
}
