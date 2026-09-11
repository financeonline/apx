import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isMotionError } from '@/core/errors';
import { formatMoney } from '@/core/money';
import {
  getRecordProvenance, isRecordKind, parseSourceRef, type RecordProvenance,
} from '@/modules/evidence';
import { getAccessContext } from '@/modules/tenancy';
import { Badge, Card, CardBody, CardHeader, PageHeader } from '@/components/ui/surfaces';
import { requirePermission } from '@/app/_lib/authz';
import { DocumentPanel } from '../../../[bundleId]/document-panel';

export const dynamic = 'force-dynamic';

/**
 * "Where did this row come from?" (EVIDENCE_MODEL.md §1, §5.1; ADR-096).
 *
 * The evidence drawer answers that question about a FIGURE. This answers it about a single record,
 * which is the question a reader asks when they are looking at one line of a bank statement or one
 * invoice and want to know whether it is real, whether it still counts, and where it came from.
 *
 * The URL carries a kind — `bank`, `invoice`, `ledger`, `balance` — and never a table name: a URL is
 * something a reader reads and pastes into a ticket (§7 forbids showing database terminology).
 *
 * Nothing here is computed. Every line is a stored column, and where a column is empty the page says
 * so rather than filling the gap: "no file behind this row" is a true answer and a common one.
 */
export default async function RecordProvenancePage({
  params,
}: {
  params: Promise<{ orgSlug: string; kind: string; recordId: string }>;
}) {
  const { orgSlug, kind, recordId } = await params;

  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'financials.view');

  // An unknown kind and an id from another organisation are the same answer: not found (§8.4).
  if (!isRecordKind(kind)) notFound();
  if (!/^[0-9a-f-]{36}$/i.test(recordId)) notFound();

  let record: RecordProvenance;
  try {
    record = await getRecordProvenance(ctx, kind, recordId);
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const where = record.document ? whereInFile(record.document.sourceRef) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={record.kindLabel}
        title={record.description ?? record.kindLabel}
        description={record.periodLabel ? `Recorded in ${record.periodLabel}` : undefined}
      />

      <Card>
        <CardHeader title="This record" />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Field label="What it is" value={record.kindLabel} />
            <Field label="Date" value={record.date ? formatDate(record.date) : '—'} />
            <Field
              label="Amount"
              value={record.amount === null
                ? '—'
                : formatMoney(record.amount, { currency: record.currency ?? 'GBP', showMinorUnits: true })}
            />
            <Field label="Month" value={record.periodLabel ?? '—'} />
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Is it counted?" />
        <CardBody>
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm text-ink">
              {record.standing.countsTowardsFigures ? (
                <><Badge tone="neutral">Counted</Badge> This record is part of the figures for its month.</>
              ) : (
                <><Badge tone="warn">Not counted</Badge> {notCountedReason(record)}</>
              )}
            </p>
            {record.standing.assurance ? (
              <p className="text-sm text-ink-muted">
                How well we know it: <span className="text-ink">{ASSURANCE_WORDS[record.standing.assurance]}</span>
              </p>
            ) : null}
            {record.standing.rejectedReason ? (
              <p className="text-sm text-ink-muted">Reason given: {record.standing.rejectedReason}</p>
            ) : null}
            {record.standing.supersededById ? (
              <p className="text-sm">
                <Link
                  href={`/app/${orgSlug}/evidence/record/${kind}/${record.standing.supersededById}`}
                  className="text-accent underline underline-offset-2"
                >
                  See the record that replaced it
                </Link>
              </p>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="How it got here" />
        <CardBody>
          {record.importedBy === null ? (
            <p className="text-sm text-ink-muted">
              No import produced this record. Rows restored by rolling an import back, rows created by
              merging two customers, and figures entered by hand all reach the ledger without a file
              behind them.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <Field
                  label="Added"
                  value={record.importedBy.committedAt ? formatDate(record.importedBy.committedAt) : 'Not yet committed'}
                />
                <Field
                  label="Covering"
                  value={record.importedBy.periodStart && record.importedBy.periodEnd
                    ? `${formatDate(record.importedBy.periodStart)} to ${formatDate(record.importedBy.periodEnd)}`
                    : '—'}
                />
              </dl>
              <p className="text-sm">
                <Link
                  href={`/app/${orgSlug}/data/imports/${record.importedBy.batchId}`}
                  className="text-accent underline underline-offset-2"
                >
                  See the import this came in with
                </Link>
              </p>
            </div>
          )}
        </CardBody>
      </Card>

      {record.document === null ? (
        <Card>
          <CardHeader title="Source document" />
          <CardBody>
            <p className="text-sm text-ink-muted">There is no source file behind this record.</p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader title="Source document" />
          <CardBody>
            <DocumentPanel
              orgSlug={orgSlug}
              documentId={record.document.documentId}
              filename={record.document.filename}
              where={where}
              locked={record.document.locked}
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="text-sm text-ink">{value}</dd>
    </div>
  );
}

/** The §8.1 words, not the enum. */
const ASSURANCE_WORDS: Readonly<Record<string, string>> = {
  verified: 'Verified — read from a document you provided',
  calculated: 'Calculated — worked out from figures you provided',
  estimated: 'Estimated — worked out where some figures were missing',
  inferred: 'Inferred — read from a document by AI and not yet confirmed',
};

function notCountedReason(record: RecordProvenance): string {
  if (record.standing.superseded) return 'A later record replaced it, so this one is history.';
  if (record.standing.status === 'rejected') return 'It was rejected during review, so it is not in any figure.';
  return 'It has not been accepted into the figures.';
}

/** "page 3, line 12" — the same sentence the drawer's level 4 uses. */
function whereInFile(sourceRef: string | null): string | null {
  const parsed = parseSourceRef(sourceRef);
  const parts: string[] = [];
  if (parsed.page !== null) parts.push(`page ${parsed.page}`);
  if (parsed.sheet !== null) parts.push(`sheet ${parsed.sheet}`);
  if (parsed.row !== null) parts.push(`line ${parsed.row}`);
  return parts.length === 0 ? null : parts.join(', ');
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
