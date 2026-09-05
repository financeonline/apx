import { getAccessContext, listOrgAuditEvents } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { PageHeader, Card, CardBody, EmptyState, Badge } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { auditActionLabel, ACTOR_TYPE_LABELS } from '@/components/labels';

export const dynamic = 'force-dynamic';

export default async function AuditPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  assertCan(ctx, 'audit.view');

  const events = await listOrgAuditEvents(ctx, { limit: 100 });

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
              <EmptyState title="Nothing recorded yet">Changes will appear here as they happen.</EmptyState>
            ) : (
              <TableWrap>
                <THead columns={['When', 'What happened', 'Who', '']} />
                <TBody>
                  {events.map((event) => (
                    <TR key={event.id}>
                      <TD>{new Date(event.createdAt).toLocaleString('en-GB')}</TD>
                      <TD>{auditActionLabel(event.action)}</TD>
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
      </div>
    </>
  );
}
