import Link from 'next/link';
import { ClipboardCheck, MessageSquareText, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import { notFound } from 'next/navigation';
import { isMotionError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import { recordAccessEvent } from '@/core/db/server-rpc';
import { loadFeedback } from '@/modules/ai';
import { getPlatformContext } from '@/modules/tenancy';
import { Badge, Card, CardBody, CardHeader, DetailList, PageHeader } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDateTime } from '@/components/labels';
import { KIND_LABELS, SECTION_ORDER, SECTION_TITLES, type StatementKind } from '@/components/dashboard/analyst-presentation';
import { FEEDBACK_TYPE_LABELS, STATUS_LABELS, STATUS_TONES } from '../presentation';
import { ReviewForm } from './review-form';

export const dynamic = 'force-dynamic';

/**
 * One report (AI_ARCHITECTURE.md §13; ADR-038.6; ADR-082): the answer as the reader saw it, the
 * grounding report the server kept (removed sentences live here and nowhere else, R2-C-04), the
 * tool calls, and the evidence — then the review. Opening tenant content writes `org.data_viewed`,
 * which the organisation's owner can see in their own audit log (CD-13).
 */
export default async function AiFeedbackItemPage({ params }: { params: Promise<{ feedbackId: string }> }) {
  const { feedbackId } = await params;
  const ctx = await getPlatformContext();
  assertCan(ctx, 'platform.ai_feedback.review');
  if (!/^[0-9a-f-]{36}$/i.test(feedbackId)) notFound();

  let item;
  try {
    item = await loadFeedback(ctx, feedbackId);
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  await recordAccessEvent(
    { userId: ctx.userId, requestId: ctx.requestId },
    { organizationId: item.organizationId, action: 'org.data_viewed', targetTable: 'ai_feedback', targetId: item.id, metadata: { route: '/platform/ai-feedback' } },
  );

  const answer = item.structured;
  const report = item.groundingReport as { reason?: string; mismatches?: Array<{ path: string; statement: string; reason: string }> } | null;

  return (
    <>
      <p className="text-sm"><Link className="underline" href="/platform/ai-feedback">← AI feedback</Link></p>
      <PageHeader
        eyebrow="AI feedback"
        title={FEEDBACK_TYPE_LABELS[item.type] ?? item.type}
        description={`${item.organizationName} · reported ${formatDateTime(item.createdAt)}`}
      />

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-6">
          {item.comment ? (
            <Card><CardHeader icon={<MessageSquareText />} tint="violet" title="What the reporter said" /><CardBody><p className="text-sm">{item.comment}</p></CardBody></Card>
          ) : null}

          <Card>
            <CardHeader icon={<Sparkles />} tint="pink" title="The answer" />
            <CardBody>
              {answer ? (
                <div className="flex flex-col gap-3 text-sm">
                  <p><Badge tone="neutral">{KIND_LABELS[answer.direct_answer.kind as StatementKind]}</Badge> {answer.direct_answer.statement}</p>
                  {SECTION_ORDER.map((key) => (answer[key].length === 0 ? null : (
                    <section key={key}>
                      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">{SECTION_TITLES[key]}</h3>
                      <ul className="mt-1 flex flex-col gap-1">
                        {key === 'recommended_actions'
                          ? answer.recommended_actions.map((r, i) => <li key={i}>{r.title.statement} — {r.recommendation.statement}</li>)
                          : answer[key].map((s, i) => <li key={i}><Badge tone="neutral">{KIND_LABELS[s.kind as StatementKind]}</Badge> {s.statement}</li>)}
                      </ul>
                    </section>
                  )))}
                  {answer.unsupported.length > 0 ? (
                    <p className="text-ink-muted">Not covered: {answer.unsupported.map((u) => `${u.topic} (${u.reason})`).join('; ')}</p>
                  ) : null}
                </div>
              ) : <p className="text-sm text-ink-muted">This turn produced no answer (it {item.groundingStatus ?? 'failed'}).</p>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader icon={<ShieldCheck />} tint="violet" title="Grounding report" />
            <CardBody>
              {report?.mismatches && report.mismatches.length > 0 ? (
                <TableWrap>
                  <THead columns={['Where', 'What the model wrote', 'Why it was removed']} />
                  <TBody>
                    {report.mismatches.map((m, i) => (
                      <TR key={i}><TD><span className="font-mono text-xs">{m.path}</span></TD><TD>{m.statement}</TD><TD>{m.reason}</TD></TR>
                    ))}
                  </TBody>
                </TableWrap>
              ) : (
                <p className="text-sm text-ink-muted">{report?.reason ? `Reason: ${report.reason}` : 'Nothing was removed from this answer.'}</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader icon={<Wrench />} tint="pink" title="Tool calls" />
            <CardBody>
              {item.toolCalls.length === 0 ? <p className="text-sm text-ink-muted">No tools were called.</p> : (
                <TableWrap>
                  <THead columns={['#', 'Tool', 'Authorised', 'Outcome', 'Time']} />
                  <TBody>
                    {item.toolCalls.map((c) => (
                      <TR key={c.seq}>
                        <TD>{c.seq}</TD>
                        <TD><span className="font-mono text-xs">{c.toolName}</span></TD>
                        <TD>{c.authorized ? 'yes' : `no — ${c.denialReason ?? 'denied'}`}</TD>
                        <TD>{c.error ?? 'ok'}</TD>
                        <TD>{c.durationMs === null ? '—' : `${c.durationMs} ms`}</TD>
                      </TR>
                    ))}
                  </TBody>
                </TableWrap>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader icon={<ClipboardCheck />} tint="violet" title="Review" />
            <CardBody>
              <DetailList items={[
                { label: 'Status', value: <Badge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge> },
                { label: 'Grounding', value: item.groundingStatus ?? '—' },
                { label: 'Prompt', value: item.promptVersion ?? '—' },
                { label: 'Model', value: item.model ?? '—' },
                { label: 'Reviewed', value: item.reviewedAt ? formatDateTime(item.reviewedAt) : '—' },
              ]} />
              {item.resolutionNote ? <p className="mt-3 text-sm text-ink-muted">{item.resolutionNote}</p> : null}
              {item.evidenceBundleId ? (
                <p className="mt-3 text-sm">
                  <Link className="underline" href={`/app/${item.organizationSlug}/evidence/${item.evidenceBundleId}`}>See the evidence bundle</Link>
                </p>
              ) : null}
              <div className="mt-4">
                <ReviewForm feedbackId={item.id} />
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
