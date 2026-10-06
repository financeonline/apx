import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isMotionError } from '@/core/errors';
import { formatValue, missingReasonText, statusFor, BASIS_TEXT } from '@/modules/dashboard';
import type { AssuranceLevel, DataQuality } from '@/modules/financial-engine';
import {
  DEFAULT_DESCRIPTOR_LIMIT, RECORD_KINDS, getDocumentReference, loadEvidenceDrawer,
  type DocumentReference, type DrawerDifference, type RecordKind,
} from '@/modules/evidence';
import { getAccessContext } from '@/modules/tenancy';
import { StatusBadgeView } from '@/components/dashboard';
import { Badge, Card, CardBody, PageHeader } from '@/components/ui/surfaces';
import { TBody, TD, THead, TR, TableWrap } from '@/components/ui/table';
import { DocumentPanel } from './document-panel';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * How far "Previous rows" steps back.
 *
 * The resolver's own page size decides how far forward a cursor goes; going back the same distance
 * is the only step that lands a reader where they came from.
 */
const PAGE_STEP = DEFAULT_DESCRIPTOR_LIMIT;

/**
 * The Evidence Drawer, as a page (EVIDENCE_MODEL.md §6; ROUTE_ARCHITECTURE.md §122).
 *
 * §6's five levels — Statement, Metric, Calculation, Records, Document — rendered as sections a
 * reader descends. As a PAGE rather than an overlay because the route contract calls it
 * "deep-linkable": a bundle id is the one thing in this product that never changes, so a link to it
 * is still the same evidence in six months, which is the entire point of the model. On a phone
 * §6/§402 makes it a full-screen sheet, which this already is.
 *
 * Nothing here calculates. Every figure is read from the snapshot that was written when the run
 * happened, and every row is re-resolved from the descriptor under the reader's own RLS.
 */
