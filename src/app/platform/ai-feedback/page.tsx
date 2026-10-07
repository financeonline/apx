import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { assertCan } from '@/core/permissions';
import { listFeedback } from '@/modules/ai';
import { getPlatformContext } from '@/modules/tenancy';
import { Badge, Card, CardBody, EmptyState, PageHeader, type BadgeTone } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDateTime } from '@/components/labels';
import { FEEDBACK_TYPE_LABELS, STATUS_LABELS, STATUS_TONES } from './presentation';

export const dynamic = 'force-dynamic';

/**
 * The review queue (AI_ARCHITECTURE.md §13, CD-25; ROUTE_ARCHITECTURE.md §154; ADR-082).
 *
 * Open reports first, newest first — the page exists so a report does not sit unread. Reads run
 * under the reviewer's own client: a super admin sees every organisation, an assigned employee
 * theirs, and this page holds no service role and cannot show anything RLS would not.
 */
export default async function AiFeedbackPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await getPlatformContext();
  assertCan(ctx, 'platform.ai_feedback.review');
  const { status } = await searchParams;
  const scope = status === 'all' ? 'all' : 'open';
  const items = await listFeedback(ctx, scope);

  return (
    <>
      <PageHeader
        title="AI feedback"
        description={scope === 'all' ? 'Every report, whatever its state.' : 'Reports on analyst answers that nobody has looked at yet.'}
      />
      <p className="mt-2 text-sm text-ink-muted">
        {scope === 'all'
          ? <Link className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft" href="/platform/ai-feedback">Show only open reports</Link>
          : <Link className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft" href="/platform/ai-feedback?status=all">Show all reports</Link>}
      </p>
      <div className="mt-8">
        <Card>
          <CardBody>
            {items.length === 0 ? (
              <EmptyState title={scope === 'all' ? 'No reports yet' : 'Nothing to review'}>
                {scope === 'all' ? 'Reports appear here when someone reports an analyst answer.' : 'Every report has been looked at.'}
              </EmptyState>
            ) : (
              <TableWrap>
                <THead columns={['Reported', 'Organisation', 'What was wrong', 'Answer', 'Status', '']} />
                <TBody>
                  {items.map((item) => (
                    <TR key={item.id}>
                      <TD>{formatDateTime(item.createdAt)}</TD>
                      <TD>{item.organizationName}</TD>
                      <TD>
                        {FEEDBACK_TYPE_LABELS[item.type] ?? item.type}
                        {item.comment ? <span className="block text-xs text-ink-muted">{item.comment.slice(0, 120)}</span> : null}
                      </TD>
                      <TD>{item.groundingStatus ? <Badge tone={GROUNDING_TONES[item.groundingStatus] ?? 'neutral'}>{item.groundingStatus.replace('_', ' ')}</Badge> : '—'}</TD>
                      <TD><Badge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge></TD>
                      <TD><Link className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft" href={`/platform/ai-feedback/${item.id}`}>Open <ChevronRight aria-hidden="true" className="size-4" /></Link></TD>
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

const GROUNDING_TONES: Record<string, BadgeTone> = { passed: 'neutral', degraded: 'warn', failed: 'danger', not_applicable: 'neutral' };
