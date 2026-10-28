'use client';

import { useActionState, useState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { Button } from '@/components/ui/button';
import { requestPdfAction } from './actions';
import { formatDate } from '@/components/labels';

/**
 * Producing and opening the PDF (ADR-024; plan Phase 13 slice 2).
 *
 * Two separate things, deliberately. Producing it is queued work — the job renders and stores the
 * file — and opening it mints a 60-second signed URL at the click, audit-first, for the reason the
 * document route gives (ADR-043.5): a URL minted while the page rendered would be dead before
 * anybody pressed anything, and every mint writes a `report.downloaded` row that would then record
 * a download nobody performed.
 */
export function PdfControl({
  orgSlug,
  periodId,
  reportFileId,
  renderedAt,
}: {
  orgSlug: string;
  periodId: string;
  reportFileId: string | null;
  renderedAt: string | null;
}) {
  const [state, submit] = useActionState(requestPdfAction, null);
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function open() {
    if (reportFileId === null) return;
    setOpening(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/reports/${reportFileId}/download?org=${encodeURIComponent(orgSlug)}`,
        { cache: 'no-store' },
      );
      const body = await response.json() as { url?: string; error?: { message?: string } };
      if (!response.ok || !body.url) {
        // Said, never swallowed: a button that silently does nothing is worse than a refusal.
        setMessage(body.error?.message ?? 'That report could not be opened just now.');
        return;
      }
      window.open(body.url, '_blank', 'noopener,noreferrer');
    } catch {
      setMessage('That report could not be opened just now.');
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {reportFileId === null ? null : (
        <Button tone="secondary" type="button" onClick={open} disabled={opening}>
          {opening ? 'Opening…' : 'Open the PDF'}
        </Button>
      )}

      <form action={submit} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="org_slug" value={orgSlug} />
        <input type="hidden" name="period_id" value={periodId} />
        <SubmitButton tone={reportFileId === null ? 'primary' : 'quiet'}>
          {reportFileId === null ? 'Produce a PDF' : 'Produce a new PDF'}
        </SubmitButton>
      </form>

      {renderedAt === null ? null : (
        <span className="text-xs text-ink-faint">PDF last made {formatDate(renderedAt)}</span>
      )}

      <ActionMessage state={state} />
      {message === null ? null : (
        <p className="text-sm text-danger" role="status">{message}</p>
      )}
    </div>
  );
}
