'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { Card, CardBody } from '@/components/ui/surfaces';
import { assignActionAction } from '../actions';

/**
 * Who owns this action (SOW §17; RBAC_MATRIX.md `actions.assign`).
 *
 * The list is the organisation's current members and assigned employees, resolved on the server at
 * render. `api.assign_action` refuses anybody without access anyway — not offering them is the
 * difference between a considered interface and one that fails after the click.
 */
export function AssignControl({
  orgSlug,
  actionId,
  ownerUserId,
  owners,
}: {
  orgSlug: string;
  actionId: string;
  ownerUserId: string | null;
  owners: ReadonlyArray<{ userId: string; name: string }>;
}) {
  const [state, submit] = useActionState(assignActionAction, null);

  return (
    <Card>
      <CardBody>
        <h2 className="font-serif text-lg text-ink">Who is doing it</h2>
        <form action={submit} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="org_slug" value={orgSlug} />
          <input type="hidden" name="action_id" value={actionId} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">Assign to</span>
            <select
              name="owner_user_id"
              defaultValue={ownerUserId ?? ''}
              className="w-72 max-w-full rounded-md border border-line px-3 py-2 text-ink"
            >
              <option value="">Nobody</option>
              {owners.map((owner) => (
                <option key={owner.userId} value={owner.userId}>{owner.name}</option>
              ))}
            </select>
          </label>
          <SubmitButton tone="secondary">Assign</SubmitButton>
        </form>
        <ActionMessage state={state} />
      </CardBody>
    </Card>
  );
}
