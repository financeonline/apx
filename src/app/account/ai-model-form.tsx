'use client';

import { useActionState, useState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { Input, NativeSelect } from '@/components/ui/shadcn';
import { setAiModelAction } from './actions';

export interface ModelChoiceOption {
  readonly id: string;
  readonly name: string;
  readonly efforts: readonly string[];
}

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low — fastest, cheapest',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max — slowest, most thorough',
};

/**
 * The AI model and its effort (ADR-163). The effort list follows the model chosen: only the levels
 * that model supports are offered, and a model without the setting offers only its default.
 */
export function AiModelForm({ options, chosenModel, chosenEffort, defaultModel }: {
  options: readonly ModelChoiceOption[];
  chosenModel: string | null;
  chosenEffort: string | null;
  defaultModel: string;
}) {
  const [state, save] = useActionState(setAiModelAction, null);
  const [model, setModel] = useState(chosenModel ?? '');
  const [effort, setEffort] = useState(chosenEffort ?? '');
  const defaultName = options.find((o) => o.id === defaultModel)?.name ?? defaultModel;
  const current = options.find((o) => o.id === (model || defaultModel));
  const efforts = current?.efforts ?? [];
  const effortDisabled = efforts.length === 0;

  return (
    <form action={save} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink">AI model</span>
        <span className="text-xs text-ink-muted">The models your key can use. Haiku is fastest and cheapest; Sonnet and Opus are more capable.</span>
        <NativeSelect
          name="ai_model" value={model} className="mt-1"
          onChange={(e) => {
            setModel(e.target.value);
            const next = options.find((o) => o.id === e.target.value)?.efforts ?? [];
            if (!next.includes(effort)) setEffort('');
          }}
        >
          <option value="">Default ({defaultName})</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink">Effort</span>
        <span className={effortDisabled ? 'text-xs text-ink' : 'text-xs text-ink-muted'}>
          {effortDisabled
            ? `${current?.name ?? 'This model'} has no effort setting. To set effort, choose Claude Sonnet 4.6 or a Claude Opus 4 model above.`
            : 'How hard the model works on each answer. Higher is slower and costs more.'}
        </span>
        <NativeSelect name="ai_effort" value={effortDisabled ? '' : effort} disabled={effortDisabled} onChange={(e) => setEffort(e.target.value)} className="mt-1">
          <option value="">Model default</option>
          {efforts.map((level) => <option key={level} value={level}>{EFFORT_LABELS[level] ?? level}</option>)}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink">Your password</span>
        <span className="text-xs text-ink-muted">To confirm it is you.</span>
        <Input name="current_password" type="password" required autoComplete="current-password" className="mt-1" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Checking with Anthropic…">Save model</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}
