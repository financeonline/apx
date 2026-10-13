'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/ui/surfaces';
import { finishCustomReportAction } from '../../actions';
import { NativeSelect, Textarea } from '@/components/ui/shadcn';

/**
 * The Custom AI Report builder (Phase 17, R17-4).
 *
 * Each question is sent, in turn, to `POST /api/ai/chat` — the analyst's own route, so the same
 * grounding, refusals, evidence and quota apply — in one conversation kept for this report. When the
 * answers are in, the server reads them back from that conversation and stores the report; this
 * component never hands the server an answer, only the ids of the turns it asked for.
 *
 * The period and areas are written into each question in words ("For August 2026, looking at
 * cash: …"), so the analyst's own period resolution reads them and the report shows what was asked.
 */

type QuestionState =
  | { readonly status: 'waiting' }
  | { readonly status: 'asking' }
  | { readonly status: 'answered'; readonly messageId: string }
  | { readonly status: 'refused'; readonly message: string };

interface Option { readonly value: string; readonly label: string }

/** A checkbox and its words: the whole line is the target, at least 40px tall on a touch screen. */
const CHOICE = 'flex items-center gap-2 py-1 text-sm text-ink pointer-coarse:min-h-10';

/** Mirrors `customQuestionMessage` in modules/reporting (kept here: this file runs in the browser). */
function messageFor(periodLabel: string, dimensions: readonly Option[], question: string): string {
  // As `focusWord`: lower case, except an abbreviation ("VAT") stays as it is.
  const word = (label: string) => (label === label.toUpperCase() ? label : label.toLowerCase());
  const focus = dimensions.length === 0 ? '' : `, looking at ${dimensions.map((d) => word(d.label)).join(', ')}`;
  return `For ${periodLabel}${focus}: ${question.trim()}`;
}

async function ask(orgSlug: string, conversationId: string | null, message: string):
  Promise<{ ok: true; conversationId: string; messageId: string } | { ok: false; message: string }> {
  const response = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgSlug, message, ...(conversationId === null ? {} : { conversationId }) }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    return { ok: false, message: body?.error?.message ?? 'The analyst could not take that question.' };
  }
  const text = await response.text();
  for (const frame of text.split('\n\n')) {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (data === undefined) continue;
    if (event === 'answer') {
      const answer = JSON.parse(data) as { conversationId: string; messageId: string };
      return { ok: true, conversationId: answer.conversationId, messageId: answer.messageId };
    }
    if (event === 'error') {
      return { ok: false, message: (JSON.parse(data) as { message?: string }).message ?? 'The analyst could not answer.' };
    }
  }
  return { ok: false, message: 'The analyst did not answer.' };
}

