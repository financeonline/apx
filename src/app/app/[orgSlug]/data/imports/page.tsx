import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { loadImportHistory } from '@/modules/imports';
import { PageHeader, Card, CardBody, Badge, EmptyState } from '@/components/ui/surfaces';
import { ButtonLink } from '@/components/ui/button';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { RollbackControl } from './rollback-control';

export const dynamic = 'force-dynamic';

/**
 * Import history (IMPORT_ENGINE.md §13, ROUTE_ARCHITECTURE.md §4).
 *
 * What was loaded, when, what became of it — and the way back. Rolling an import back is offered
 * here rather than buried, because the moment somebody realises they imported the wrong month is
 * the moment they need it, and hunting for it is how a wrong figure survives another week.
 */
export default async function ImportsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  if (!can(ctx, 'imports.review')) notFound();

  const history = await loadImportHistory(ctx.db, ctx.orgId!, ctx.requestId);

  return (
    <>
      <PageHeader
        eyebrow="Data"
        title="Imports"
        description="Every file you have loaded, and what happened to it."
      />

      <div className="mt-8">
        {history.length === 0 ? (
          <EmptyState title="You have not imported anything yet">
            <p>
              Upload a bank statement, ledger or invoice list and MOTION will check every row before
              anything becomes a figure.
            </p>
            {can(ctx, 'imports.create') ? (
              <div className="mt-6">
                <ButtonLink href={`/app/${orgSlug}/data/imports/new`}>Add data</ButtonLink>
              </div>
            ) : null}
          </EmptyState>
        ) : (
          <Card>
            <CardBody className="p-4">
              <div className="mb-3 flex justify-end">
                {can(ctx, 'imports.create') ? (
                  <ButtonLink href={`/app/${orgSlug}/data/imports/new`}>Add data</ButtonLink>
                ) : null}
              </div>
              <TableWrap>
                <table className="w-full text-sm">
                  <caption className="sr-only">Files imported into this organisation</caption>
                  <THead columns={['File', 'What it is', 'Covers', 'Rows', 'Status', '']} />
                  <TBody>
                    {history.map(({ batch, filename, rows }) => (
                      <TR key={batch.id}>
                        <TD>
                          <Link
                            href={`/app/${orgSlug}/data/imports/${batch.id}`}
                            className="text-accent underline underline-offset-2"
                          >
                            {filename ?? 'Untitled file'}
                          </Link>
                        </TD>
                        <TD className="text-ink-muted">{TYPE_LABELS[batch.importType] ?? batch.importType}</TD>
                        <TD className="tabular text-ink-muted">
                          {batch.periodStart ?? '—'} → {batch.periodEnd ?? '—'}
                        </TD>
                        <TD className="tabular">{rows}</TD>
                        <TD><StatusBadge status={batch.status} /></TD>
                        <TD>
                          {batch.status === 'committed' && can(ctx, 'imports.review') ? (
                            <RollbackControl orgSlug={orgSlug} batchId={batch.id} />
                          ) : null}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </table>
              </TableWrap>
            </CardBody>
          </Card>
        )}
      </div>
      {can(ctx, 'data.export') ? (
        <div className="mt-6">
          <Card>
            <CardBody className="p-4">
              <h2 className="font-serif text-lg text-ink">Export your data</h2>
              <p className="mt-1 text-sm text-ink-muted">
                A CSV of what your figures rest on. Bank lines carry the masked description only; every export is recorded.
              </p>
              <ul className="mt-3 flex flex-wrap gap-2 text-sm">
                {([['ledger', 'Ledger'], ['bank_transactions', 'Bank transactions'], ['invoices', 'Invoices'], ['metrics', 'Metrics']] as const).map(([kind, label]) => (
                  <li key={kind}>
                    <a className="rounded-md border border-line px-3 py-1.5 text-ink hover:bg-surface-sunken" href={`/api/exports/${kind}?org=${orgSlug}`} download>
                      {label} (CSV)
                    </a>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      ) : null}
    </>
  );
}

const TYPE_LABELS: Readonly<Record<string, string>> = {
  bank_statement: 'Bank statement',
  general_ledger: 'General ledger',
  trial_balance: 'Trial balance',
  pnl_report: 'Profit and loss',
  balance_sheet: 'Balance sheet',
  sales_invoices: 'Sales invoices',
  purchase_invoices: 'Purchase invoices',
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  created: 'Started',
  parsing: 'Reading',
  validating: 'Checking',
  awaiting_review: 'Needs review',
  committing: 'Importing',
  committed: 'Imported',
  rolled_back: 'Rolled back',
  rejected: 'Discarded',
  failed: 'Could not be read',
  deferred_upstream: 'Waiting',
};

function StatusBadge({ status }: { status: string }) {
  const tone = status === 'committed' ? 'accent'
    : status === 'failed' || status === 'rejected' ? 'danger'
    : status === 'awaiting_review' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{STATUS_LABELS[status] ?? status}</Badge>;
}
