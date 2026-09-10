import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isMotionError } from '@/core/errors';
import { can } from '@/core/permissions';
import { deletable, getDocument } from '@/modules/documents';
import { getAccessContext } from '@/modules/tenancy';
import { Badge, Card, CardBody, CardHeader, DetailList, PageHeader } from '@/components/ui/surfaces';
import { formatDateTime } from '@/components/labels';
import { DocumentViewer } from '@/components/dashboard/document-viewer';
import { DeleteDocumentControl } from '../delete-control';
import { DOCUMENT_KIND_LABELS, DOCUMENT_STATUS_LABELS, DOCUMENT_STATUS_TONES, formatBytes } from '../presentation';

export const dynamic = 'force-dynamic';

/** One document: the file itself, and the imports that rest on it (ROUTE_ARCHITECTURE.md §128). */
export default async function DocumentPage({ params }: { params: Promise<{ orgSlug: string; documentId: string }> }) {
  const { orgSlug, documentId } = await params;
  const ctx = await getAccessContext(orgSlug);
  if (!can(ctx, 'documents.view')) notFound();
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) notFound();

  let document;
  try {
    document = await getDocument(ctx, documentId);
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  return (
    <>
      <p className="mb-2 text-sm"><Link href={`/app/${orgSlug}/data/documents`} className="text-accent underline underline-offset-2">Back to documents</Link></p>
      <PageHeader eyebrow="Data" title={document.filename} description={`${DOCUMENT_KIND_LABELS[document.kind] ?? document.kind} · uploaded ${formatDateTime(document.createdAt)}`} />
      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardBody className="p-4">
            {document.deletedAt !== null ? (
              <p className="text-sm text-ink-muted">This file was deleted on {formatDateTime(document.deletedAt)}. The record of it is kept.</p>
            ) : (
              <DocumentViewer orgSlug={orgSlug} documentId={document.id} filename={document.filename} />
            )}
          </CardBody>
        </Card>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="About this file" />
            <CardBody>
              <DetailList items={[
                { label: 'Status', value: <Badge tone={DOCUMENT_STATUS_TONES[document.status] ?? 'neutral'}>{DOCUMENT_STATUS_LABELS[document.status] ?? document.status}</Badge> },
                { label: 'Size', value: formatBytes(document.byteSize) },
                { label: 'Pages', value: document.pageCount ?? '—' },
                { label: 'Text layer', value: document.hasTextLayer === null ? '—' : document.hasTextLayer ? 'yes' : 'no (scanned)' },
              ]} />
              {can(ctx, 'imports.review') && deletable(document) ? <div className="mt-4"><DeleteDocumentControl orgSlug={orgSlug} documentId={document.id} filename={document.filename} /></div> : null}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Imports from this file" />
            <CardBody>
              {document.batches.length === 0 ? <p className="text-sm text-ink-muted">None yet.</p> : (
                <ul className="flex flex-col gap-2 text-sm">
                  {document.batches.map((b) => (
                    <li key={b.id}>
                      <Link href={`/app/${orgSlug}/data/imports/${b.id}`} className="underline">{b.importType.replace(/_/g, ' ')}</Link>
                      <span className="ml-2 text-ink-muted">{b.status.replace('_', ' ')} · {formatDateTime(b.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
