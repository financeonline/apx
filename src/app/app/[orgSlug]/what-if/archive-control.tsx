'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { archiveScenarioAction } from './actions';

/**
 * Putting a saved scenario away, or bringing it back (§13).
 *
 * Not "delete": the scenario's evidence bundle points at it, and the list of what a business has
 * modelled is part of the record of how it decided things. The button says what it does.
 */
export function ArchiveControl({
  orgSlug, scenarioId, archived,
}: {
  orgSlug: string;
  scenarioId: string;
  archived: boolean;
}) {
  const [state, submit] = useActionState(archiveScenarioAction, null);
  return (
    <form action={submit} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="scenario_id" value={scenarioId} />
      <input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
      <SubmitButton tone="quiet" pendingLabel="Saving…">
        {archived ? 'Bring this back' : 'Put this away'}
      </SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}
