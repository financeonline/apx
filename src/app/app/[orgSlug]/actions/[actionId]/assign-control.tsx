'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { UserRoundCheck } from 'lucide-react';
import { Card, CardBody, IconBadge } from '@/components/ui/surfaces';
import { assignActionAction } from '../actions';
import { NativeSelect } from '@/components/ui/shadcn';

/**
 * Who owns this action (SOW §17; RBAC_MATRIX.md `actions.assign`).
 *
 * The list is the organisation's current members and assigned Financial Analysts who can see the
 * Action Centre (`api.action_assignees`, ADR-172), resolved on the server at render. `api.assign_action`
 * refuses anybody else anyway — a 3rd party, or a client whose Action Centre is switched off — and not
 * offering them is the difference between a considered interface and one that fails after the click.
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
  // The current owner may since have lost the Action Centre (a switch, a role change): they are not
  // offered, so say why the list does not start on them.
  const ownerGone = ownerUserId !== null && !owners.some((owner) => owner.userId === ownerUserId);

  return (
    <Card>
      <CardBody>
        <div className="flex min-w-0 items-center gap-3">
          <IconBadge tint="pink" size="sm"><UserRoundCheck /></IconBadge>
          <h2 className="min-w-0 font-serif text-lg text-ink">Who is doing it</h2>
        </div>
        <form action={submit} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="org_slug" value={orgSlug} />
          <input type="hidden" name="action_id" value={actionId} />
          <label className="flex w-full min-w-0 flex-col gap-1 text-sm sm:w-auto">
            <span className="text-ink-muted">Assign to</span>
            <NativeSelect
              name="owner_user_id"
              defaultValue={ownerGone ? '' : (ownerUserId ?? '')}
              className="w-full sm:w-72"
            >
              <option value="">Nobody</option>
              {owners.map((owner) => (
                <option key={owner.userId} value={owner.userId}>{owner.name}</option>
              ))}
            </NativeSelect>
          </label>
          <SubmitButton tone="secondary">Assign</SubmitButton>
        </form>
        {ownerGone ? (
          <p className="mt-2 text-xs text-warn">
            The person it is given to can no longer see the Action Centre. Choose someone who can.
          </p>
        ) : null}
        <ActionMessage state={state} />
      </CardBody>
    </Card>
  );
}
