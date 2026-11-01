import 'server-only';
import { NotFound } from '@/core/errors';
import { can } from '@/core/permissions';
import { listBatches, listDocuments, type ImportBatch } from '@/modules/imports';
import type { AccessContext } from '@/modules/tenancy';
import {
  CAPTURE_SOURCE_LABELS, captureSource, countBaseline, countByMonth, countChart, countSpark, dayLabel,
  departmentHeading, formatCount, groupCounts, monthEndOf, monthKey, plural, rate, rateLabel, shareSlices,
} from '../../domain/dashboard-ops';
import {
  DEPARTMENT_META, type DepartmentView, type MonthWindow, type PriorityItem,
} from '../../domain/dashboard';
import { engagementItemsFor, reviewRequestTitle, titleSet } from './review-requests';

/**
 * Data Capture (the prototype's `capture` department): the company's own uploads. "Documents" are
 * import batches — one per file put through the import wizard (`import_batches`); received = started
 * in the month, processed = imported into the figures (`committed_at`).
 *
 * Reads: the batches (one query, newest first), the source documents (one query, for file names)
 * and, for the review-request flags, the engagement items. All three are filtered here, in memory.
 */

/** Batches still on their way into the figures: the queue. */
const IN_QUEUE: ReadonlySet<string> = new Set(['created', 'parsing', 'mapping', 'validating', 'awaiting_review']);
/** How many batches are read: comfortably more than eighteen months of a company's uploads. */
const BATCH_LIMIT = 500;
const DOCUMENT_LIMIT = 500;

const TYPE_LABELS: Readonly<Record<string, string>> = {
  bank_statement: 'Bank statement', general_ledger: 'General ledger', trial_balance: 'Trial balance',
  pnl_report: 'Profit and loss', balance_sheet: 'Balance sheet', sales_invoices: 'Sales invoices',
  purchase_invoices: 'Purchase invoices', sales_report: 'Sales report', purchase_report: 'Purchase report',
  receipts: 'Receipts', budget: 'Budget',
};
const typeLabel = (type: string) => TYPE_LABELS[type] ?? type.replace(/_/g, ' ');

const FOOTNOTE = 'Select an item to see the context and request a review from your analyst.';

