import { getAccessContext, listOrgAuditEvents } from '@/modules/tenancy';
import { PageHeader, Card, CardBody, EmptyState, Badge } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { auditActionLabel, ACTOR_TYPE_LABELS } from '@/components/labels';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * The audit log (MVP_SCOPE.md §2.14; CD-13; ADR-072).
 *
 * A page at a time, oldest cut-off at 500 by the function (`api.org_audit_events`). It used to show
 * the latest 100 and stop, so a busy import day pushed a super-admin's `org.data_viewed` visits out
 * of reach — the very thing CD-13 promises the owner can see (PRODUCTION_AUDIT.md M6). The page
 * fetches one more row than it shows to know whether an older page exists, rather than guessing.
 */

const PAGE_SIZE = 50;

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { orgSlug } = await params;
  const { page: pageParam } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'audit.view');

  const pageIndex = Math.max(0, Number.parseInt(pageParam ?? '0', 10) || 0);
  const offset = pageIndex * PAGE_SIZE;

  // One more than the page, so "is there an older page?" is a fact, not an assumption.
  const rows = await listOrgAuditEvents(ctx, { limit: PAGE_SIZE + 1, offset });
  const hasOlder = rows.length > PAGE_SIZE;
  const events = rows.slice(0, PAGE_SIZE);

  const href = (index: number) => `/app/${orgSlug}/settings/audit?page=${index}`;

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Important changes, and every time MOTION staff opened this organisation."
      />
      <div className="mt-8">
        <Card>
          <CardBody>
            {events.length === 0 ? (
              <EmptyState title={pageIndex === 0 ? 'Nothing recorded yet' : 'Nothing further back'}>
                {pageIndex === 0
                  ? 'Changes will appear here as they happen.'
                  : 'There is nothing older than this.'}
              </EmptyState>
            ) : (
              <TableWrap>
                <THead columns={['When', 'What happened', 'About', 'Who', '']} />
                <TBody>
                  {events.map((event) => (
                    <TR key={event.id}>
                      <TD>{new Date(event.createdAt).toLocaleString('en-GB')}</TD>
                      <TD>{auditActionLabel(event.action)}</TD>
                      <TD>
                        {event.targetTable
                          ? <span className="text-ink-muted">{event.targetTable.replace(/_/g, ' ')}</span>
                          : '—'}
                      </TD>
                      <TD>{event.actorName ?? '—'}</TD>
                      <TD>
                        {event.actorType === 'platform_admin' && <Badge tone="warn">MOTION staff</Badge>}
                        {event.actorType !== 'platform_admin' && (
                          <span className="text-ink-muted">
                            {ACTOR_TYPE_LABELS[event.actorType] ?? event.actorType}
                          </span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </TableWrap>
            )}
          </CardBody>
        </Card>

        {(pageIndex > 0 || hasOlder) && (
          <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Audit log pages">
            {pageIndex > 0
              ? <a className="underline" href={href(pageIndex - 1)}>← Newer</a>
              : <span className="text-ink-faint">← Newer</span>}
            <span className="text-ink-muted">Page {pageIndex + 1}</span>
            {hasOlder
              ? <a className="underline" href={href(pageIndex + 1)}>Older →</a>
              : <span className="text-ink-faint">Older →</span>}
          </nav>
        )}
      </div>
    </>
  );
}
