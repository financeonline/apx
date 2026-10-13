'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState, type ReactNode } from 'react';
import type { SubmitAnswer } from '@/modules/ai';
import {
  CREATE_ACTION_WITHHELD, DEGRADED_BANNER, KIND_LABELS, KIND_TONES, PRIORITY_LABELS, SECTION_ORDER,
  SECTION_TITLES, UNDER_REVIEW_LABEL, canCreateActionFrom, dataQualityNoteLine, notCoveredLine,
  revealSteps, type StatementKind,
} from '@/components/dashboard/analyst-presentation';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { Badge, Banner } from '@/components/ui/surfaces';
import type { MessageView } from './analyst-chat';
import { createActionFromAnswerAction, reportAnswerAction } from './actions';
import { Button, NativeSelect, Textarea } from '@/components/ui/shadcn';

/**
 * One assistant message (UX_ARCHITECTURE.md §5 `AnalystChat`, §7.2, §8.1, §8.3).
 *
 * Sections in contract order — Direct answer · Key findings · Causes · Risks · Opportunities ·
 * Recommended actions · Confidence · Not covered · Evidence — revealed one at a time from the single
 * validated answer (ADR-032.4). Every statement wears exactly one kind badge, and the badge is the
 * server's verdict on the data, not the model's label (§6.2). "Why?" opens the evidence bundle the
 * server built from what the tools returned. "Create action" exists only on an answer that passed.
 */

export const FALLBACK_TITLE = "The analyst isn't available right now";
/** An answer was written but did not pass the checks (§7): withheld, not "unavailable". */
export const WITHHELD_TITLE = "The analyst's answer didn't pass APX's checks";

type Statement = SubmitAnswer['direct_answer'];

const REVEAL_MS = 220;

