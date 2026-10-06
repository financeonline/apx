'use client';

import { useActionState, useState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { Button } from '@/components/ui/button';
import { requestComposeAction, requestStoredPdfAction } from '../actions';

/**
 * Asking for a report (Phase 17). Producing is queued work: the job composes and stores the report,
 * and the list shows it when it is done. A day or week still in progress is not offered — its
 * live preview is on the report list instead.
 */
export function ComposeForm({
  orgSlug, kind, label, windows,
}: {
  orgSlug: string;
  kind: 'daily_brief' | 'weekly_intelligence' | 'adviser' | 'funding_readiness';
  label: string;
  /** The choosable windows, newest first; absent for the adviser and Funding Readiness reports. */
  windows?: readonly { readonly value: string; readonly label: string }[];
}) {
  const [state, submit] = useActionState(requestComposeAction, null);
  return (
    <form action={submit} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="kind" value={kind} />
      {windows === undefined ? null : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">{kind === 'daily_brief' ? 'Day' : 'Week'}</span>
          <select name="window_start" className="rounded-md border border-line px-2 py-1 text-sm text-ink">
            {windows.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        </label>
      )}
      <SubmitButton tone="secondary">{label}</SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}

/** Producing and opening a stored report's PDF, as the monthly report's control does (ADR-043.5). */
export function StoredPdfControl({
  orgSlug, reportId, fileId, renderedAt, canGenerate,
}: { orgSlug: string; reportId: string; fileId: string | null; renderedAt: string | null; canGenerate: boolean }) {
  const [state, submit] = useActionState(requestStoredPdfAction, null);
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function open() {
    if (fileId === null) return;
    setOpening(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/reports/${fileId}/download?org=${encodeURIComponent(orgSlug)}`, { cache: 'no-store' });
      const body = await response.json() as { url?: string; error?: { message?: string } };
      if (!response.ok || !body.url) {
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
    <div className="flex flex-wrap items-center gap-3 print:hidden">
      {fileId === null ? null : (
        <Button tone="secondary" type="button" onClick={open} disabled={opening}>
          {opening ? 'Opening…' : 'Open the PDF'}
        </Button>
      )}
      {canGenerate ? (
        <form action={submit} className="flex items-center gap-3">
          <input type="hidden" name="org_slug" value={orgSlug} />
          <input type="hidden" name="report_id" value={reportId} />
          <SubmitButton tone={fileId === null ? 'primary' : 'quiet'}>
            {fileId === null ? 'Produce a PDF' : 'Produce it again'}
          </SubmitButton>
        </form>
      ) : null}
      {renderedAt === null ? null : <span className="text-xs text-ink-faint">Last produced {renderedAt.slice(0, 10)}</span>}
      <ActionMessage state={state} />
      {message === null ? null : <p className="text-sm text-danger" role="status">{message}</p>}
    </div>
  );
}
