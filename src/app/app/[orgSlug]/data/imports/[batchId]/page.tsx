import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ClipboardCheck, Copy, FileSearch, FileText, FileUp, ListChecks, Scale, ScanText, Sparkles, Table as TableIcon, TriangleAlert,
} from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { loadBatchReview, loadReportCompleteness, type BatchIssueGroup } from '@/modules/imports';
import { PageHeader, Card, CardBody, Badge, Banner, IconBadge } from '@/components/ui/surfaces';
import { THead, TBody, TR, TD } from '@/components/ui/table';
import { Table } from '@/components/ui/shadcn';
import {
  CommitControls, CompletenessAttestationForm, ConfirmationPrompt, DuplicateDecisions, SkipUnreadableRows,
} from './review-controls';
import { AiReadingRequest, DocumentPageView, PageConfirmation, ReceiptReadingRequest, StatementBalancesForm } from './pdf-review';
import { requirePermission } from '@/app/_lib/authz';
import { can } from '@/core/permissions';
import { rowsNotShownSentence, rowsReadable } from './rows-view';
import { formatCoverage } from '../labels';
import { formatDateTime } from '@/components/labels';

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
 * confirmation of anything — so the range question prints the range (`questionFor`).
 */
const CONFIRMATION_QUESTIONS: Readonly<Record<string, string>> = {
  'IMP-RANGE-015': 'This file covers the whole period you entered, even though its rows stop earlier.',
  'IMP-TB-012': 'Are these year-to-date totals, or just this period’s amounts?',
  'IMP-TB-013': 'How does this file show income and costs?',
  'IMP-COV-013': 'This file replaces the report already imported for the same month. The earlier report is kept in its history but no longer counted.',
  'IMP-INV-013': 'Does this list include every invoice that was still unpaid on its start date — including invoices issued before it?',
  'IMP-INV-012': 'This list is every open invoice, not only the ones raised in the period.',
  'IMP-ROW-005': 'We took the row we found as the column headings.',
  'IMP-DATE-003': 'Dates in this file are day-first (25/12 is December).',
};

/**
 * Step 0F: what IMP-TB-016 asks depends on what the report is for. A trial balance lists EVERY
 * account — income, expenses, assets, liabilities, equity; a P&L report only income and expenses, so
 * asking it about "every account" would ask about lines it never contains. Neither is expected to
 * list accounts with no balance: an account left out of a complete report is the zero. The stored
 * scope (`all_accounts` | `income_and_expense`) is set by the server from the import type.
 */
const COMPLETENESS: Readonly<Record<'trial_balance' | 'pnl_report' | 'balance_sheet', { question: string; help: string; complete: string; partial: string }>> = {
  // Owner decision (2026-10-06): balance sheets are asked too — a missing receivables line is not 0.00.
  balance_sheet: {
    question: 'Is this the full balance sheet — every asset, liability and equity account with a balance at the period end?',
    help: 'Answer yes only for the complete balance sheet from your accounting system (accounts with nothing in them may be left out). We will count a missing line — money owed to you or by you, say — as zero. If this file is an extract, answer no: a missing line will show as unknown, never as zero.',
    complete: 'Yes — the full balance sheet (accounts left out had nothing in them)',
    partial: 'No — an extract: some accounts or sections are missing',
  },
  trial_balance: {
    question: 'Is this the full trial balance — every account with a balance for the period: income, expenses, assets, liabilities and equity?',
    help: 'Answer yes only for the complete trial balance from your accounting system. Accounts with nothing in them may be left out: we will count any category with no line as zero, so a trial balance must also balance. If this file is an extract — some accounts or sections removed — answer no: categories it has no line for will show as unknown, never as zero.',
    complete: 'Yes — the full trial balance (accounts left out had nothing in them)',
    partial: 'No — an extract: some accounts or sections are missing',
  },
  pnl_report: {
    question: 'Is this the full profit and loss report — every income and cost line for the period?',
    help: 'Answer yes only if no income or cost line was removed (lines with nothing in them may be left out). We will count any income or cost category with no line as zero — so if your report groups several kinds of cost into one line (for example wages and marketing inside "Overheads"), answer no. If this is only part of the report — for example costs only — answer no too: categories with no line will show as unknown, never as zero.',
    complete: 'Yes — the full report, every kind of cost on its own line (lines left out had nothing in them)',
    partial: 'No — only part of the report',
  },
};

