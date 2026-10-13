'use client';

import { useActionState } from 'react';
import { DocumentViewer } from '@/components/dashboard/document-viewer';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { confirmPdfPageAction, requestAiReadingAction, requestReceiptReadingAction, statementBalancesAction } from '../actions';
import { Input, NativeSelect } from '@/components/ui/shadcn';

/**
 * The PDF side of the review screen (IMPORT_ENGINE.md §5.4; ADR-084).
 *
 * `AiReadingRequest` is the consent line and the one button that creates a `document.extract` job.
 * `DocumentPageView` shows the statement itself, page by page, beside the rows the model read —
 * the browser renders the PDF from a short-lived signed URL; MOTION never rasterises it.
 * `PageConfirmation` is "I have compared all rows on page N".
 */

export const CONSENT_LINE =
  'APX will send the text of this document to its AI provider to read the rows. The file itself is not sent.';

export function AiReadingRequest({ orgSlug, batchId, documentId }: { orgSlug: string; batchId: string; documentId: string }) {
  const [state, submit] = useActionState(requestAiReadingAction, null);
  if (state?.ok) return <ActionMessage state={state} />;
  return (
    <form action={submit} className="flex flex-col gap-3 text-sm">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="batch_id" value={batchId} />
      <input type="hidden" name="document_id" value={documentId} />
      <p className="text-ink">{CONSENT_LINE}</p>
      <label className="flex w-fit items-center gap-2 pointer-coarse:min-h-10">
        <input type="checkbox" name="consent" value="yes" required />
        <span>I understand.</span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Asking…">Read with AI</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}

export const RECEIPT_CONSENT_LINE =
  'APX will send this receipt file — the photo or PDF itself — to its AI provider to read the date, who was paid and the total.';

/** ADR-150: the consent line, the expense account the receipts post to, and the one button. */
export function ReceiptReadingRequest({ orgSlug, batchId, documentId, accounts }: {
  orgSlug: string; batchId: string; documentId: string;
  accounts: readonly { readonly id: string; readonly label: string }[];
}) {
  const [state, submit] = useActionState(requestReceiptReadingAction, null);
  if (state?.ok) return <ActionMessage state={state} />;
  return (
    <form action={submit} className="flex flex-col gap-3 text-sm">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="batch_id" value={batchId} />
      <input type="hidden" name="document_id" value={documentId} />
      <label className="flex flex-col gap-1">
        <span className="text-ink-muted">Expense account these receipts belong to</span>
        <NativeSelect name="account_id" required defaultValue="" className="max-w-md">
          <option value="" disabled>Choose an account…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </NativeSelect>
      </label>
      <p className="text-ink">{RECEIPT_CONSENT_LINE}</p>
      <label className="flex w-fit items-center gap-2 pointer-coarse:min-h-10">
        <input type="checkbox" name="consent" value="yes" required />
        <span>I understand.</span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Asking…">Read receipts with AI</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}

export function DocumentPageView({ orgSlug, documentId, page, filename }: { orgSlug: string; documentId: string; page: number; filename: string }) {
  return <DocumentViewer orgSlug={orgSlug} documentId={documentId} filename={filename} page={page} height={520} />;
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
      <SubmitButton tone="secondary" pendingLabel="Saving…" className="whitespace-normal">I have compared all rows on page {page}</SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}

/** The printed opening and closing balances, typed from the page (§5.3, §5.4). */
export function StatementBalancesForm({ orgSlug, batchId, opening, closing, comparison }: {
  orgSlug: string; batchId: string; opening: string | null; closing: string | null; comparison: 'matches_ai' | 'differs_from_ai' | null;
}) {
  const [state, submit] = useActionState(statementBalancesAction, null);
  return (
    <form action={submit} className="flex flex-col gap-3 text-sm">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="batch_id" value={batchId} />
      {/* Side by side where there is room; stacked on a phone. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:max-w-xl">
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">Opening balance printed on the statement</span>
          <Input name="opening" inputMode="decimal" required defaultValue={opening ?? ''} className="tabular" placeholder="1000.00" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">Closing balance printed on the statement</span>
          <Input name="closing" inputMode="decimal" required defaultValue={closing ?? ''} className="tabular" placeholder="7320.14" />
        </label>
      </div>
      {comparison === 'matches_ai' ? (
        <p className="text-ink-muted">These match the AI&rsquo;s reading of the page, so they cannot vouch for the rows it read.</p>
      ) : comparison === 'differs_from_ai' ? (
        <p className="text-ink-muted">These differ from the AI&rsquo;s reading of the page.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton tone="secondary" pendingLabel="Checking…">Save balances and check</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}
