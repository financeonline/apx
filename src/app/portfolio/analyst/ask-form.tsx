'use client';

import { useActionState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { askAdviserAction } from './actions';
import { Textarea } from '@/components/ui/shadcn';

const SUGGESTIONS = [
  'Which clients need attention, and why?',
  'What changed across my portfolio this week?',
  'Which clients have worsening health?',
  'Where are there unresolved serious alerts?',
];

export function AskForm() {
  const [state, action] = useActionState(askAdviserAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <label htmlFor="question" className="text-sm font-medium">Ask about the clients you advise</label>
      <Textarea
        id="question"
        name="question"
        required
        maxLength={1000}
        rows={3}
        placeholder={SUGGESTIONS[0]}
      />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Asking…">Ask</SubmitButton>
        <ActionMessage state={state} />
      </div>
      <p className="text-xs text-ink-muted">
        Try: {SUGGESTIONS.map((s, i) => <span key={s}>{i > 0 ? ' · ' : ''}{s}</span>)}
      </p>
    </form>
  );
}
