import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { loadBatchReview, type BatchIssueGroup } from '@/modules/imports';
import { PageHeader, Card, CardBody, Badge, Banner } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import {
  CommitControls, ConfirmationPrompt, DuplicateDecisions, SkipUnreadableRows,
} from './review-controls';

export const dynamic = 'force-dynamic';

/**
 * Review before commit (IMPORT_ENGINE.md §8).
 *
 * The screen exists to answer one question honestly: what is about to go in, and what is not. Rows
 * that will not import are shown WITH THEIR REASONS rather than dropped — silently discarding a
 * record is the one thing this engine must never do (SOW §23) — and the same problem across four
 * hundred rows is one grouped line with a count, not four hundred lines of scrolling.
 */

/**
 * The questions §8.2 makes a reviewer answer, in their own language.
 *
 * Some are acknowledgements; some SET a value the engine will read (ADR-047.6). The ones that set a
 * value carry it, because a confirmation of a range that does not say which range is not a
 * confirmation of anything.
 */
const CONFIRMATION_QUESTIONS: Readonly<Record<string, string>> = {
  'IMP-RANGE-015': 'This file covers the whole period you entered, even where its rows stop earlier.',
  'IMP-TB-012': 'Are these balances year-to-date totals, or just this period’s movements?',
  'IMP-TB-013': 'How are costs shown in this file?',
  'IMP-INV-012': 'This list is every open invoice, not only the ones raised in the period.',
  'IMP-ROW-005': 'We took the row we found as the column headings.',
  'IMP-DATE-003': 'Dates in this file are day-first (25/12 is December).',
};

function questionFor(code: string): string {
  return CONFIRMATION_QUESTIONS[code]
    ?? `Please confirm this file is as expected before importing (${code}).`;
}

const CHOICES: Readonly<Record<string, {
  name: string; label: string; options: ReadonlyArray<{ value: string; label: string }>;
}>> = {
  'IMP-TB-012': {
    name: 'balance_basis',
    label: 'Balance basis',
    options: [
      { value: 'cumulative', label: 'Year-to-date totals' },
      { value: 'movement', label: 'This period only' },
    ],
  },
  'IMP-TB-013': {
    name: 'balance_sign',
    label: 'How costs are shown',
    options: [
      { value: 'natural', label: 'As the accounts hold them (debits positive)' },
      { value: 'reporting', label: 'As a report shows them (costs positive)' },
    ],
  },
};