export function CustomBuilder({
  orgSlug, periods, suggestions, dimensions, fixedAreas, maxQuestions, maxChars,
}: {
  orgSlug: string;
  periods: readonly { readonly id: string; readonly label: string }[];
  suggestions: readonly string[];
  dimensions: readonly Option[];
  /** The areas that also carry a table of MOTION's own figures, with or without the analyst (ADR-156). */
  fixedAreas: readonly string[];
  maxQuestions: number;
  maxChars: number;
}) {
  const router = useRouter();
  const [periodId, setPeriodId] = useState(periods[0]?.id ?? '');
  const [chosenDimensions, setChosenDimensions] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [own, setOwn] = useState('');
  const [progress, setProgress] = useState<QuestionState[]>([]);
  const [phase, setPhase] = useState<'composing' | 'asking' | 'saving' | 'stopped'>('composing');
  const [notice, setNotice] = useState<string | null>(null);

  const ownQuestions = own.split('\n').map((q) => q.trim()).filter((q) => q.length > 0);
  const questions = [...chosen, ...ownQuestions];
  const tooMany = questions.length > maxQuestions;
  const tooLong = ownQuestions.some((q) => q.length > maxChars);
  // A Loans, Assets, VAT or Corporation Tax area puts MOTION's own figures in the report, so the
  // report can be saved with them even when no question was asked or the analyst could not answer.
  const hasFixed = chosenDimensions.some((d) => fixedAreas.includes(d));

  function toggle(list: string[], value: string, set: (next: string[]) => void) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function save(conversationId: string | null, answered: string[]) {
    setPhase('saving');
    const result = await finishCustomReportAction({
      orgSlug, conversationId, periodId, dimensions: chosenDimensions, assistantMessageIds: answered,
    });
    if (result.ok) router.push(`/app/${orgSlug}/reports/r/${result.reportId}`);
    else { setNotice(result.message); setPhase('stopped'); }
  }

  async function run() {
    const period = periods.find((p) => p.id === periodId);
    if (period === undefined || (questions.length === 0 && !hasFixed) || tooMany || tooLong) return;
    if (questions.length === 0) {
      setNotice(null);
      await save(null, []);
      return;
    }
    const focus = dimensions.filter((d) => chosenDimensions.includes(d.value));
    setNotice(null);
    setPhase('asking');
    const states: QuestionState[] = questions.map(() => ({ status: 'waiting' }));
    setProgress([...states]);

    let conversationId: string | null = null;
    const answered: string[] = [];
    for (let i = 0; i < questions.length; i += 1) {
      states[i] = { status: 'asking' };
      setProgress([...states]);
      const result = await ask(orgSlug, conversationId, messageFor(period.label, focus, questions[i]!));
      if (!result.ok) {
        states[i] = { status: 'refused', message: result.message };
        setProgress([...states]);
        // A refusal of the turn itself (the allowance, a permission) stops the run; what was
        // answered can still be saved.
        setNotice(result.message);
        setPhase('stopped');
        if ((conversationId !== null && answered.length > 0) || hasFixed) {
          setStopped({ conversationId: answered.length > 0 ? conversationId : null, answered: [...answered] });
        }
        return;
      }
      conversationId = result.conversationId;
      answered.push(result.messageId);
      states[i] = { status: 'answered', messageId: result.messageId };
      setProgress([...states]);
    }
    if (conversationId !== null) await save(conversationId, answered);
  }

  const [stopped, setStopped] = useState<{ conversationId: string | null; answered: string[] } | null>(null);
  const busy = phase === 'asking' || phase === 'saving';

  return (
    // A readable measure on a very wide screen.
    <div className="flex max-w-3xl flex-col gap-6">
      <fieldset disabled={busy} className="flex flex-col gap-6">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">Month</span>
          <NativeSelect value={periodId} onChange={(e) => setPeriodId(e.target.value)} className="max-w-xs px-2 py-1">
            {periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </NativeSelect>
        </label>

        <div>
          <p className="text-sm text-ink-muted">Areas to look at (optional)</p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {dimensions.map((d) => (
              <label key={d.value} className={CHOICE}>
                <input type="checkbox" className="shrink-0" checked={chosenDimensions.includes(d.value)}
                  onChange={() => toggle(chosenDimensions, d.value, setChosenDimensions)} />
                {d.label}
              </label>
            ))}
          </div>
          {fixedAreas.length === 0 ? null : (
            <p className="mt-2 text-xs text-ink-faint">
              {dimensions.filter((d) => fixedAreas.includes(d.value)).map((d) => d.label).join(', ')} also add a
              table of APX&apos;s own figures to the report, whether or not the analyst can answer.
            </p>
          )}
        </div>

        <div>
          <p className="text-sm text-ink-muted">Questions — choose any of these…</p>
          <div className="mt-2 flex flex-col gap-1">
            {suggestions.map((q) => (
              <label key={q} className={CHOICE}>
                <input type="checkbox" className="shrink-0" checked={chosen.includes(q)} onChange={() => toggle(chosen, q, setChosen)} />
                {q}
              </label>
            ))}
          </div>
          <label className="mt-4 flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">…and add your own, one per line</span>
            <Textarea value={own} onChange={(e) => setOwn(e.target.value)} rows={3}
              className="px-2 py-1" />
          </label>
          <p className={`mt-2 text-sm ${tooMany || tooLong ? 'text-danger' : 'text-ink-muted'}`}>
            {questions.length} of at most {maxQuestions} questions.
            {tooLong ? ` Keep each question under ${maxChars} characters.` : ''}
          </p>
        </div>
      </fieldset>

      {phase === 'composing' ? (
        <div>
          <Button type="button" onClick={() => void run()} disabled={(questions.length === 0 && !hasFixed) || tooMany || tooLong || periodId === ''}>
            {questions.length === 0 && hasFixed ? 'Build the report with APX\'s figures' : 'Ask the analyst and build the report'}
          </Button>
        </div>
      ) : null}

      {progress.length === 0 ? null : (
        <ol className="flex flex-col gap-2 text-sm" aria-live="polite">
          {questions.map((q, i) => {
            const state = progress[i];
            const label = state?.status === 'answered' ? 'Answered'
              : state?.status === 'asking' ? 'Asking…'
                : state?.status === 'refused' ? `Not answered: ${state.message}` : 'Waiting';
            return <li key={`${i}:${q}`} className="flex flex-wrap justify-between gap-2"><span className="min-w-0 text-ink [overflow-wrap:anywhere]">{q}</span><span className="text-ink-muted">{label}</span></li>;
          })}
        </ol>
      )}

      {phase === 'saving' ? <p className="text-sm text-ink-muted">Saving the report…</p> : null}
      {notice === null ? null : <Banner tone="warn" title="The report is not finished">{notice}</Banner>}
      {phase === 'stopped' && stopped !== null ? (
        <div>
          <Button type="button" tone="secondary" onClick={() => void save(stopped.conversationId, stopped.answered)}>
            {stopped.answered.length === 0 ? 'Save the report with APX\'s figures only' : (
              <>Save the report with the {stopped.answered.length} answered question{stopped.answered.length === 1 ? '' : 's'}</>
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
