'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { SubmitAnswer, QuotaStatus } from '@/modules/ai';
import { drainSse, quotaNotice, remainingLine, statusLine } from '@/components/dashboard/analyst-presentation';
import { Banner } from '@/components/ui/surfaces';
import { AnswerView, FALLBACK_TITLE } from './answer-view';
import { Button, Textarea } from '@/components/ui/shadcn';

/**
 * The chat shell (UX_ARCHITECTURE.md §5 `AnalystChat`; AI_ARCHITECTURE.md §2 step 13).
 *
 * It sends one question to `POST /api/ai/chat` and reads the stream: `status` events become one
 * plain status line, and the ONE `answer` event becomes a message that `AnswerView` reveals section
 * by section. Nothing is rendered before that event (ADR-032.4). Everything the reader sees about
 * a figure — its badge, its evidence — was decided by the server; this component formats nothing.
 */

export interface MessageView {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string | null;
  readonly structured: SubmitAnswer | null;
  readonly groundingStatus: string | null;
  readonly evidenceBundleId: string | null;
  readonly flagged: boolean;
}

interface ChatAnswer {
  conversationId: string;
  messageId: string;
  evidenceBundleId: string | null;
  groundingStatus: string;
  answer: SubmitAnswer | null;
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'asking'; readonly status: string }
  | { readonly kind: 'refused'; readonly message: string };

export const MAX_QUESTION_CHARS = 2_000;

export function AnalystChat({
  orgSlug,
  conversationId: initialConversationId,
  initialMessages,
  quota,
  facts,
  initialAsk,
  canCreateAction,
  readOnly,
}: {
  orgSlug: string;
  conversationId: string | null;
  initialMessages: readonly MessageView[];
  quota: QuotaStatus;
  /** The §7.2 facts card, rendered by the server; shown when a turn fails. */
  facts: ReactNode;
  initialAsk: string | null;
  canCreateAction: boolean;
  readOnly: boolean;
}) {
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [messages, setMessages] = useState<readonly MessageView[]>(initialMessages);
  const [remaining, setRemaining] = useState(quota.remainingToday);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [question, setQuestion] = useState('');
  const [latestId, setLatestId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const askedInitial = useRef(false);

  const exhausted = quota.monthlyExhausted ? 'monthly' : remaining !== null && remaining <= 0 ? 'daily' : null;
  const notice = quotaNotice(exhausted, quota);
  const busy = phase.kind === 'asking';

  async function ask(text: string): Promise<void> {
    const message = text.trim();
    if (message === '' || busy || readOnly || exhausted) return;

    const pendingId = `pending-${Date.now()}`;
    setMessages((m) => [...m, { id: pendingId, role: 'user', content: message, structured: null, groundingStatus: null, evidenceBundleId: null, flagged: false }]);
    setQuestion('');
    setPhase({ kind: 'asking', status: 'Reading your question…' });

    let response: Response;
    try {
      response = await fetch(`/api/ai/chat?org=${encodeURIComponent(orgSlug)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(conversationId ? { conversationId, message } : { message }),
      });
    } catch {
      setPhase({ kind: 'refused', message: "We couldn't reach the analyst. Check your connection and try again." });
      return;
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string; resetAt?: string } } | null;
      if (response.status === 429) setRemaining(0);
      setPhase({ kind: 'refused', message: body?.error?.message ?? 'The analyst could not take that question.' });
      return;
    }

    // The stream: status lines until the one answer event.
    const reader = response.body?.getReader();
    if (!reader) {
      setPhase({ kind: 'refused', message: 'The analyst answered in a form this page cannot read.' });
      return;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let answered: ChatAnswer | null = null;
    let failedMessage: string | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const drained = drainSse(buffer);
      buffer = drained.rest;
      for (const event of drained.events) {
        if (event.event === 'status') {
          const data = event.data as { label?: string };
          setPhase({ kind: 'asking', status: statusLine(data.label ?? '') });
        } else if (event.event === 'answer') {
          answered = event.data as ChatAnswer;
        } else if (event.event === 'error') {
          failedMessage = (event.data as { message?: string }).message ?? FALLBACK_TITLE;
        }
      }
    }

    if (!answered) {
      setPhase({ kind: 'refused', message: failedMessage ?? FALLBACK_TITLE });
      return;
    }

    if (!conversationId) {
      setConversationId(answered.conversationId);
      // Keep the page and its state; only the address changes, so a refresh lands on the record.
      window.history.replaceState(null, '', `/app/${orgSlug}/analyst/${answered.conversationId}`);
    }
    setRemaining((r) => (r === null ? null : Math.max(r - 1, 0)));
    setLatestId(answered.messageId);
    setMessages((m) => [...m, {
      id: answered!.messageId,
      role: 'assistant',
      content: null,
      structured: answered!.answer,
      groundingStatus: answered!.groundingStatus,
      evidenceBundleId: answered!.evidenceBundleId,
      flagged: false,
    }]);
    setPhase({ kind: 'idle' });
  }

  // A suggestion link (`?ask=`) sends its question once, on arrival.
  useEffect(() => {
    if (initialAsk && !askedInitial.current) {
      askedInitial.current = true;
      void ask(initialAsk);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once, for the arrival question only
  }, [initialAsk]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, phase.kind]);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void ask(question);
  }

  return (
    <section aria-label="Conversation" className="flex flex-col gap-4">
      <ol className="flex flex-col gap-4">
        {messages.map((message) => (
          <li key={message.id}>
            {message.role === 'user' ? (
              <div className="ml-auto max-w-prose rounded-card bg-accent-soft px-4 py-3 text-sm text-ink">
                <span className="sr-only">You asked: </span>
                {message.content}
              </div>
            ) : (
              <AnswerView
                orgSlug={orgSlug}
                message={message}
                facts={facts}
                canCreateAction={canCreateAction}
                animate={message.id === latestId}
              />
            )}
          </li>
        ))}
      </ol>

      {phase.kind === 'asking' ? (
        <p role="status" aria-live="polite" className="text-sm text-ink-muted">{phase.status}</p>
      ) : null}
      {phase.kind === 'refused' ? (
        <Banner tone="warn" title={phase.message} />
      ) : null}

      {readOnly ? null : notice ? (
        <Banner tone="info" title="No more questions for now">{notice}</Banner>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">Ask a question about the numbers</span>
            <Textarea
              name="message"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
              maxLength={MAX_QUESTION_CHARS}
              disabled={busy}
              placeholder="How did we do last month?"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void ask(question);
                }
              }}
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-ink-faint">{remainingLine(remaining)}</span>
            <Button type="submit" disabled={busy || question.trim() === ''}>
              {busy ? 'Asking…' : 'Ask'}
            </Button>
          </div>
        </form>
      )}
      <div ref={endRef} />
    </section>
  );
}
