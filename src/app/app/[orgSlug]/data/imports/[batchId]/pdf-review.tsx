'use client';

import { useActionState, useEffect, useState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { confirmPdfPageAction, requestAiReadingAction } from '../actions';

/**
 * The PDF side of the review screen (IMPORT_ENGINE.md §5.4; ADR-084).
 *
 * `AiReadingRequest` is the consent line and the one button that creates a `document.extract` job.
 * `DocumentPageView` shows the statement itself, page by page, beside the rows the model read —
 * the browser renders the PDF from a short-lived signed URL; MOTION never rasterises it.
 * `PageConfirmation` is "I have compared all rows on page N".
 */

export const CONSENT_LINE =
  'MOTION will send the text of this document to its AI provider to read the rows. The file itself is not sent.';

export function AiReadingRequest({ orgSlug, batchId, documentId }: { orgSlug: string; batchId: string; documentId: string }) {
  const [state, submit] = useActionState(requestAiReadingAction, null);
  if (state?.ok) return <ActionMessage state={state} />;
  return (
    <form action={submit} className="flex flex-col gap-3 text-sm">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="batch_id" value={batchId} />
      <input type="hidden" name="document_id" value={documentId} />
      <p className="text-ink">{CONSENT_LINE}</p>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="consent" value="yes" required />
        <span>I understand.</span>
      </label>
      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Asking…">Read with AI</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}

export function DocumentPageView({ orgSlug, documentId, page, filename }: { orgSlug: string; documentId: string; page: number; filename: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/documents/${documentId}/url?org=${encodeURIComponent(orgSlug)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? 'The document could not be opened.');
        return (await response.json()) as { url: string };
      })
      .then((signed) => { if (!cancelled) setUrl(signed.url); })
      .catch((error: Error) => { if (!cancelled) setFailed(error.message); });
    return () => { cancelled = true; };
  }, [documentId, orgSlug]);
  if (failed) return <p className="text-sm text-ink-muted">{failed}</p>;
  if (!url) return <p className="text-sm text-ink-muted">Opening {filename}…</p>;
  return (
    <object data={`${url}#page=${page}&toolbar=0`} type="application/pdf" className="h-[520px] w-full rounded-md border border-line" aria-label={`${filename}, page ${page}`}>
      <p className="p-3 text-sm text-ink-muted">
        Your browser cannot show the PDF here. <a className="underline" href={url} target="_blank" rel="noreferrer">Open page {page} in a new tab</a>.
      </p>
    </object>
  );
}

export function PageConfirmation({ orgSlug, batchId, page, pageWide, confirmed }: { orgSlug: string; batchId: string; page: number; pageWide: boolean; confirmed: boolean }) {
  const [state, submit] = useActionState(confirmPdfPageAction, null);
  if (confirmed) return <p className="text-sm text-accent">Page {page} confirmed.</p>;
  return (
    <form action={submit} className="flex flex-wrap items-center gap-3 text-sm">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="batch_id" value={batchId} />
      <input type="hidden" name="page" value={page} />
      <span className="text-ink-muted">
        {pageWide
          ? 'The AI read this page with high confidence and the line count agrees.'
          : 'This page needs each row decided before it can be confirmed as a whole.'}
      </span>
      <SubmitButton tone="secondary" pendingLabel="Saving…">I have compared all rows on page {page}</SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}
