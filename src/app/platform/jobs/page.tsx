import { toMotionError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import { getPlatformContext } from '@/modules/tenancy';
import { PageHeader, Card, CardBody, EmptyState, Badge, type BadgeTone } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { requeueJobForm } from './actions';
import { Button } from '@/components/ui/shadcn';

export const dynamic = 'force-dynamic';

/**
 * The job monitor (ROUTE_ARCHITECTURE.md §6; MVP_SCOPE.md §2.2; ADR-067).
 *
 * It exists because a job that dies with nobody looking is the same as a job that never ran —
 * which is exactly how `org.purge` failed silently for as long as it had no handler
 * (PRODUCTION_AUDIT.md C3). The default view is therefore the jobs that need a person: dead, failed,
 * and running, newest first; `?status=all` shows the rest.
 *
 * Reads run under the super admin's own client (`jobs_select` is `app.is_super_admin()`), so this
 * page holds no service role and cannot show anything RLS would not.
 */

const ATTENTION = ['dead', 'failed', 'running'] as const;

const TONES: Record<string, BadgeTone> = {
  dead: 'danger', failed: 'warn', running: 'accent', queued: 'neutral',
  succeeded: 'neutral', cancelled: 'neutral', deferred_upstream: 'warn',
};

interface JobRow {
  id: string;
  organization_id: string | null;
  job_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after: string;
  last_error: string | null;
  created_at: string;
  organizations: { name: string } | null;
}

export default async function PlatformJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await getPlatformContext();
  assertCan(ctx, 'platform.jobs.view');
  const { status } = await searchParams;
  const showAll = status === 'all';

  let query = ctx.db
    .from('jobs')
    .select('id, organization_id, job_type, status, attempts, max_attempts, run_after, last_error, created_at, organizations(name)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (!showAll) query = query.in('status', [...ATTENTION]);

  const { data, error } = await query;
  // Never `data ?? []`: an empty monitor during an outage is the one thing this page must not show.
  if (error) throw toMotionError(error, ctx.requestId);
  const jobs = (data ?? []) as unknown as JobRow[];

  return (
    <>
      <PageHeader
        title="Jobs"
        description={showAll
          ? 'The last 100 jobs, whatever their state.'
          : 'Jobs that need a person: dead, failed and running. A dead job has used every attempt.'}
      />
      <p className="mt-2 text-sm text-ink-muted">
        {showAll
          ? <a className="underline" href="/platform/jobs">Show only jobs needing attention</a>
          : <a className="underline" href="/platform/jobs?status=all">Show all recent jobs</a>}
      </p>
      <div className="mt-8">
        <Card>
          <CardBody>
            {jobs.length === 0 ? (
              <EmptyState title={showAll ? 'No jobs yet' : 'Nothing needs attention'}>
                {showAll ? 'Jobs appear here as the platform queues them.' : 'No dead, failed or running jobs.'}
              </EmptyState>
            ) : (
              <TableWrap>
                <THead columns={['Job', 'Organisation', 'Status', 'Attempts', 'Runs after', 'Last error', '']} />
                <TBody>
                  {jobs.map((job) => (
                    <TR key={job.id}>
                      <TD>{job.job_type}</TD>
                      <TD>
                        {job.organizations?.name
                          ?? (job.organization_id ? <span className="font-mono text-xs">{job.organization_id}</span> : 'Platform')}
                      </TD>
                      <TD><Badge tone={TONES[job.status] ?? 'neutral'}>{job.status.replace('_', ' ')}</Badge></TD>
                      <TD>{job.attempts} / {job.max_attempts}</TD>
                      <TD>{new Date(job.run_after).toLocaleString('en-GB')}</TD>
                      <TD>
                        {job.last_error
                          ? <span className="text-xs text-ink-muted" title={job.last_error}>{job.last_error.slice(0, 120)}</span>
                          : '—'}
                      </TD>
                      <TD>
                        {(job.status === 'dead' || job.status === 'failed') && (
                          <form action={requeueJobForm}>
                            <input type="hidden" name="jobId" value={job.id} />
                            <Button type="submit" variant="link" className="py-0">Requeue</Button>
                          </form>
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
