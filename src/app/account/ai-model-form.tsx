'use client';

import { useActionState, useState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { Input, NativeSelect } from '@/components/ui/shadcn';
import { setAiModelAction } from './actions';

export interface ModelChoiceOption {
  readonly provider: 'anthropic' | 'openai';
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
/** The value a model is sent as: "provider:model" (ADR-164). */
const valueOf = (o: { provider: string; id: string }) => `${o.provider}:${o.id}`;

/**
 * One provider's models and effort (ADR-163, ADR-164): the Anthropic card lists Claude models (with
 * "Default"), the OpenAI card lists OpenAI models. Each provider remembers its own choice; which one
 * the AI uses is the active provider (ADR-165). With `unavailable` set, the choices are shown but
 * cannot be used yet.
 */
export function AiModelForm({ provider, options, chosenModel, chosenEffort, defaultModel, unavailable }: {
  provider: 'anthropic' | 'openai';
  options: readonly ModelChoiceOption[];
  /** "provider:model" of the model in use, or null for the default. */
  chosenModel: string | null;
  chosenEffort: string | null;
  defaultModel: string;
  /** Why the choices cannot be used yet (no key stored), or null. */
  unavailable?: string | null;
}) {
  const openAi = provider === 'openai';
  const mine = options.filter((o) => o.provider === provider);
  const inThisCard = chosenModel !== null && chosenModel.startsWith(`${provider}:`);
  const [state, save] = useActionState(setAiModelAction, null);
  const [model, setModel] = useState(inThisCard ? chosenModel! : '');
  const [effort, setEffort] = useState(inThisCard ? (chosenEffort ?? '') : '');
  const defaultName = options.find((o) => o.provider === 'anthropic' && o.id === defaultModel)?.name ?? defaultModel;
  const current = mine.find((o) => valueOf(o) === (model || (openAi ? '' : `anthropic:${defaultModel}`)));
  const efforts = current?.efforts ?? [];
  const effortDisabled = Boolean(unavailable) || efforts.length === 0;
  const effortHint = unavailable
    ? 'Choose a model first.'
    : openAi && !current
      ? 'Choose a model first. Only OpenAI reasoning models (the o-series and GPT-5) have an effort setting.'
      : efforts.length === 0
        ? `${current?.name ?? 'This model'} has no effort setting.${openAi ? ' Only OpenAI reasoning models (the o-series and GPT-5) have one.' : ' To set effort, choose Claude Sonnet 4.6 or a Claude Opus 4 model.'}`
        : 'How hard the model works on each answer. Higher is slower and costs more.';

  return (
    <form action={save} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink">{openAi ? 'OpenAI model' : 'AI model'}</span>
        <span className="text-xs text-ink-muted">
          {unavailable ?? (openAi
            ? 'The OpenAI models your key can use. It is used once OpenAI is made active above.'
            : 'The Claude models your key can use. Haiku is fastest and cheapest; Sonnet and Opus are more capable.')}
        </span>
        <NativeSelect
          name="ai_model" value={model} className="mt-1" disabled={Boolean(unavailable)} required={openAi}
          onChange={(e) => {
            setModel(e.target.value);
            const next = mine.find((o) => valueOf(o) === (e.target.value || (openAi ? '' : `anthropic:${defaultModel}`)))?.efforts ?? [];
            if (!next.includes(effort as never)) setEffort('');
          }}
        >
          {openAi
            ? <option value="" disabled>{unavailable ? 'Store an OpenAI key first' : 'Choose an OpenAI model'}</option>
            : <option value="">Default ({defaultName})</option>}
          {mine.map((o) => <option key={valueOf(o)} value={valueOf(o)}>{o.name}</option>)}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink">Effort</span>
        <span className={effortDisabled && !unavailable ? 'text-xs text-ink' : 'text-xs text-ink-muted'}>{effortHint}</span>
        <NativeSelect name="ai_effort" value={effortDisabled ? '' : effort} disabled={effortDisabled} onChange={(e) => setEffort(e.target.value)} className="mt-1">
          <option value="">Model default</option>
          {efforts.map((level) => <option key={level} value={level}>{EFFORT_LABELS[level] ?? level}</option>)}
        </NativeSelect>
      </label>
      {unavailable ? null : (
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink">Your password</span>
            <span className="text-xs text-ink-muted">To confirm it is you.</span>
            <Input name="current_password" type="password" required autoComplete="current-password" className="mt-1" />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pendingLabel={openAi ? 'Checking with OpenAI…' : 'Checking with Anthropic…'}>
              {openAi ? 'Save OpenAI model' : 'Save model'}
            </SubmitButton>
            <ActionMessage state={state} />
          </div>
        </>
      )}
    </form>
  );
}
