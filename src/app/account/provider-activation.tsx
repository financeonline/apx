'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { Input } from '@/components/ui/shadcn';
import { Badge } from '@/components/ui/surfaces';
import { setActiveAiProviderAction } from './actions';

/**
 * Which AI provider is active (ADR-165). Exactly one is: making this one active makes the other
 * inactive. An inactive provider that cannot be used yet says why instead of offering the button.
 */
export function ProviderActivation({ provider, active, otherName, blockedReason }: {
  provider: 'anthropic' | 'openai';
  active: boolean;
  /** The other provider's name, to say what happens to it. */
  otherName: string;
  /** Why this provider cannot be made active yet, or null. */
  blockedReason: string | null;
}) {
  const [state, activate] = useActionState(setActiveAiProviderAction, null);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-sunken/40 p-3">
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink" data-testid={`${provider}-active-status`}>
        {active ? <Badge tone="accent">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}
        {active ? `The AI uses this provider. ${otherName} is inactive.` : `The AI does not use this provider while ${otherName} is active.`}
      </p>
      {active ? null : blockedReason ? (
        <p className="text-xs text-ink-muted">{blockedReason}</p>
      ) : (
        <form action={activate} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="provider" value={provider} />
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Your password, to confirm it is you</span>
            <Input name="current_password" type="password" required autoComplete="current-password" aria-label="Your password" />
          </label>
          <SubmitButton pendingLabel="Switching…">Make active</SubmitButton>
          <ActionMessage state={state} />
        </form>
      )}
    </div>
  );
}