function count(batch: ImportBatch, key: string): number {
  const n = batch.rowCounts[key];
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export async function loadCaptureView(ctx: AccessContext, window: MonthWindow): Promise<DepartmentView> {
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();
  const heading = departmentHeading('capture', window);
  const base = `/app/${ctx.orgSlug ?? ''}`;

  // `import_batches` is read under `imports.review` (src/db/rls.ts); anyone else would see an empty
  // department that looks like a company with no uploads, so they are told instead.
  if (!can(ctx, 'imports.review')) {
    return emptyCapture(heading, window, 'Data capture is shown to the people who review your imports.');
  }

  const [batches, documents, engagement] = await Promise.all([
    listBatches(ctx.db, orgId, { limit: BATCH_LIMIT, offset: 0 }, ctx.requestId),
    listDocuments(ctx.db, orgId, { limit: DOCUMENT_LIMIT, offset: 0 }, ctx.requestId),
    engagementItemsFor(ctx),
  ]);
  const requestedTitles = titleSet(engagement);
  const filenames = new Map(documents.map((d) => [d.id, d.originalFilename]));
  const nameOf = (b: ImportBatch) => filenames.get(b.sourceDocumentId) ?? typeLabel(b.importType);

  const keys = window.months.map((m) => m.periodStart.slice(0, 7));
  const inWindow = (date: string | null | undefined) => {
    const key = monthKey(date);
    return key !== null && keys.includes(key);
  };
  const created = batches.map((b) => b.createdAt ?? null);
  const received = countByMonth(created, keys);
  const processed = countByMonth(batches.map((b) => b.committedAt), keys);
  const baseline = countBaseline(created, window);

  const windowBatches = batches.filter((b) => inWindow(b.createdAt));
  const receivedTotal = windowBatches.length;
  // Of the files received in the window, how many are now in the figures (a cohort, so ≤ 100%).
  const processedTotal = windowBatches.filter((b) => b.committedAt !== null).length;
  const processingRate = rate(processedTotal, receivedTotal);
  const queue = batches.filter((b) => IN_QUEUE.has(b.status));
  const pending = queue.length;
  const pendingByMonth = countByMonth(queue.map((b) => b.createdAt ?? null), keys);

  // ---- Priorities: real checks only ----
  const items: PriorityItem[] = [];
  const item = (b: ImportBatch, fields: Omit<PriorityItem, 'id' | 'kind' | 'recordId' | 'href' | 'requested'>): PriorityItem => ({
    id: `batch:${b.id}`, kind: 'batch', recordId: b.id, href: `${base}/data/imports/${b.id}`,
    requested: requestedTitles.has(reviewRequestTitle(fields.title)), ...fields,
  });

  for (const b of batches.filter((x) => x.status === 'awaiting_review')) {
    const errors = count(b, 'error'), warnings = count(b, 'warning'), duplicates = count(b, 'duplicate');
    const flagged = errors + warnings + duplicates;
    const total = count(b, 'total');
    items.push(item(b, {
      title: `Review ${nameOf(b)}`,
      subtitle: `Data quality · ${plural(flagged, 'flagged row')}`,
      tag: 'Action', icon: 'capture',
      context: `${typeLabel(b.importType)} received ${dayLabel(b.createdAt)}${total > 0 ? `: ${plural(total, 'row')} read` : ''}`
        + (flagged > 0 ? `, ${formatCount(errors)} with errors, ${formatCount(warnings)} with warnings and ${formatCount(duplicates)} possible duplicates.` : ', none flagged.')
        + ' It is not in your figures until it is reviewed.',
      nextStep: 'Open the import, check the flagged rows, then import it or discard it.',
      reviewed: false,
    }));
  }

  const windowStart = window.months[0]?.periodStart ?? '';
  for (const b of batches.filter((x) => x.status === 'failed' && (x.createdAt ?? '') >= windowStart)) {
    items.push(item(b, {
      title: `Investigate ${nameOf(b)}`,
      subtitle: `Data capture · Could not be read ${dayLabel(b.createdAt)}`,
      tag: 'Investigate', icon: 'search',
      context: b.errorSummary?.message ?? 'APX could not read this file, so none of its rows reached your figures.',
      nextStep: 'Open the import to see what went wrong, then upload the file again or a clearer copy.',
      reviewed: false,
    }));
  }

  // A company that imports bank statements, with no committed statement covering the latest month.
  const latest = window.months.at(-1);
  const bank = batches.filter((b) => b.importType === 'bank_statement');
  if (latest !== undefined && bank.length > 0) {
    const start = latest.periodStart, end = monthEndOf(latest.periodStart);
    const committed = bank.filter((b) => b.status === 'committed');
    const covered = committed.some((b) => b.periodStart <= end && b.periodEnd >= start);
    if (!covered) {
      const reach = committed.map((b) => b.periodEnd).sort().at(-1) ?? null;
      const title = 'Confirm bank feed completeness';
      items.push({
        id: `batch:bank-feed-${start.slice(0, 7)}`, kind: 'batch', recordId: `bank-feed-${start.slice(0, 7)}`,
        title, subtitle: `Data readiness · ${latest.longLabel} close`, tag: 'Review', icon: 'link',
        context: `No imported bank statement covers ${latest.longLabel}.`
          + (reach === null ? ' No bank statement has been imported into the figures yet.' : ` The latest imported statement runs to ${dayLabel(reach)}.`),
        nextStep: 'Import the statement for the month, reconcile the opening and closing balances and confirm no dates are missing.',
        href: `${base}/data/imports/new`, reviewed: false, requested: requestedTitles.has(reviewRequestTitle(title)),
      });
    }
  }

  // The "Reviewed" filter: the latest files imported into the figures.
  const recent = batches
    .filter((b) => b.status === 'committed' && b.committedAt !== null)
    .sort((a, b) => (b.committedAt ?? '').localeCompare(a.committedAt ?? ''))
    .slice(0, 3);
  for (const b of recent) {
    const rows = count(b, 'committed') || count(b, 'total');
    items.push(item(b, {
      title: `${nameOf(b)} imported`,
      subtitle: `Data capture · Imported ${dayLabel(b.committedAt)}`,
      tag: 'Imported', icon: 'file',
      context: `${typeLabel(b.importType)} imported ${dayLabel(b.committedAt)}${rows > 0 ? `: ${plural(rows, 'row')} are in your figures` : ''}.`,
      nextStep: 'Nothing is waiting. Open the import to see its rows, or roll it back if it was the wrong file.',
      reviewed: true,
    }));
  }

  const meta = DEPARTMENT_META.capture;
  return {
    ...heading,
    metrics: [
      { label: 'Documents received', value: formatCount(receivedTotal), change: plural(window.months.length, 'month'), note: 'selected period', spark: countSpark(window, received) },
      { label: 'Processing rate', value: rateLabel(processingRate), change: formatCount(processedTotal), note: 'processed', spark: countSpark(window, processed) },
      { label: 'Awaiting processing', value: formatCount(pending), change: formatCount(pending), note: 'documents in queue', spark: countSpark(window, pendingByMonth) },
    ],
    chart: countChart({
      dept: 'capture', window, first: received, second: processed, baseline,
      insight: `${formatCount(pending)} ${pending === 1 ? 'document remains' : 'documents remain'} to be processed.`,
      figure: rateLabel(processingRate),
    }),
    mix: {
      title: meta.mix,
      total: formatCount(receivedTotal),
      caption: 'documents',
      slices: shareSlices(groupCounts(windowBatches, CAPTURE_SOURCE_LABELS, (b) => captureSource(b.importType))),
    },
    queue: { kicker: 'YOUR NEXT MOVES', title: 'Priorities & observations', footnote: FOOTNOTE, reviewedWord: 'Reviewed', items },
    clients: null,
    empty: batches.length === 0 ? 'No documents have been imported yet. Upload a bank statement, ledger or invoice list to start.' : null,
  };
}

function emptyCapture(heading: ReturnType<typeof departmentHeading>, window: MonthWindow, empty: string): DepartmentView {
  const zeros = window.months.map(() => 0);
  return {
    ...heading,
    metrics: [
      { label: 'Documents received', value: '0', change: plural(window.months.length, 'month'), note: 'selected period', spark: countSpark(window, zeros) },
      { label: 'Processing rate', value: '—', change: '0', note: 'processed', spark: countSpark(window, zeros) },
      { label: 'Awaiting processing', value: '0', change: '0', note: 'documents in queue', spark: countSpark(window, zeros) },
    ],
    chart: countChart({ dept: 'capture', window, first: zeros, second: zeros, baseline: null, insight: '0 documents remain to be processed.', figure: '—' }),
    mix: { title: DEPARTMENT_META.capture.mix, total: '0', caption: 'documents', slices: [] },
    queue: { kicker: 'YOUR NEXT MOVES', title: 'Priorities & observations', footnote: FOOTNOTE, reviewedWord: 'Reviewed', items: [] },
    clients: null,
    empty,
  };
}