function completenessKind(importType: string): 'trial_balance' | 'pnl_report' | 'balance_sheet' {
  return importType === 'pnl_report' ? 'pnl_report' : importType === 'balance_sheet' ? 'balance_sheet' : 'trial_balance';
}

function questionFor(code: string, importType: string, period: { start: string | null; end: string | null }): string {
  if (code === 'IMP-TB-016') return COMPLETENESS[completenessKind(importType)].question;
  if (code === 'IMP-RANGE-015' && period.start && period.end) {
    return `This file covers the whole period you entered — ${formatCoverage(period.start, period.end)} — even though its rows stop earlier.`;
  }
  // The rule code stays out of the sentence; it is kept on the form (`code`) for support.
  return CONFIRMATION_QUESTIONS[code]
    ?? 'Please confirm this file is what you expected before it is imported.';
}

function choiceFor(code: string, importType: string): (typeof CHOICES)[string] | undefined {
  if (code !== 'IMP-TB-016') return CHOICES[code];
  const c = COMPLETENESS[completenessKind(importType)];
  return { ...CHOICES[code]!, options: [{ value: 'complete', label: c.complete }, { value: 'partial', label: c.partial }] };
}

const CHOICES: Readonly<Record<string, {
  name: string; label: string; options: ReadonlyArray<{ value: string; label: string }>; explicit?: boolean;
}>> = {
  'IMP-TB-012': {
    name: 'balance_basis',
    label: 'Balance basis',
    options: [
      { value: 'cumulative', label: 'Year-to-date totals' },
      { value: 'movement', label: 'This period only' },
    ],
  },
  'IMP-TB-016': {
    name: 'report_complete',
    label: 'Report completeness',
    // N-1: nothing is pre-selected. "Complete" turns every missing line into a zero, so it has to be
    // the reviewer's answer, never the form's default. The wording is per report type (`choiceFor`).
    explicit: true,
    options: [
      { value: 'complete', label: 'Yes — the full report' },
      { value: 'partial', label: 'No — only part of it' },
    ],
  },
  // R-2: nothing pre-selected — "complete" lets the list state what is owed at every month end.
  'IMP-INV-013': {
    name: 'opening',
    label: 'Unpaid invoices included',
    explicit: true,
    options: [
      { value: 'complete', label: 'Yes — every unpaid invoice, however old' },
      { value: 'partial', label: 'No — only invoices issued in this period' },
    ],
  },
  'IMP-TB-013': {
    name: 'balance_sign',
    label: 'How costs are shown',
    options: [
      { value: 'natural', label: 'Income as minus figures, costs as plus (as the accounts store them)' },
      { value: 'reporting', label: 'Income and costs both as plus figures (as a printed report shows them)' },
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
  requirePermission(ctx, 'imports.review');

  const review = await loadBatchReview(ctx.db, ctx.orgId!, batchId, ctx.requestId);
  // Cross-organisation or invented: NOT FOUND, never FORBIDDEN (SECURITY_MODEL.md §14).
  if (review === null) notFound();

  // Step 0F follow-up: owners and admins may record what an imported report covers. Only they hold
  // both permissions below; the database enforces the role itself, this only decides whether to
  // show the form.
  const completeness = review.batch.status === 'committed'
    ? await loadReportCompleteness(ctx.db, ctx.orgId!, batchId)
    : null;
  const canAttest = can(ctx, 'imports.review') && can(ctx, 'settings.manage');

  const total = Object.values(review.counts).reduce((sum, n) => sum + n, 0);

  // §5.4: "Read with AI" exists only for a text-layer PDF the deterministic parser could not read,
  // in an organisation that has enabled it. The job re-checks all three when it runs.
  const [{ data: documentRow }, { data: orgRow }] = await Promise.all([
    ctx.db.from('source_documents').select('has_text_layer').eq('organization_id', ctx.orgId!).eq('id', review.batch.sourceDocumentId).maybeSingle(),
    ctx.db.from('organizations').select('features').eq('id', ctx.orgId!).maybeSingle(),
  ]);
  const aiFlag = (orgRow as { features: Record<string, unknown> } | null)?.features?.ai_pdf_extraction === true;
  const isReceipts = review.batch.importType === 'receipts';
  const aiReadingOffered = !isReceipts && review.batch.status === 'failed' && review.batch.extractionMethod === 'pdf_text'
    && (documentRow as { has_text_layer: boolean | null } | null)?.has_text_layer === true && aiFlag;
  // ADR-150: a receipt photo or PDF waits here to be read; the reviewer names the expense account.
  const receiptWaiting = isReceipts && review.batch.status === 'failed' && review.batch.extractionMethod === 'pdf_text';
  const expenseAccounts = receiptWaiting && aiFlag
    ? (((await ctx.db.from('accounts').select('id, code, name').eq('organization_id', ctx.orgId!)
      .eq('account_type', 'expense').eq('is_active', true).order('name')).data ?? []) as Array<{ id: string; code: string | null; name: string }>)
      .map((a) => ({ id: a.id, label: a.code ? `${a.code} · ${a.name}` : a.name }))
    : [];
  const balancesNeeded = review.batch.status === 'awaiting_review' && review.batch.targetTable === 'bank_transactions'
    && (review.batch.extractionMethod === 'pdf_claude' || review.batchIssues.some((i) => i.code === 'IMP-BAL-006' || i.code === 'IMP-BAL-007'));
  /*
   * ADR-172 hardening: the file's own lines (`raw_data`, `mapped_data`) are served only while the
   * batch is in review (`import_rows_review`); afterwards every row comes back empty. Out of review,
   * nothing that would print them is drawn — the page-by-page AI rows, the rows that need a decision
   * and the full list — and one sentence says what became of the rows instead.
   */
  const showsRows = rowsReadable(review.batch.status);
  const rowsGone = rowsNotShownSentence(review.batch.status);
  const aiPages = showsRows && review.batch.extractionMethod === 'pdf_claude'
    ? [...new Set(review.rows.filter((r) => r.sourcePage !== null).map((r) => r.sourcePage!))].sort((a, b) => a - b)
    : [];
  const outstanding = review.requiredConfirmations
    .filter((code) => !review.confirmedCodes.includes(code));

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/app/${orgSlug}/data/imports`} className="inline-flex items-center text-accent underline underline-offset-2 pointer-coarse:min-h-10">
          Back to imports
        </Link>
      </p>

      <PageHeader
        eyebrow="Data"
        title={review.filename ?? 'Review this import'}
        description={`${total} row${total === 1 ? '' : 's'} read · ${afterwards(review.batch.status, review.importableRows)}`}
      />

      <div className="mt-8 flex flex-col gap-6">
        {review.batch.status === 'committed' ? (
          <Banner tone="info" title="This file has already been imported.">
            Its rows are part of your figures. If it was the wrong file, use Remove import on the{' '}
            <Link href={`/app/${orgSlug}/data/imports`} className="underline underline-offset-2">Imports list</Link>.
          </Banner>
        ) : review.batch.status === 'awaiting_review' ? (
          <Banner tone="info" title="Check this file before it counts.">
            Go down the page: answer any questions, decide on any rows we flagged, then press Import at the
            bottom. Nothing is in your figures until you do.
          </Banner>
        ) : null}

        {/*
          * Step 0F follow-up: what an imported trial balance or P&L report covers, per month. An owner
          * or admin can record it after reviewing the stored file — no re-upload — and correct it
          * later; every answer is kept. Completeness is not accuracy: it changes which categories can
          * be zero, never how firm the figures are.
          */}
        {completeness === null ? null : (
          <Card>
            <CardBody className="p-4">
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="violet" size="sm"><ClipboardCheck /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">What this report covers</h2>
              </div>
              <p className="mt-1 text-sm text-ink-muted">
                {completeness.scope === 'open_invoices'
                  ? 'Only a list that includes every invoice still unpaid on its start date — older ones too — can show what you are owed or owe. Otherwise we show it from a balance sheet, or not at all, never a total that misses old debts.'
                  : completeness.scope === 'assets_and_liabilities'
                    ? 'Say whether this is the whole balance sheet or only part of it. If it is whole, anything it does not list — money owed to you, say — counts as zero. If it is only part, anything it does not list shows as “unknown” instead.'
                  : completeness.scope === 'all_accounts'
                    ? 'Say whether this is the whole trial balance or only part of it. If it is whole, any category it does not list counts as zero. If it is only part, those categories show as “unknown” instead.'
                    : 'Say whether this is the whole profit and loss report or only part of it. If it is whole, any income or cost category it does not list counts as zero. If it is only part, those categories show as “unknown” instead.'}{' '}
                This is only about what the file includes, not whether its amounts are right.{' '}
                <Link href={`/app/${orgSlug}/data/documents/${review.batch.sourceDocumentId}`} className="text-accent underline underline-offset-2">
                  Open the stored file
                </Link>
                {' '}to check it.
              </p>
              {completeness.cumulative ? (
                <p className="mt-2 text-sm text-ink-muted" data-testid="completeness-cumulative-note">
                  These are year-to-date totals, so we work out each month by taking away the month before.
                  A missing line counts as zero only when the month before is confirmed as whole too.
                </p>
              ) : null}
              <ul className="mt-3 space-y-4">
                {completeness.months.map((m) => {
                  const label = new Date(`${m.month}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                  const invoices = completeness.scope === 'open_invoices';
                  const status = m.current === 'complete' ? (invoices ? 'Includes every unpaid invoice' : 'Full report')
                    : m.current === 'partial' ? (invoices ? 'Only invoices issued in the period' : 'Part of the accounts') : 'Not yet confirmed';
                  return (
                    <li key={m.month} className="border-b border-line pb-3 last:border-0" data-testid={`completeness-${m.month}`}>
                      <p className="text-sm text-ink">
                        <span className="font-medium">{label}</span>: {status}
                        {m.source === 'owner_review' ? ' (confirmed after import)' : m.source === 'import_review' ? ' (answered at import)' : ''}
                        {' · '}{m.lines} {m.lines === 1 ? 'line' : 'lines'}
                      </p>
                      {m.balances === false ? (
                        <p className="text-sm text-warn">These lines do not balance, so this trial balance cannot count as a full one whatever the answer.</p>
                      ) : null}
                      {canAttest ? (
                        <CompletenessAttestationForm
                          orgSlug={orgSlug} batchId={batchId} month={m.month} monthLabel={label}
                          completeLabel={invoices ? 'Every invoice unpaid at the start, however old'
                            : completeness.scope === 'assets_and_liabilities' ? 'The full balance sheet (accounts left out had nothing in them)'
                            : completeness.scope === 'all_accounts' ? 'The full trial balance (accounts left out had nothing in them)' : 'The full profit and loss report (lines left out had nothing in them)'}
                          partialLabel={invoices ? 'Only invoices issued in the period'
                            : completeness.scope === 'all_accounts' || completeness.scope === 'assets_and_liabilities' ? 'An extract — some accounts or sections are missing' : 'Only part of the profit and loss report'}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {completeness.history.length === 0 ? null : (
                <div className="mt-4">
                  <h3 className="text-sm font-medium text-ink">History</h3>
                  <ul className="mt-1 space-y-1 text-sm text-ink-muted" data-testid="completeness-history">
                    {completeness.history.map((h) => (
                      <li key={h.id} className="[overflow-wrap:anywhere]">
                        {formatDateTime(h.attestedAt)} — {h.attestedBy} ({h.attestedRole}) recorded {monthLabel(h.month)} as{' '}
                        {h.coverage === 'complete' ? 'a full report' : 'part of the accounts'}
                        {h.supersedesId ? ', replacing an earlier answer' : ''}: “{h.reason}”
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardBody>
          </Card>
        )}
        {receiptWaiting ? (
          <Banner tone="info" title="These receipts are stored and waiting to be read.">
            {review.batch.errorSummary?.message ?? 'Choose the expense account and ask APX to read them.'}
          </Banner>
        ) : review.batch.status === 'failed' ? (
          <Banner tone="danger" title="APX could not read this file.">
            {review.batch.errorSummary?.message ?? 'Nothing was imported. The file is stored as a source document.'}
          </Banner>
        ) : null}
        {aiReadingOffered ? (
          <Card>
            <CardBody className="p-4">
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="pink" size="sm"><Sparkles /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">Read this statement with AI</h2>
              </div>
              <p className="mt-1 text-sm text-ink-muted">
                APX could not find the table on its own. AI can read the rows for you; every row it reads will
                need your confirmation against the page before it counts.
              </p>
              <div className="mt-3">
                <AiReadingRequest orgSlug={orgSlug} batchId={batchId} documentId={review.batch.sourceDocumentId} />
              </div>
            </CardBody>
          </Card>
        ) : null}
        {receiptWaiting ? (
          <Card>
            <CardBody className="p-4">
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="violet" size="sm"><Sparkles /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">Read these receipts with AI</h2>
              </div>
              {aiFlag ? (
                <>
                  <p className="mt-1 text-sm text-ink-muted">
                    AI reads each receipt&rsquo;s date, who was paid and the total. Every receipt it reads needs your
                    confirmation against the file before it counts, and is marked as read by AI.
                  </p>
                  <div className="mt-3">
                    <ReceiptReadingRequest orgSlug={orgSlug} batchId={batchId} documentId={review.batch.sourceDocumentId} accounts={expenseAccounts} />
                  </div>
                </>
              ) : (
                <p className="mt-1 text-sm text-ink-muted">
                  AI reading of documents is switched off for this organisation. An APX administrator can switch it on; until then, enter the receipts as a CSV.
                </p>
              )}
            </CardBody>
          </Card>
        ) : null}
        {review.batch.extractionMethod === 'pdf_claude' && review.batch.status === 'parsing' ? (
          <Banner tone="info" title="APX is reading this document with AI.">
            {review.batch.extractionStats.pages_extracted?.length ?? 0} of {review.batch.extractionStats.pages_total ?? '?'} pages read so far. Refresh to see progress.
          </Banner>
        ) : null}
        {balancesNeeded ? (
          <Card>
            <CardBody className="p-4">
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="pink" size="sm"><Scale /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">The balances printed on the statement</h2>
              </div>
              <p className="mt-1 text-sm text-ink-muted">
                APX checks that the transactions add up to the difference between them. Type them from the page,
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
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="violet" size="sm"><ScanText /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">Rows read by AI, page by page</h2>
              </div>
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
                    // `grid-cols-1`, not an implicit column: an implicit track grows to the table's
                    // minimum width and would push the card sideways on a phone.
                    <section key={page} className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label={`Page ${page}`}>
                      <DocumentPageView orgSlug={orgSlug} documentId={review.batch.sourceDocumentId} page={page} filename={review.filename ?? 'statement.pdf'} />
                      <div className="flex min-w-0 flex-col gap-3">
                        <h3 className="text-sm font-medium text-ink">Page {page} · {pageRows.length} row{pageRows.length === 1 ? '' : 's'} read</h3>
                        <Table>
                          <THead columns={isReceipts ? ['Receipt', 'Date', 'Who was paid', 'Total'] : ['Line', 'Date', 'Description', 'Amount', 'Balance']} />
                          <TBody>
                            {pageRows.map((row) => (
                              <TR key={row.id}>
                                <TD className="tabular">{(row.sourceRef ?? '').replace(/^page:\d+;line:/, '')}</TD>
                                <TD>{String(row.mappedData?.transaction_date ?? row.mappedData?.entry_date ?? '')}</TD>
                                <TD>{String(row.mappedData?.description ?? '')}</TD>
                                <TD className="tabular">{String(row.mappedData?.amount ?? row.mappedData?.debit ?? '')}</TD>
                                {isReceipts ? null : <TD className="tabular">{String(row.mappedData?.balance_after ?? '')}</TD>}
                              </TR>
                            ))}
                          </TBody>
                        </Table>
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
            Until the transactions add up to those balances, these figures are marked as calculated rather
            than verified.
          </Banner>
        ) : null}

        {review.batchIssues.length > 0 ? (
          <Card>
            <CardBody className="p-4">
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="pink" size="sm"><FileText /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">About this file</h2>
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                {review.batchIssues.map((issue) => (
                  <li key={issue.code} className={`[overflow-wrap:anywhere] ${issue.severity === 'error' ? 'text-danger' : 'text-ink-muted'}`}>
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
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="violet" size="sm"><ListChecks /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">Before we import this</h2>
              </div>
              <p className="mt-1 text-sm text-ink-muted">
                Answer each question below. If something here looks wrong, do not confirm it: discard the file
                (at the bottom of this page) and export it again. A wrong answer changes every figure that uses
                this file.
              </p>
              <div className="mt-3 space-y-3">
                {outstanding.map((code) => (
                  <ConfirmationPrompt
                    key={code}
                    orgSlug={orgSlug}
                    batchId={batchId}
                    code={code}
                    question={questionFor(code, review.batch.importType, { start: review.batch.periodStart, end: review.batch.periodEnd })}
                    help={code === 'IMP-TB-016'
                      ? COMPLETENESS[completenessKind(review.batch.importType)].help
                      : code === 'IMP-INV-013'
                        ? 'An export of "invoices issued in this period" leaves out older invoices still unpaid — usually the most overdue ones. Answer yes only if the list includes every invoice unpaid at its start date, whenever it was issued. If not, answer no: we will show what is owed from a balance sheet if you add one, and never a total that misses old debts. (An aged-debtors or open-items list includes them by definition.)'
                        : undefined}
                    values={code === 'IMP-RANGE-015' && review.batch.periodStart && review.batch.periodEnd
                      ? { period_start: review.batch.periodStart, period_end: review.batch.periodEnd }
                      : undefined}
                    choice={choiceFor(code, review.batch.importType)}
                  />
                ))}
              </div>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardBody className="p-4">
            <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="pink" size="sm"><FileSearch /></IconBadge>
              <h2 className="min-w-0 font-serif text-lg text-ink">What we found</h2>
            </div>
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

        {showsRows && review.undecidedErrors.length > 0 ? (
          <Card>
            <CardBody className="p-4">
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="violet" size="sm"><TriangleAlert /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">
                  Rows we could not read ({review.undecidedErrors.length})
                </h2>
              </div>
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

        {showsRows && review.duplicates.length > 0 ? (
          <Card>
            <CardBody className="p-4">
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="pink" size="sm"><Copy /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">
                  Possible duplicates ({review.duplicates.length})
                </h2>
              </div>
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
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="violet" size="sm"><FileUp /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">Import this file</h2>
              </div>
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

        {rowsGone !== null ? (
          <Card>
            <CardBody className="p-4">
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="pink" size="sm"><TableIcon /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">The rows</h2>
              </div>
              <p className="mt-1 text-sm text-ink-muted" data-testid="rows-not-shown">{rowsGone}</p>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardBody className="p-4">
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="pink" size="sm"><TableIcon /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">Every row we read</h2>
              </div>
              <p className="mt-1 text-sm text-ink-muted">
                Including the ones that will not import. Nothing from your file is thrown away.
              </p>
              <div className="mt-3">
                <Table>
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
                </Table>
                {review.rows.length > 200 ? (
                  <p className="mt-2 text-sm text-ink-faint">
                    Showing the first 200 of {review.rows.length} rows.
                  </p>
                ) : null}
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}

/** What the header says became of the rows, by where the file is in its journey. */
function afterwards(status: string, importable: number): string {
  if (status === 'committed') return 'imported';
  if (status === 'rolled_back') return 'removed from your figures';
  if (status === 'rejected') return 'discarded, nothing imported';
  return `${importable} will be imported`;
}

/** "September 2026" from a month's first day ("2026-09-01"). */
function monthLabel(month: string): string {
  return new Date(`${month.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
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
        <span className={`min-w-0 [overflow-wrap:anywhere] ${group.severity === 'error' ? 'text-danger' : 'text-ink'}`}>
          {group.message}
        </span>
        <span className="tabular text-sm text-ink-muted">
          {group.rowCount} row{group.rowCount === 1 ? '' : 's'}
        </span>
      </div>
      {/* The rule code is for support, so it sits in the tooltip rather than in the sentence. */}
      <p className="mt-0.5 text-xs text-ink-faint [overflow-wrap:anywhere]" title={group.code}>
        {group.examples.length === 1 ? 'Row' : 'Rows'} {group.examples.map((e) => e.rowNumber).join(', ')}
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
