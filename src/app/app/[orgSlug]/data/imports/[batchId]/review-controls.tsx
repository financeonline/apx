'use client';

import { useActionState } from 'react';
import { Input } from '@/components/ui/field';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import {
  commitBatchAction, confirmBatchAction, decideRowsAction, rejectBatchAction,
} from '../actions';

/**
 * The decisions a reviewer makes (IMPORT_ENGINE.md §8, §9).
 *
 * Every one of them is explicit. A duplicate is never resolved by the system choosing: the reviewer
 * says keep or skip, and the reason is recorded with the row, because six months later "why is this
 * payment in twice" has to be answerable (§9.2).
 */

export function DuplicateDecisions({
  orgSlug, batchId, rows,
}: {
  orgSlug: string;
  batchId: string;
  rows: ReadonlyArray<{ id: string; rowNumber: number; summary: string; decided: string | null }>;
}) {
  const [state, action] = useActionState(decideRowsAction, null);
  const undecided = rows.filter((row) => row.decided === null);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="batch_id" value={batchId} />

      <ul className="divide-y divide-line/60 rounded-card border border-line">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start gap-3 px-3 py-2 text-sm">
            <input
              type="checkbox"
              name="row_id"
              value={row.id}
              id={`row-${row.id}`}
              defaultChecked={row.decided === null}
              className="mt-1"
            />
            <label htmlFor={`row-${row.id}`} className="min-w-0 flex-1">
              <span className="tabular text-ink-faint">Row {row.rowNumber}</span>{' '}
              <span className="text-ink">{row.summary}</span>
              {row.decided === null ? null : (
                <span className="ml-2 text-xs text-ink-muted">
                  {row.decided === 'keep' ? 'will be imported' : 'will be skipped'}
                </span>
              )}
            </label>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          name="reason"
          placeholder="Why? (optional, but it helps in six months)"
          className="max-w-sm"
        />
        <button
          type="submit"
          name="decision"
          value="keep"
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:border-line-strong"
        >
          These are genuine — import them
        </button>
        <button
          type="submit"
          name="decision"
          value="skip"
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:border-line-strong"
        >
          These are duplicates — skip them
        </button>
      </div>

      {undecided.length > 0 ? (
        <p className="text-sm text-warn">
          {undecided.length} still need a decision before this file can be imported.
        </p>
      ) : null}

      <ActionMessage state={state} />
    </form>
  );
}

export function ConfirmationPrompt({
  orgSlug, batchId, code, question, values, choice,
}: {
  orgSlug: string;
  batchId: string;
  code: string;
  question: string;
  /** Fields the confirmation SETS rather than acknowledges — the export range, for instance. */
  values?: Readonly<Record<string, string>>;
  /** A confirmation the reviewer must answer rather than agree to. */
  choice?: { name: string; label: string; options: ReadonlyArray<{ value: string; label: string }>; explicit?: boolean };
}) {
  const [state, action] = useActionState(confirmBatchAction, null);

  return (
    <form action={action} className="flex flex-wrap items-center gap-3 text-sm">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="batch_id" value={batchId} />
      <input type="hidden" name="code" value={code} />
      {Object.entries(values ?? {}).map(([key, value]) => (
        <input key={key} type="hidden" name={`value_${key}`} value={value} />
      ))}

      <span className="text-ink">{question}</span>

      {choice ? (
        <label className="flex items-center gap-2">
          <span className="sr-only">{choice.label}</span>
          <select
            name={`value_${choice.name}`}
            className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
            required={choice.explicit === true}
            defaultValue={choice.explicit === true ? '' : undefined}
          >
            {choice.explicit === true ? <option value="" disabled>Choose an answer</option> : null}
            {choice.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      ) : null}

      <SubmitButton pendingLabel="Saving…">
        {choice ? 'Save this answer' : 'Yes, that is right'}
      </SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}

export function CommitControls({
  orgSlug, batchId, committable, blockingReason, validRows,
}: {
  orgSlug: string;
  batchId: string;
  committable: boolean;
  blockingReason: string | null;
  validRows: number;
}) {
  const [commitState, commit] = useActionState(commitBatchAction, null);
  const [rejectState, reject] = useActionState(rejectBatchAction, null);

  return (
    <div className="space-y-3">
      {committable ? (
        <form action={commit} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="org_slug" value={orgSlug} />
          <input type="hidden" name="batch_id" value={batchId} />
          <SubmitButton pendingLabel="Importing…">
            Import {validRows} row{validRows === 1 ? '' : 's'}
          </SubmitButton>
          <span className="text-sm text-ink-muted">
            Your figures will be recalculated straight after.
          </span>
        </form>
      ) : (
        // The button is ABSENT, with the reason beside it. A disabled Commit invites a reader to
        // hunt for what they did wrong; the sentence tells them (§8.2).
        <p className="text-sm text-warn">{blockingReason}</p>
      )}
      <ActionMessage state={commitState} />

      <form action={reject} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="org_slug" value={orgSlug} />
        <input type="hidden" name="batch_id" value={batchId} />
        <Input name="reason" placeholder="Why are you discarding this?" className="max-w-sm" required />
        <button
          type="submit"
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-muted hover:border-line-strong hover:text-ink"
        >
          Discard this file
        </button>
      </form>
      <ActionMessage state={rejectState} />
    </div>
  );
}

/**
 * Skipping the rows that cannot import (§8.2).
 *
 * The gate refuses to commit while any unreadable row is undecided, and rightly: a row MOTION could
 * not read is still a line of somebody's file. This is how a reviewer says "I have seen those and
 * they are not transactions" — the header row, a totals line, a page footer — in one action rather
 * than one per row.
 */
export function SkipUnreadableRows({
  orgSlug, batchId, rows,
}: {
  orgSlug: string;
  batchId: string;
  rows: ReadonlyArray<{ id: string; rowNumber: number; summary: string }>;
}) {
  const [state, action] = useActionState(decideRowsAction, null);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="batch_id" value={batchId} />
      <input type="hidden" name="decision" value="skip" />
      {rows.map((row) => <input key={row.id} type="hidden" name="row_id" value={row.id} />)}

      <ul className="space-y-1 text-sm text-ink-muted">
        {rows.slice(0, 5).map((row) => (
          <li key={row.id}>
            <span className="tabular text-ink-faint">Row {row.rowNumber}</span> {row.summary}
          </li>
        ))}
        {rows.length > 5 ? <li>and {rows.length - 5} more</li> : null}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          name="reason"
          defaultValue="Not a transaction"
          placeholder="Why are these being skipped?"
          className="max-w-sm"
        />
        <SubmitButton pendingLabel="Saving…">
          Skip {rows.length} row{rows.length === 1 ? '' : 's'}
        </SubmitButton>
      </div>

      <ActionMessage state={state} />
    </form>
  );
}