export default async function EvidenceBundlePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; bundleId: string }>;
  searchParams: Promise<{ row?: string; block?: string; from?: string }>;
}) {
  const { orgSlug, bundleId } = await params;
  const { row, block, from } = await searchParams;

  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'financials.view');

  // Cross-organisation or invented: NOT FOUND, never FORBIDDEN (§8.4, isolation case 3).
  /*
   * A cursor names the BLOCK it belongs to. A derived metric has one selection per leaf, and paging
   * one of them must not move the others (§6 level 3).
   */
  const offset = from === undefined ? Number.NaN : Number.parseInt(from, 10);
  const page = block !== undefined && Number.isFinite(offset) && offset >= 0
    ? { itemId: block, cursor: { offset } }
    : undefined;

  /*
   * Only NOT FOUND becomes the not-found page. Every other failure — a throttle, a database error,
   * an evidence item whose hash no longer matches its descriptor — is thrown to the error boundary,
   * where it is logged and seen. `.catch(() => null)` here turned all of them into 404
   * (PRODUCTION_AUDIT.md M2; ADR-070).
   */
  const view = await loadEvidenceDrawer(ctx, bundleId, page).catch((error: unknown) => {
    if (isMotionError(error) && error.code === 'NOT_FOUND') return null;
    throw error;
  });
  if (view === null) notFound();

  const document = await documentFor(ctx, row);
  const metric = view.metric;

  return (
    <>
      <PageHeader
        eyebrow="Evidence"
        title={metric ? metric.label : 'Where this came from'}
      />

      <div className="mt-8 flex flex-col gap-6">
        {/* Level 0 — Statement: the claim, its assurance, and the run it was true as of. */}
        <Card>
          <CardBody>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-serif text-lg text-ink">What this figure rests on</h2>
              {view.bundle.assurance === null ? null : (
                <Badge tone="neutral">{assuranceLabel(view.bundle.assurance)}</Badge>
              )}
            </div>
            <p className="mt-2 text-sm text-ink-muted">
              {view.bundle.asOf === null
                ? 'Worked out from your records.'
                : `Worked out on ${formatInstant(view.bundle.asOf.finishedAt)} by version ${view.bundle.asOf.engineVersion} of the calculation engine. Everything below is what it read at that moment.`}
            </p>
          </CardBody>
        </Card>

        {/* Level 1 — Metric: the figure itself, its month, where it came from, what is missing. */}
        {metric === null ? null : (
          <Card>
            <CardBody>
              <h2 className="font-serif text-lg text-ink">The figure</h2>
              <div className="mt-3 flex flex-wrap items-baseline gap-3">
                <p className="font-serif text-3xl text-ink">
                  {formatValue(
                    { value: metric.value, unit: metric.unit, currency: metric.currency },
                    { showMinorUnits: true },
                  )}
                </p>
                <StatusBadgeView
                  status={statusFor({
                    value: metric.value,
                    assurance: metric.assurance as AssuranceLevel,
                    dataQuality: quality(metric.dataQuality),
                  })}
                />
              </div>
              <p className="mt-1 text-sm text-ink-muted">
                {metric.label}
                {metric.periodLabel ? `, ${metric.periodLabel}` : ''}
                {BASIS_TEXT[metric.basis] ? ` — ${BASIS_TEXT[metric.basis]!.toLowerCase()}` : ''}
              </p>
              {metric.description ? (
                <p className="mt-2 text-sm text-ink-muted">{metric.description}</p>
              ) : null}

              {/* R-3: an estimate whose range is known says so, with the range. */}
              {metric.range === null ? null : (
                <p className="mt-3 rounded-md bg-warn-soft px-3 py-2 text-sm text-ink" data-testid="estimate-range">
                  This is an estimate: {metric.range.undated} {metric.range.undated === 1 ? 'invoice was' : 'invoices were'} paid
                  on a date that was not recorded, so it counts as paid. If {metric.range.undated === 1 ? 'that payment' : 'those payments'} came
                  later, the figure could be anywhere from{' '}
                  {formatValue({ value: metric.range.low, unit: 'money', currency: metric.currency }, { showMinorUnits: true })} to{' '}
                  {formatValue({ value: metric.range.high, unit: 'money', currency: metric.currency }, { showMinorUnits: true })}.
                </p>
              )}

              {/* Step 0E / N-2: a cumulative report's month is a subtraction of two periods' records. */}
              {metric.difference === null ? null : (
                <DifferencePanel difference={metric.difference} currency={metric.currency} />
              )}

              {/* Step 0D: a balance carried through a month that is not verified says which. */}
              {metric.restsOn.length === 0 ? null : (
                <div className="mt-3 rounded-md bg-warn-soft px-3 py-2 text-sm text-ink">
                  <p>This balance is carried through {metric.restsOn.length === 1 ? 'a statement' : 'statements'} not yet confirmed:</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {metric.restsOn.map((statement) => (
                      <li key={statement.batchId} className="[overflow-wrap:anywhere]">
                        {statement.fileName ?? 'A bank statement'}
                        {statement.periodStart && statement.periodEnd ? ` (${statement.periodStart} to ${statement.periodEnd})` : ''}
                        {statement.extractionMethod === 'pdf_claude' ? ' — read by AI' : ' — did not add up to its printed balances'}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1">Check those figures, or replace the statement with your bank&apos;s file, to confirm it.</p>
                </div>
              )}

              {/* §8.2: an old bundle keeps its own numbers, and says so rather than looking wrong. */}
              {metric.isCurrent ? null : (
                <p className="mt-3 rounded-md bg-warn-soft px-3 py-2 text-sm text-ink">
                  This figure has since been recalculated — the current value is{' '}
                  {formatValue(
                    { value: metric.currentValue, unit: metric.unit, currency: metric.currency },
                    { showMinorUnits: true },
                  )}
                  . What you see here is what was shown at the time.
                </p>
              )}

              {warningsOf(metric.dataQuality).length === 0 ? null : (
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-muted">
                  {warningsOf(metric.dataQuality).map((warning) => (
                    <li key={warning}>{missingReasonText([warning])}</li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        )}

        {/* Level 2 — Calculation: the parts this figure was worked out from, each openable. */}
        {view.components.length === 0 ? null : (
          <Card>
            <CardBody>
              <h2 className="font-serif text-lg text-ink">How it was worked out</h2>
              <p className="mt-1 text-sm text-ink-muted">
                {metric?.description ?? 'This figure is worked out from the figures below.'}
              </p>
              <ul className="mt-4 space-y-3">
                {view.components.map((component) => (
                  <li key={component.snapshotId ?? component.name} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-3 last:border-0">
                    <span className="text-sm text-ink">{component.label}</span>
                    <span className="flex items-baseline gap-3">
                      <span className="font-serif text-base text-ink">
                        {formatValue(
                          { value: component.value, unit: component.unit ?? 'money', currency: component.currency },
                          { showMinorUnits: true },
                        )}
                      </span>
                      {component.snapshotId === null ? null : (
                        <Link
                          href={`/app/${orgSlug}/evidence?snapshot=${component.snapshotId}`}
                          className="text-sm text-accent underline underline-offset-2"
                        >
                          Open
                          <span className="sr-only"> the evidence behind {component.label}</span>
                        </Link>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {/*
          * Figures the bundle cites that are not parts of the calculation — an alert's comparison
          * month, say. Under their own heading, because putting them under "how it was worked out"
          * would tell a reader that last month's revenue is part of this month's arithmetic.
          */}
        {view.relatedFigures.length === 0 ? null : (
          <Card>
            <CardBody>
              <h2 className="font-serif text-lg text-ink">The other figures this rests on</h2>
              <ul className="mt-4 space-y-3">
                {view.relatedFigures.map((figure) => (
                  <li key={figure.snapshotId ?? figure.name} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-3 last:border-0">
                    <span className="text-sm text-ink">{figure.label}</span>
                    <span className="flex items-baseline gap-3">
                      <span className="font-serif text-base text-ink">
                        {formatValue(
                          { value: figure.value, unit: figure.unit ?? 'money', currency: figure.currency },
                          { showMinorUnits: true },
                        )}
                      </span>
                      {figure.snapshotId === null ? null : (
                        <Link
                          href={`/app/${orgSlug}/evidence?snapshot=${figure.snapshotId}`}
                          className="text-sm text-accent underline underline-offset-2"
                        >
                          Open
                          <span className="sr-only"> the evidence behind {figure.label}</span>
                        </Link>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {/*
          * The rows this claim pins (§4, §8.3).
          *
          * An alert about a duplicate pair or an unusual payment IS about those rows; a selection
          * cannot stand in for them. Shown with their status, and never filtered by it — a row that
          * has since been replaced or rejected is why the claim was made, and hiding it would erase
          * the reason.
          */}
        {view.pinned.length === 0 ? null : (
          <Card>
            <CardBody>
              <h2 className="font-serif text-lg text-ink">The specific records behind this</h2>
              <ul className="mt-4 space-y-3">
                {view.pinned.map((item) => (
                  <li key={item.itemId} className="border-b border-line pb-3 last:border-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm text-ink">{item.label}</span>
                      {item.superseded ? <Badge tone="warn">Replaced since</Badge> : null}
                      {item.rejected ? <Badge tone="danger">Rejected since</Badge> : null}
                      {item.revisionNo === null ? null : (
                        <Badge tone="neutral">As it read at revision {item.revisionNo}</Badge>
                      )}
                    </div>
                    {item.claim === null ? null : (
                      <p className="mt-1 text-sm text-ink-muted">{item.claim}</p>
                    )}
                    {item.canReachDocument && item.table !== null && item.recordId !== null ? (
                      <p className="mt-1 text-sm">
                        <Link
                          href={`/app/${orgSlug}/evidence/${bundleId}?row=${item.table}:${item.recordId}`}
                          className="text-accent underline underline-offset-2"
                        >
                          Source
                          <span className="sr-only"> document for {item.label}</span>
                        </Link>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {/*
          * N-2: every year-to-date subtraction this figure rests on, at any depth (net profit's
          * revenue, cost of sales, expenses…), each side reconciled and linked to its rows.
          */}
        {view.subtractions.length === 0 ? null : (
          <Card>
            <CardBody>
              <h2 className="font-serif text-lg text-ink">Worked out from year-to-date reports</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Each of these is this month&apos;s report total less the previous month&apos;s.
              </p>
              {view.subtractions.map((s) => (
                <DifferencePanel key={s.snapshotId} difference={s.difference} currency={s.currency} label={s.label} />
              ))}
            </CardBody>
          </Card>
        )}

        {/* Level 3 — Records: the rows themselves, with the reconciliation that proves the figure. */}
        {view.records.map((block) => (
          <Card key={block.itemId} id={`records-${block.itemId}`}>
            <CardBody>
              <h2 className="font-serif text-lg text-ink">{block.label}</h2>
              <p className="mt-1 text-sm text-ink-muted">
                {block.reconciliation}
              </p>

              <div className="mt-4">
                <TableWrap>
                  <table className="w-full text-sm">
                    <THead columns={['Date', 'Description', 'Amount', 'Status', 'Source', 'This row']} />
                    <TBody>
                      {block.selection.rows.map((record) => (
                        <TR key={record.id}>
                          <TD>{record.date ?? '—'}</TD>
                          <TD>{record.description ?? '—'}</TD>
                          <TD className="tabular-nums">{record.amount ?? '—'}</TD>
                          <TD>
                            {record.superseded ? (
                              <Badge tone="warn">Replaced</Badge>
                            ) : record.recordStatus === 'rejected' ? (
                              <Badge tone="danger">Rejected</Badge>
                            ) : (
                              <span className="text-ink-faint">—</span>
                            )}
                          </TD>
                          <TD>
                            <Link
                              href={`/app/${orgSlug}/evidence/${bundleId}?row=${record.table}:${record.id}`}
                              className="text-accent underline underline-offset-2"
                            >
                              Source
                              <span className="sr-only"> document for this row</span>
                            </Link>
                          </TD>
                          {/*
                            * The chain, turned round (ADR-096). "Source" stays where it was: it opens
                            * the FILE behind this row, in place, which is what a reader reconciling a
                            * figure wants. This asks a different question — is this one row counted,
                            * which import brought it in, has something replaced it — and so it is a
                            * page of its own rather than a fourth panel on this one.
                            */}
                          <TD>
                            {recordKindOf(record.table) === null ? (
                              <span className="text-ink-faint">—</span>
                            ) : (
                              <Link
                                href={`/app/${orgSlug}/evidence/record/${recordKindOf(record.table)}/${record.id}`}
                                className="text-accent underline underline-offset-2"
                              >
                                Where from?
                                <span className="sr-only"> — the history of this record</span>
                              </Link>
                            )}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </table>
                </TableWrap>
              </div>

              {/*
                * §6: "500 of 1,238 rows shown". A truncated list still reconciles, because `count`
                * and `total` are over the whole selection — but a reader who wants the rest has to
                * be able to reach them, and each block pages on its own so moving one does not move
                * the others.
                */}
              {block.selection.nextCursor === undefined && block.offset === 0 ? null : (
                <p className="mt-3 flex gap-4 text-sm">
                  {block.offset === 0 ? null : (
                    <Link
                      href={`/app/${orgSlug}/evidence/${bundleId}?block=${block.itemId}&from=${Math.max(0, block.offset - PAGE_STEP)}`}
                      className="text-accent underline underline-offset-2"
                    >
                      Previous rows
                    </Link>
                  )}
                  {block.selection.nextCursor === undefined ? null : (
                    <Link
                      href={`/app/${orgSlug}/evidence/${bundleId}?block=${block.itemId}&from=${block.selection.nextCursor.offset}`}
                      className="text-accent underline underline-offset-2"
                    >
                      Next rows
                    </Link>
                  )}
                </p>
              )}
            </CardBody>
          </Card>
        ))}

        {/* Level 4 — Document: only once a reader has picked a row to descend from. */}
        <Card>
          <CardBody>
            <h2 className="font-serif text-lg text-ink">The source document</h2>
            {document === null ? (
              <p className="mt-1 text-sm text-ink-muted">
                Choose <span className="text-ink">Source</span> on any row above to see the file it
                was read from.
              </p>
            ) : (
              <div className="mt-3">
                <DocumentPanel
                  orgSlug={orgSlug}
                  documentId={document.documentId}
                  filename={document.filename}
                  where={whereInFile(document)}
                  locked={document.locked}
                />
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

/** The row a reader descended from, as `<table>:<id>`; absent until they pick one. */
/**
 * N-2: a figure that is the difference of two periods' records, reconciled in the order a reader
 * checks it — each side's rows against what the calculation used for that side, with a link to those
 * rows, then the subtraction against the figure. A mismatch anywhere is stated, never hidden.
 */
function DifferencePanel({ difference, currency, label }: {
  difference: DrawerDifference; currency: string | null; label?: string;
}) {
  const money = (value: string | null) => formatValue({ value, unit: 'money', currency }, { showMinorUnits: true });
  const missing = difference.terms.some((t) => t.total === null);
  const [current, prior] = difference.terms;
  // D-6: the other two-selection figure is a SUM — an anchoring statement plus ledger movements.
  const sum = difference.formula === 'opening_balance + movements';
  const op = prior?.sign === 1 ? '+' : '−';
  return (
    <div className="mt-3 rounded-md border border-line px-3 py-2 text-sm text-ink" data-testid="difference-panel">
      <p>
        {label ? `${label}: ` : ''}{sum
          ? 'this balance is the opening a balance sheet states, plus every ledger movement since.'
          : 'this month is worked out from a year-to-date report — this report’s year to date, less the previous month’s.'}
      </p>
      <ul className="mt-1 space-y-1">
        {difference.terms.map((term) => (
          <li key={term.name} className="[overflow-wrap:anywhere]">
            {term.name === 'opening_balance' ? 'Opening balance' : term.name === 'movements' ? 'Plus: movements since'
              : term.sign === 1 ? 'Year to date' : 'Less: year to date'}
            {term.periodLabel ? (term.name === 'opening_balance' ? ` at the end of ${term.periodLabel}` : ` to ${term.periodLabel}`) : ''}
            {': '}
            {term.total === null
              ? `not available (${missingReasonText([term.unavailable ?? ''])})`
              : (
                <>
                  {money(term.total)}
                  {term.rowCount === null ? '' : ` from ${term.rowCount} ${term.rowCount === 1 ? 'row' : 'rows'}`}
                  {term.reconciles === true ? ` — matches the ${money(term.expected)} the calculation used` : ''}
                  {term.reconciles === false
                    ? ` — does not match the ${money(term.expected)} the calculation used. Please tell us — a figure that does not reconcile is a fault.`
                    : ''}
                  {term.recordsItemId === null ? null : (
                    <>
                      {' '}
                      <a href={`#records-${term.recordsItemId}`} className="text-accent underline underline-offset-2">
                        See these rows
                        <span className="sr-only">{` (year to date${term.periodLabel ? ` to ${term.periodLabel}` : ''})`}</span>
                      </a>
                    </>
                  )}
                </>
              )}
          </li>
        ))}
      </ul>
      <p className="mt-1" data-testid="difference-formula">
        {missing || current === undefined || prior === undefined
          ? 'One side of the subtraction is missing, so this figure cannot be worked out.'
          : difference.formulaReconciles === false
            ? `${money(current.total)} ${op} ${money(prior.total)} = ${money(difference.recordsResult)}, which does not match the figure of ${money(difference.figure)}. Please tell us — a figure that does not reconcile is a fault.`
            : `${money(current.total)} ${op} ${money(prior.total)} = ${money(difference.recordsResult)}, which is ${sum ? 'the balance' : 'this month’s figure'}.`}
      </p>
      {difference.arithmeticReconciles === false ? (
        <p className="mt-1 text-warn">
          The amounts the calculation used do not produce this figure. Please tell us — a figure that does not reconcile is a fault.
        </p>
      ) : null}
    </div>
  );
}

async function documentFor(
  ctx: Awaited<ReturnType<typeof getAccessContext>>,
  row: string | undefined,
): Promise<DocumentReference | null> {
  if (!row) return null;
  const separator = row.indexOf(':');
  if (separator <= 0) return null;
  const table = row.slice(0, separator);
  const id = row.slice(separator + 1);
  // A row with no document behind it is a real state (§5.1) — a restored or merged record — and
  // reads as "no source document", not as an error page. Anything other than NOT FOUND is not that
  // state and is not hidden behind it (ADR-070).
  return getDocumentReference(ctx, { table, id }).catch((error: unknown) => {
    if (isMotionError(error) && error.code === 'NOT_FOUND') return null;
    throw error;
  });
}

function whereInFile(reference: DocumentReference): string | null {
  const parts: string[] = [];
  if (reference.sheet !== null) parts.push(`sheet ${reference.sheet}`);
  if (reference.page !== null) parts.push(`page ${reference.page}`);
  if (reference.row !== null) parts.push(`line ${reference.row}`);
  return parts.length === 0 ? null : parts.join(', ');
}

function quality(raw: Record<string, unknown>): DataQuality {
  return {
    completeness: typeof raw.completeness === 'number' ? raw.completeness : 1,
    proxy: raw.proxy === true,
    warnings: warningsOf(raw),
    missing: Array.isArray(raw.missing) ? (raw.missing as string[]) : [],
  } as DataQuality;
}

function warningsOf(raw: Record<string, unknown>): string[] {
  return Array.isArray(raw.warnings) ? (raw.warnings as string[]) : [];
}

/** The §8.1 assurance word, for the statement level's badge. */
function assuranceLabel(assurance: string): string {
  switch (assurance) {
    case 'verified': return 'From your records';
    case 'calculated': return 'Calculated';
    case 'estimated': return 'Estimate';
    default: return 'Please check';
  }
}

function formatInstant(iso: string | null): string {
  if (iso === null) return 'an earlier run';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? 'an earlier run'
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** The four record tables in the product's words; anything else has no record page (ADR-096). */
function recordKindOf(table: string | null): RecordKind | null {
  if (table === null) return null;
  const found = Object.entries(RECORD_KINDS).find(([, name]) => name === table);
  return found === undefined ? null : (found[0] as RecordKind);
}
