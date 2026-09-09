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
import { AiReadingRequest, DocumentPageView, PageConfirmation, StatementBalancesForm } from './pdf-review';

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

  // §5.4: "Read with AI" exists only for a text-layer PDF the deterministic parser could not read,
  // in an organisation that has enabled it. The job re-checks all three when it runs.
  const [{ data: documentRow }, { data: orgRow }] = await Promise.all([
    ctx.db.from('source_documents').select('has_text_layer').eq('organization_id', ctx.orgId!).eq('id', review.batch.sourceDocumentId).maybeSingle(),
    ctx.db.from('organizations').select('features').eq('id', ctx.orgId!).maybeSingle(),
  ]);
  const aiReadingOffered = review.batch.status === 'failed' && review.batch.extractionMethod === 'pdf_text'
    && (documentRow as { has_text_layer: boolean | null } | null)?.has_text_layer === true
    && ((orgRow as { features: Record<string, unknown> } | null)?.features?.ai_pdf_extraction === true);
  const balancesNeeded = review.batch.status === 'awaiting_review' && review.batch.targetTable === 'bank_transactions'
    && (review.batch.extractionMethod === 'pdf_claude' || review.batchIssues.some((i) => i.code === 'IMP-BAL-006' || i.code === 'IMP-BAL-007'));
  const aiPages = review.batch.extractionMethod === 'pdf_claude'
    ? [...new Set(review.rows.filter((r) => r.sourcePage !== null).map((r) => r.sourcePage!))].sort((a, b) => a - b)
    : [];
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
        {review.batch.status === 'failed' ? (
          <Banner tone="danger" title="MOTION could not read this file.">
            {review.batch.errorSummary?.message ?? 'Nothing was imported. The file is stored as a source document.'}
          </Banner>
        ) : null}
        {aiReadingOffered ? (
          <Card>
            <CardBody className="p-4">
              <h2 className="font-serif text-lg text-ink">Read this statement with AI</h2>
              <p className="mt-1 text-sm text-ink-muted">
                MOTION could not find the table on its own. AI can read the rows for you; every row it reads will
                need your confirmation against the page before it counts (CD-11).
              </p>
              <div className="mt-3">
                <AiReadingRequest orgSlug={orgSlug} batchId={batchId} documentId={review.batch.sourceDocumentId} />
              </div>
            </CardBody>
          </Card>
        ) : null}
        {review.batch.extractionMethod === 'pdf_claude' && review.batch.status === 'parsing' ? (
          <Banner tone="info" title="MOTION is reading this document with AI.">
            {review.batch.extractionStats.pages_extracted?.length ?? 0} of {review.batch.extractionStats.pages_total ?? '?'} pages read so far. Refresh to see progress.
          </Banner>
        ) : null}
        {balancesNeeded ? (
          <Card>
            <CardBody className="p-4">
              <h2 className="font-serif text-lg text-ink">The balances printed on the statement</h2>
              <p className="mt-1 text-sm text-ink-muted">
                MOTION checks that the transactions add up to the difference between them. Type them from the page,
                not from anywhere else.
              </p>
              <div className="mt-3">
                <StatementBalancesForm orgSlug={orgSlug} batchId={batchId}
                  opening={review.typedBalances.opening} closing={review.typedBalances.closing} comparison={review.balanceComparison} />
              </div>
            </CardBody>
          </Card>
        ) : null}
        {aiPages.length > 0 ? (
          <Card>
            <CardBody className="p-4">
              <h2 className="font-serif text-lg text-ink">Rows read by AI, page by page</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Compare each page&rsquo;s rows with the statement beside them. These rows are marked as read by AI
                and are imported as &ldquo;please check&rdquo; figures until you confirm them.
              </p>
              <div className="mt-4 flex flex-col gap-8">
                {aiPages.map((page) => {
                  const pageRows = review.rows.filter((r) => r.sourcePage === page && r.status !== 'skipped');
                  const lineCountAgrees = pageRows.every((r) => !r.issues.some((i) => i.code === 'IMP-PDF-002'));
                  // §5.4: balances copied from the model withhold the page-wide tick, whatever the confidence.
                  const pageWide = review.batch.extractionStats.confidence?.[String(page)] === 'high' && lineCountAgrees && review.balanceComparison !== 'matches_ai';
                  return (
                    <section key={page} className="grid gap-4 lg:grid-cols-2" aria-label={`Page ${page}`}>
                      <DocumentPageView orgSlug={orgSlug} documentId={review.batch.sourceDocumentId} page={page} filename={review.filename ?? 'statement.pdf'} />
                      <div className="flex flex-col gap-3">
                        <h3 className="text-sm font-medium text-ink">Page {page} · {pageRows.length} row{pageRows.length === 1 ? '' : 's'} read</h3>
                        <TableWrap>
                          <table className="w-full text-sm">
                            <THead columns={['Line', 'Date', 'Description', 'Amount', 'Balance']} />
                            <TBody>
                              {pageRows.map((row) => (
                                <TR key={row.id}>
                                  <TD className="tabular">{(row.sourceRef ?? '').replace(/^page:\d+;line:/, '')}</TD>
                                  <TD>{String(row.mappedData?.transaction_date ?? '')}</TD>
                                  <TD>{String(row.mappedData?.description ?? '')}</TD>
                                  <TD className="tabular">{String(row.mappedData?.amount ?? '')}</TD>
                                  <TD className="tabular">{String(row.mappedData?.balance_after ?? '')}</TD>
                                </TR>
                              ))}
                            </TBody>
                          </table>
                        </TableWrap>
                        {review.batch.status === 'awaiting_review' ? (
                          <PageConfirmation orgSlug={orgSlug} batchId={batchId} page={page} pageWide={pageWide}
                            confirmed={review.batch.pageConfirmations[String(page)] !== undefined} />
                        ) : null}
                      </div>
                    </section>
                  );
                })}
              </div>
            </CardBody>
          </Card>
        ) : null}
        {review.batch.extractionMethod === 'pdf_text' && review.batch.status !== 'failed' ? (
          <Banner tone="info" title="Read from the text of a PDF statement.">
            The rows were read from the statement&rsquo;s own text and checked against its printed balances.
            Until the balances reconcile, these figures are marked as calculated rather than verified.
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
