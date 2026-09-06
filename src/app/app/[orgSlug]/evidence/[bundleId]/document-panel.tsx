'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/surfaces';

/**
 * Level 4 (EVIDENCE_MODEL.md §6): the source document behind one row.
 *
 * The URL is fetched when the button is pressed, never when the page renders. A signed URL lives 60
 * seconds (ADR-043.5) — one minted at render would be dead by the time a reader had worked down
 * through the records — and every mint writes a `document.downloaded` audit row, so minting on
 * render would record a download nobody performed. The audit is meant to answer "who opened this
 * file", and a log full of page loads cannot.
 */
export function DocumentPanel({
  orgSlug,
  documentId,
  filename,
  where,
  locked,
}: {
  orgSlug: string;
  documentId: string | null;
  filename: string | null;
  /** "page 3, line 12" — where in the file the row was read from. */
  where: string | null;
  locked: boolean;
}) {
  const [state, setState] = useState<'idle' | 'opening' | 'failed'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  if (locked || documentId === null) {
    return (
      <div className="rounded-md border border-line bg-surface-sunken p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">Locked</Badge>
          <p className="text-sm text-ink">Source documents are available to owners and admins.</p>
        </div>
        {where ? (
          <p className="mt-2 text-sm text-ink-muted">
            This figure was read from {where}. An admin can send you the file.
          </p>
        ) : null}
      </div>
    );
  }

  async function open() {
    setState('opening');
    setMessage(null);
    try {
      const response = await fetch(
        `/api/documents/${documentId}/url?org=${encodeURIComponent(orgSlug)}`,
        { cache: 'no-store' },
      );
      const body = await response.json() as { url?: string; error?: { message?: string } };
      if (!response.ok || !body.url) {
        // Said, never swallowed: a button that silently does nothing is worse than a refusal.
        setState('failed');
        setMessage(body.error?.message ?? 'That file could not be opened just now.');
        return;
      }
      window.open(body.url, '_blank', 'noopener,noreferrer');
      setState('idle');
    } catch {
      setState('failed');
      setMessage('That file could not be opened just now.');
    }
  }

  return (
    <div className="rounded-md border border-line bg-surface-sunken p-4">
      <p className="text-sm text-ink">
        {filename ?? 'Source document'}
        {where ? <span className="text-ink-muted"> — {where}</span> : null}
      </p>
      <Button
        tone="secondary"
        type="button"
        onClick={open}
        disabled={state === 'opening'}
        className="mt-3"
      >
        {state === 'opening' ? 'Opening…' : 'Open the source file'}
      </Button>
      <p className="mt-2 text-xs text-ink-faint">
        The link lasts one minute, and opening it is recorded in your audit log.
      </p>
      {message === null ? null : (
        <p className="mt-2 text-sm text-danger" role="status">{message}</p>
      )}
    </div>
  );
}
