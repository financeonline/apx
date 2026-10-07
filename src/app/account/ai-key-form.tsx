'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { Input } from '@/components/ui/shadcn';
import { clearAiKeyAction, clearOpenAiKeyAction, setAiKeyAction, setOpenAiKeyAction } from './actions';

/**
 * Replace or remove the AI provider key (ADR-157). The field is a password field that never shows
 * the stored key — only its last four characters appear on the page.
 */
export function AiKeyForm({ configured, provider = 'anthropic' }: { configured: boolean; provider?: 'anthropic' | 'openai' }) {
  const openAi = provider === 'openai';
  const [saved, save] = useActionState(openAi ? setOpenAiKeyAction : setAiKeyAction, null);
  const [removed, remove] = useActionState(openAi ? clearOpenAiKeyAction : clearAiKeyAction, null);
  return (
    <div className="flex flex-col gap-4">
      <form action={save} className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink">{configured ? 'Replace it with a new key' : openAi ? 'OpenAI API key' : 'Anthropic API key'}</span>
          <span className="text-xs text-ink-muted">
            {openAi
              ? 'Paste the key from platform.openai.com. It is checked with OpenAI, then stored encrypted.'
              : 'Paste the key from console.anthropic.com. It is checked with Anthropic, then stored encrypted.'}
          </span>
          <Input
            name="api_key" type="password" required autoComplete="off" spellCheck={false}
            placeholder={openAi ? 'sk-…' : 'sk-ant-…'} className="mt-1 font-mono text-xs"
          />
        </label>
        <PasswordField />
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pendingLabel={openAi ? 'Checking with OpenAI…' : 'Checking with Anthropic…'}>Save key</SubmitButton>
          <ActionMessage state={saved} />
        </div>
      </form>
      {configured ? (
        <form action={remove} className="flex flex-col gap-2 border-t border-line pt-4">
          <PasswordField />
          <div className="flex flex-wrap items-center gap-3">
          <SubmitButton tone="danger" pendingLabel="Removing…">Remove the stored key</SubmitButton>
          <ActionMessage state={removed} />
          </div>
        </form>
      ) : null}
    </div>
  );
}

/** Changing the key needs the super admin's password, so a session left open cannot change it. */
function PasswordField() {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink">Your password</span>
      <span className="text-xs text-ink-muted">To confirm it is you.</span>
      <Input name="current_password" type="password" required autoComplete="current-password" className="mt-1" />
    </label>
  );
}