export function AnswerView({
  orgSlug,
  message,
  facts,
  canCreateAction,
  animate,
}: {
  orgSlug: string;
  message: MessageView;
  facts: ReactNode;
  canCreateAction: boolean;
  animate: boolean;
}) {
  const answer = message.structured;
  const total = answer ? revealSteps(answer) : 0;
  const [revealed, setRevealed] = useState(animate ? 1 : total);

  useEffect(() => {
    if (!animate || revealed >= total) return;
    const timer = window.setTimeout(() => setRevealed((r) => r + 1), REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [animate, revealed, total]);

  // §13: every assistant message can be reported — a failed one included, since "it failed" is
  // itself something a reader may want looked at.
  if (!answer || message.groundingStatus === 'failed') {
    return (
      <div className="flex flex-col gap-3">
        <Unavailable facts={facts} withheld={message.groundingStatus === 'failed'} />
        <div className="flex justify-end text-sm"><FeedbackControls orgSlug={orgSlug} messageId={message.id} /></div>
      </div>
    );
  }

  const evidenceHref = message.evidenceBundleId ? `/app/${orgSlug}/evidence/${message.evidenceBundleId}` : null;
  const degraded = message.groundingStatus === 'degraded';
  const createAllowed = canCreateActionFrom(message.groundingStatus, canCreateAction);

  // Which step each section is revealed at, in contract order.
  let step = 1;
  const stepOf: Partial<Record<(typeof SECTION_ORDER)[number], number>> = {};
  for (const key of SECTION_ORDER) {
    if (answer[key].length > 0) { step += 1; stepOf[key] = step; }
  }
  const closingStep = step + 1;

  return (
    <article className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4" aria-live="polite">
      {message.flagged ? <div><Badge tone="warn">{UNDER_REVIEW_LABEL}</Badge></div> : null}
      {degraded ? <Banner tone="warn" title={DEGRADED_BANNER} /> : null}

      {answer.mode === 'answer' ? (
        <StatementLine statement={answer.direct_answer} evidenceHref={evidenceHref} lead />
      ) : (
        <p className="text-base text-ink">{answer.direct_answer.statement}</p>
      )}

      {SECTION_ORDER.map((key) => {
        const at = stepOf[key];
        if (at === undefined || revealed < at) return null;
        if (key === 'recommended_actions') {
          return (
            <Section key={key} title={SECTION_TITLES[key]}>
              {answer.recommended_actions.map((rec, index) => (
                <Recommendation
                  key={index}
                  orgSlug={orgSlug}
                  messageId={message.id}
                  index={index}
                  rec={rec}
                  evidenceHref={evidenceHref}
                  createAllowed={createAllowed}
                />
              ))}
              {!createAllowed && canCreateAction ? (
                <p className="text-xs text-ink-faint">{CREATE_ACTION_WITHHELD}</p>
              ) : null}
            </Section>
          );
        }
        return (
          <Section key={key} title={SECTION_TITLES[key]}>
            {answer[key].map((statement, index) => (
              <StatementLine key={index} statement={statement} evidenceHref={evidenceHref} />
            ))}
          </Section>
        );
      })}

      {revealed >= closingStep ? (
        <>
          {answer.confidence.data_quality_notes.length > 0 ? (
            <Section title="Confidence">
              {answer.confidence.data_quality_notes.map((note, index) => (
                <p key={index} className="text-sm text-ink-muted">{dataQualityNoteLine(note)}</p>
              ))}
            </Section>
          ) : null}
          {answer.unsupported.length > 0 ? (
            <Section title="Not covered">
              {answer.unsupported.map((item, index) => (
                <p key={index} className="text-sm text-ink-muted">{notCoveredLine(item)}</p>
              ))}
            </Section>
          ) : null}
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-sm">
            {evidenceHref ? (
              <Link href={evidenceHref} className="text-accent underline underline-offset-2">
                See the evidence behind this answer
              </Link>
            ) : <span />}
            <FeedbackControls orgSlug={orgSlug} messageId={message.id} />
          </footer>
        </>
      ) : null}
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">{title}</h3>
      {children}
    </section>
  );
}

function StatementLine({ statement, evidenceHref, lead = false }: { statement: Statement; evidenceHref: string | null; lead?: boolean }) {
  const kind = statement.kind as StatementKind;
  return (
    <p className={lead ? 'text-base text-ink' : 'text-sm text-ink'}>
      <Badge tone={KIND_TONES[kind]}>{KIND_LABELS[kind]}</Badge>{' '}
      {statement.statement}
      {evidenceHref ? (
        <>
          {' '}
          <Link href={evidenceHref} className="text-accent underline underline-offset-2">
            Why?<span className="sr-only"> See the evidence behind this statement</span>
          </Link>
        </>
      ) : null}
    </p>
  );
}

function Recommendation({
  orgSlug, messageId, index, rec, evidenceHref, createAllowed,
}: {
  orgSlug: string;
  messageId: string;
  index: number;
  rec: SubmitAnswer['recommended_actions'][number];
  evidenceHref: string | null;
  createAllowed: boolean;
}) {
  const [state, submit] = useActionState(createActionFromAnswerAction, null);
  return (
    <div className="rounded-md border border-line p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium text-ink">{rec.title.statement}</p>
        <Badge tone={rec.priority === 'critical' || rec.priority === 'high' ? 'danger' : 'neutral'}>
          {PRIORITY_LABELS[rec.priority]}
        </Badge>
      </div>
      <dl className="mt-2 flex flex-col gap-1 text-sm">
        <dt className="text-ink-faint">What happened</dt>
        <dd><StatementLine statement={rec.issue} evidenceHref={evidenceHref} /></dd>
        <dt className="text-ink-faint">What you can do</dt>
        <dd><StatementLine statement={rec.recommendation} evidenceHref={evidenceHref} /></dd>
      </dl>
      {createAllowed ? (
        <form action={submit} className="mt-3 flex flex-wrap items-center gap-3">
          <input type="hidden" name="org_slug" value={orgSlug} />
          <input type="hidden" name="message_id" value={messageId} />
          <input type="hidden" name="index" value={index} />
          <SubmitButton tone="secondary" pendingLabel="Adding…">Create action</SubmitButton>
          <ActionMessage state={state} />
        </form>
      ) : null}
    </div>
  );
}

/**
 * What the reader thought of the answer (AI_ARCHITECTURE.md §13, CD-25).
 *
 * Three ways to say it, because they cost the reader different amounts and are worth different
 * things. "Helpful" is one click and is not a complaint: §13 turns confirmed reports into eval
 * cases, and an answer somebody vouched for is the other half of that corpus — the regression
 * fixture you want to keep passing. "Not helpful" is also one click, because making somebody write
 * an essay to say "that missed the point" is how you stop hearing it. A wrong figure is the one
 * worth a sentence, so only that path opens a form.
 */
function FeedbackControls({ orgSlug, messageId }: { orgSlug: string; messageId: string }) {
  const [state, submit] = useActionState(reportAnswerAction, null);
  const [reporting, setReporting] = useState(false);

  if (state?.ok) return <ActionMessage state={state} />;

  if (reporting) {
    return (
      <form action={submit} className="flex w-full flex-col gap-2 rounded-md border border-line p-3">
        <input type="hidden" name="org_slug" value={orgSlug} />
        <input type="hidden" name="message_id" value={messageId} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">What was wrong?</span>
          <NativeSelect name="type" required defaultValue="incorrect">
            <option value="incorrect">A figure or claim is incorrect</option>
            <option value="unsafe">It said something it should not have</option>
            <option value="unhelpful">It did not answer the question</option>
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">Which figure, and what should it be? (optional)</span>
          <Textarea name="comment" rows={2} maxLength={1000} />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton tone="secondary" pendingLabel="Sending…">Send report</SubmitButton>
          <Button type="button" variant="ghost" onClick={() => setReporting(false)}>Cancel</Button>
          <ActionMessage state={state} />
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-ink-faint">Was this helpful?</span>
      <form action={submit} className="contents">
        <input type="hidden" name="org_slug" value={orgSlug} />
        <input type="hidden" name="message_id" value={messageId} />
        <input type="hidden" name="type" value="helpful" />
        <SubmitButton tone="quiet" pendingLabel="Saving…">Helpful</SubmitButton>
      </form>
      <form action={submit} className="contents">
        <input type="hidden" name="org_slug" value={orgSlug} />
        <input type="hidden" name="message_id" value={messageId} />
        <input type="hidden" name="type" value="unhelpful" />
        <SubmitButton tone="quiet" pendingLabel="Saving…">Not helpful</SubmitButton>
      </form>
      <Button type="button" variant="link" onClick={() => setReporting(true)} className="py-0 text-ink-muted hover:text-ink">
        Report an incorrect figure
      </Button>
    </div>
  );
}

/** §7.2: the fallback, and the figures the reader can still have. */
function Unavailable({ facts, withheld }: { facts: ReactNode; withheld: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <Banner tone="warn" title={withheld ? WITHHELD_TITLE : FALLBACK_TITLE}>
        {withheld
          ? 'It could not show where every figure came from, so it is not shown. Asking again usually works. Your data and dashboard are unaffected.'
          : 'Your data and dashboard are unaffected.'}
      </Banner>
      {facts}
    </div>
  );
}
