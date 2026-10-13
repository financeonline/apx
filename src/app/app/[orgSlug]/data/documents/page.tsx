import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@/core/permissions';
import { deletable, listDocuments } from '@/modules/documents';
import { getAccessContext } from '@/modules/tenancy';
import { Badge, Card, CardBody, EmptyState, PageHeader } from '@/components/ui/surfaces';
import { ButtonLink } from '@/components/ui/button';
import { THead, TBody, TR, TD } from '@/components/ui/table';
import { Table } from '@/components/ui/shadcn';
import { formatDateTime } from '@/components/labels';
import { DeleteDocumentControl } from './delete-control';
import { DOCUMENT_KIND_LABELS, DOCUMENT_STATUS_LABELS, DOCUMENT_STATUS_TONES, formatBytes } from './presentation';

export const dynamic = 'force-dynamic';

/**
 * The document library (ROUTE_ARCHITECTURE.md §127; ADR-087). Every file the organisation has
 * uploaded, what became of it, and — for a file no import rests on — the one way to remove it.
 */
export default async function DocumentsPage({ params, searchParams }: { params: Promise<{ orgSlug: string }>; searchParams: Promise<{ show?: string }> }) {
  const { orgSlug } = await params;
  const { show } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  if (!can(ctx, 'documents.view')) notFound();
  const scope = show === 'all' ? 'all' : 'current';
  const documents = await listDocuments(ctx, scope);

  return (
    <>
      <PageHeader eyebrow="Data" title="Documents" description="Every file you have given APX, and what became of it." />
      <p className="mt-2 text-sm text-ink-muted">
        {scope === 'all'
          ? <Link className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft" href={`/app/${orgSlug}/data/documents`}>Hide deleted files</Link>
          : <Link className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft" href={`/app/${orgSlug}/data/documents?show=all`}>Show deleted files too</Link>}
      </p>
      <div className="mt-8">
        <Card>
          <CardBody className="p-4">
            {documents.length === 0 ? (
              <EmptyState title="No documents yet" actionHref={can(ctx, 'imports.create') ? `/app/${orgSlug}/data/imports/new` : undefined} actionLabel="Add data">
                Files you upload — bank statements, ledger exports, invoice lists — are kept here as the source of your figures.
              </EmptyState>
            ) : (
              <Table>
                <caption className="sr-only">Documents</caption>
                <THead columns={['File', 'Kind', 'Size', 'Uploaded', 'Status', 'Imports', '']} />
                <TBody>
                  {documents.map((d) => (
                    <TR key={d.id}>
                      <TD><Link href={`/app/${orgSlug}/data/documents/${d.id}`} className="text-accent underline underline-offset-2">{d.filename}</Link></TD>
                      <TD className="text-ink-muted">{DOCUMENT_KIND_LABELS[d.kind] ?? d.kind}</TD>
                      <TD className="tabular text-ink-muted">{formatBytes(d.byteSize)}</TD>
                      <TD className="text-ink-muted">{formatDateTime(d.createdAt)}</TD>
                      <TD><Badge tone={DOCUMENT_STATUS_TONES[d.status] ?? 'neutral'}>{DOCUMENT_STATUS_LABELS[d.status] ?? d.status}</Badge></TD>
                      <TD className="text-ink-muted">
                        {d.batches.length === 0 ? '—' : d.batches.map((b) => (
                          <Link key={b.id} href={`/app/${orgSlug}/data/imports/${b.id}`} className="mr-2 underline">{b.status.replace('_', ' ')}</Link>
                        ))}
                      </TD>
                      <TD>{can(ctx, 'imports.review') && deletable(d) ? <DeleteDocumentControl orgSlug={orgSlug} documentId={d.id} filename={d.filename} /> : null}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>
      {can(ctx, 'imports.create') ? <div className="mt-6"><ButtonLink href={`/app/${orgSlug}/data/imports/new`}>Add data</ButtonLink></div> : null}
    </>
  );
}
