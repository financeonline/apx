import Link from 'next/link';
import { Download } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { loadImportHistory } from '@/modules/imports';
import { PageHeader, Card, CardBody, Badge, EmptyState, IconBadge } from '@/components/ui/surfaces';
import { ButtonLink } from '@/components/ui/button';
import { THead, TBody, TR, TD } from '@/components/ui/table';
import { Table } from '@/components/ui/shadcn';
import { RollbackControl } from './rollback-control';
import { formatCoverage, importStatusLabel, importTypeLabel } from './labels';
import { requirePermission } from '@/app/_lib/authz';

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
  requirePermission(ctx, 'imports.review');

  const history = await loadImportHistory(ctx.db, ctx.orgId!, ctx.requestId);

  return (
    <>
      <PageHeader
        eyebrow="Data"
        title="Imports"
        description="Every file you have uploaded, and what happened to it. Open a file to see its rows and anything that needs your answer."
      />

      <div className="mt-8">
        {history.length === 0 ? (
          <EmptyState title="You have not imported anything yet">
            <p>
              Start with a bank statement. Upload it and APX checks every row; nothing counts
              towards your figures until you have reviewed it and pressed Import.
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
              <Table>
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
                      <TD className="text-ink-muted">{importTypeLabel(batch.importType)}</TD>
                      <TD className="tabular text-ink-muted">
                        {formatCoverage(batch.periodStart, batch.periodEnd)}
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
              </Table>
              {/* The three statuses an owner meets most, said once under the table rather than in a
                  tooltip nobody finds on a phone. One run of text, not a badge per word, so a status
                  is only ever found in the table. */}
              <p className="mt-3 text-xs text-ink-muted">
                Needs your review: open it and answer what it asks. Imported: part of your figures.
                Removed: taken back out of your figures.
              </p>
            </CardBody>
          </Card>
        )}
      </div>
      {can(ctx, 'data.export') ? (
        <div className="mt-6">
          <Card>
            <CardBody className="p-4">
              <div className="flex min-w-0 gap-3.5">
                <IconBadge tint="pink"><Download /></IconBadge>
                <div className="min-w-0">
                  <h2 className="font-serif text-lg text-ink">Export your data</h2>
                  <p className="mt-1 text-sm text-ink-muted">
                    Download the records behind your figures as CSV files, which open in Excel. Bank descriptions are
                    partly hidden for privacy, and every download is recorded.
                  </p>
                </div>
              </div>
              <ul className="mt-3 flex flex-wrap gap-2 text-sm">
                {([['ledger', 'Ledger'], ['bank_transactions', 'Bank transactions'], ['invoices', 'Invoices'], ['metrics', 'Key figures']] as const).map(([kind, label]) => (
                  <li key={kind}>
                    <a className="inline-flex items-center rounded-xl border border-line bg-surface px-3 py-1.5 font-medium text-ink transition-colors hover:border-accent/45 hover:bg-accent-soft hover:text-accent pointer-coarse:min-h-10" href={`/api/exports/${kind}?org=${orgSlug}`} download>
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

function StatusBadge({ status }: { status: string }) {
  const tone = status === 'committed' ? 'accent'
    : status === 'failed' || status === 'rejected' ? 'danger'
    : status === 'awaiting_review' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{importStatusLabel(status)}</Badge>;
}