export default async function ReviewBatchPage({
  params,
}: {
  params: Promise<{ orgSlug: string; batchId: string }>;
}) {
  const { orgSlug, batchId } = await params;
  const ctx = await getAccessContext(orgSlug);
  if (!can(ctx, 'imports.review')) notFound();

  const review = await loadBatchReview(ctx.db, ctx.orgId!, batchId, ctx.requestId);
  // Cross-organisation or invented: NOT FOUND, never FORBIDDEN (SECURITY_MODEL.md §14).
  if (review === null) notFound();

  const total = Object.values(review.counts).reduce((sum, n) => sum + n, 0);
  const outstanding = review.requiredConfirmations
    .filter((code) => !review.confirmedCodes.includes(code));

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/app/${orgSlug}/data/imports`} className="text-accent underline underline-offset-2">
          Back to imports
        </Link>
      </p>

      <PageHeader
        eyebrow="Data"
        title={review.filename ?? 'Review this import'}
        description={`${total} row${total === 1 ? '' : 's'} read · ${review.importableRows} will be imported`}
      />

      <div className="mt-8 flex flex-col gap-6">
        {review.batch.status === 'committed' ? (
          <Banner tone="info" title="This file has already been imported.">
            Its rows are part of your figures. Roll it back from the imports list if it was wrong.
          </Banner>
        ) : null}

        {review.batchIssues.length > 0 ? (
          <Card>
            <CardBody className="p-4">
              <h2 className="font-serif text-lg text-ink">About this file</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {review.batchIssues.map((issue) => (
                  <li key={issue.code} className={issue.severity === 'error' ? 'text-danger' : 'text-ink-muted'}>
                    {issue.message}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}

        {outstanding.length > 0 ? (
          <Card>
            <CardBody className="p-4">
              <h2 className="font-serif text-lg text-ink">Before we import this</h2>
              <p className="mt-1 text-sm text-ink-muted">
                We read the file this way. If any of it is wrong, discard the file and check the
                export rather than confirming — a wrong answer here changes every figure it feeds.
              </p>
              <div className="mt-3 space-y-3">
                {outstanding.map((code) => (
                  <ConfirmationPrompt
                    key={code}
                    orgSlug={orgSlug}
                    batchId={batchId}
                    code={code}
                    question={questionFor(code)}
                    values={code === 'IMP-RANGE-015' && review.batch.periodStart && review.batch.periodEnd
                      ? { period_start: review.batch.periodStart, period_end: review.batch.periodEnd }
                      : undefined}
                    choice={CHOICES[code]}
                  />
                ))}
              </div>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardBody className="p-4">
            <h2 className="font-serif text-lg text-ink">What we found</h2>
            <StatusCounts counts={review.counts} />
            {review.issueGroups.length === 0 ? (
              <p className="mt-3 text-sm text-ink-muted">
                Every row read cleanly. Nothing needs a decision.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {review.issueGroups.map((group) => (
                  <IssueGroupRow key={group.code} group={group} />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {review.undecidedErrors.length > 0 ? (
          <Card>
            <CardBody className="p-4">
              <h2 className="font-serif text-lg text-ink">
                Rows we could not read ({review.undecidedErrors.length})
              </h2>
              <p className="mt-1 text-sm text-ink-muted">
                Usually a heading, a total or a note rather than a transaction. Nothing is imported
                until you have said what these are.
              </p>
              <div className="mt-3">
                <SkipUnreadableRows
                  orgSlug={orgSlug}
                  batchId={batchId}
                  rows={review.undecidedErrors.map((row) => ({
                    id: row.id,
                    rowNumber: row.rowNumber,
                    summary: summarise(row.rawData),
                  }))}
                />
              </div>
            </CardBody>
          </Card>
        ) : null}

        {review.duplicates.length > 0 ? (
          <Card>
            <CardBody className="p-4">
              <h2 className="font-serif text-lg text-ink">
                Possible duplicates ({review.duplicates.length})
              </h2>
              <p className="mt-1 text-sm text-ink-muted">
                These look like data you have already imported. We never decide this for you.
              </p>
              <div className="mt-3">
                <DuplicateDecisions
                  orgSlug={orgSlug}
                  batchId={batchId}
                  rows={review.duplicates.map((row) => ({
                    id: row.id,
                    rowNumber: row.rowNumber,
                    summary: summarise(row.rawData),
                    decided: row.reviewerDecision === 'none' ? null : row.reviewerDecision,
                  }))}
                />
              </div>
            </CardBody>
          </Card>
        ) : null}

        {review.batch.status === 'committed' ? null : (
          <Card>
            <CardBody className="p-4">
              <h2 className="font-serif text-lg text-ink">Import</h2>
              <div className="mt-3">
                <CommitControls
                  orgSlug={orgSlug}
                  batchId={batchId}
                  committable={review.committable}
                  blockingReason={review.blockingReason}
                  validRows={review.importableRows}
                />
              </div>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardBody className="p-4">
            <h2 className="font-serif text-lg text-ink">Every row we read</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Including the ones that will not import. Nothing from your file is thrown away.
            </p>
            <div className="mt-3">
              <TableWrap>
                <table className="w-full text-sm">
                  <caption className="sr-only">Rows read from this file</caption>
                  <THead columns={['Row', 'Status', 'What it says', 'Why it needs a look']} />
                  <TBody>
                    {review.rows.slice(0, 200).map((row) => (
                      <TR key={row.id}>
                        <TD className="tabular">{row.rowNumber}</TD>
                        <TD><StatusBadge status={row.status} /></TD>
                        <TD>{summarise(row.rawData)}</TD>
                        <TD className="text-ink-muted">
                          {row.issues.map((issue) => issue.message).join(' · ') || '—'}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </table>
              </TableWrap>
              {review.rows.length > 200 ? (
                <p className="mt-2 text-sm text-ink-faint">
                  Showing the first 200 of {review.rows.length} rows.
                </p>
              ) : null}
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  valid: 'Ready',
  warning: 'Check',
  error: 'Cannot import',
  duplicate: 'Possible duplicate',
  skipped: 'Skipped',
  committed: 'Imported',
  rejected: 'Not imported',
};

function StatusBadge({ status }: { status: string }) {
  const tone = status === 'error' ? 'danger'
    : status === 'duplicate' || status === 'warning' ? 'warn'
    : status === 'committed' || status === 'valid' ? 'accent' : 'neutral';
  return <Badge tone={tone}>{STATUS_LABELS[status] ?? status}</Badge>;
}

function StatusCounts({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
      {entries.map(([status, n]) => (
        <div key={status} className="flex items-baseline gap-1.5">
          <dt className="text-ink-muted">{STATUS_LABELS[status] ?? status}</dt>
          <dd className="tabular text-ink">{n}</dd>
        </div>
      ))}
    </dl>
  );
}

function IssueGroupRow({ group }: { group: BatchIssueGroup }) {
  return (
    <li className="border-b border-line/60 pb-2 last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={group.severity === 'error' ? 'text-danger' : 'text-ink'}>
          {group.message}
        </span>
        <span className="tabular text-sm text-ink-muted">
          {group.rowCount} row{group.rowCount === 1 ? '' : 's'}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-ink-faint">
        {group.code} · rows {group.examples.map((e) => e.rowNumber).join(', ')}
        {group.rowCount > group.examples.length ? ' and others' : ''}
      </p>
    </li>
  );
}

/** A row in the reviewer's words: the first few non-empty cells of the file, verbatim. */
function summarise(raw: Readonly<Record<string, unknown>>): string {
  return Object.values(raw)
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
    .slice(0, 4)
    .map((v) => String(v))
    .join(' · ') || '(empty row)';
}
