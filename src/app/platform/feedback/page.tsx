import { assertCan } from '@/core/permissions';
import { feedbackDepartmentLabel, feedbackSectionLabel, listDashboardFeedback } from '@/modules/feedback';
import { getPlatformContext } from '@/modules/tenancy';
import { Badge, Card, CardBody, EmptyState, PageHeader } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDateTime } from '@/components/labels';

export const dynamic = 'force-dynamic';

/**
 * Dashboard feedback (docs/DEPARTMENT_DASHBOARD_PLAN.md: "Give feedback" sends the note to APX
 * staff inside APX). The latest 200 notes from every company, newest first. The Platform layout
 * admits the super admin only (`system.manage`); `api.platform_dashboard_feedback` checks again and
 * resolves the company's name and the author's email, which `profiles`' own-row-only read hides.
 */
export default async function PlatformFeedbackPage() {
  const ctx = await getPlatformContext();
  assertCan(ctx, 'system.manage');
  const items = await listDashboardFeedback(ctx, 200);

  return (
    <>
      <PageHeader title="Dashboard feedback" description="Notes people sent from the department dashboard, newest first." />
      <div className="mt-8">
        <Card>
          <CardBody>
            {items.length === 0 ? (
              <EmptyState title="No feedback yet">
                Notes appear here when someone uses Give feedback on a company&rsquo;s dashboard.
              </EmptyState>
            ) : (
              <TableWrap>
                <THead columns={['Sent', 'Company', 'From', 'Section', 'Department', 'Notes']} />
                <TBody>
                  {items.map((item) => (
                    <TR key={item.id}>
                      <TD>
                        {formatDateTime(item.createdAt)}
                        {item.status === 'new' ? <span className="mt-1 block"><Badge tone="accent">New</Badge></span> : null}
                      </TD>
                      <TD>{item.organizationName ?? '—'}</TD>
                      <TD>
                        {item.authorEmail ?? '—'}
                        {item.authorName ? <span className="block text-xs text-ink-muted">{item.authorName}</span> : null}
                      </TD>
                      <TD>{feedbackSectionLabel(item.section)}</TD>
                      <TD>{feedbackDepartmentLabel(item.department)}</TD>
                      <TD>
                        <span className="block max-w-prose whitespace-pre-wrap break-words">{item.notes}</span>
                        {contextLine(item.context) ? <span className="mt-1 block text-xs text-ink-muted">{contextLine(item.context)}</span> : null}
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

/** What was on screen when the note was written: "Period … · View … · Scenario …". */
function contextLine(context: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  if (context.period) parts.push(`Period: ${context.period}`);
  if (context.months) parts.push(`Months: ${context.months}`);
  if (context.view) parts.push(`View: ${context.view}`);
  if (context.scenario) parts.push(`Scenario: ${context.scenario}`);
  return parts.join(' · ');
}
