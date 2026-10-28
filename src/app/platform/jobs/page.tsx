import { assertCan } from '@/core/permissions';
import { organizationNames, readGlobal } from '@/modules/platform';
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
 * Reads are made for the super admin under `jobs_select` (`app.is_super_admin()`, applied by
 * `readGlobal`), so this page cannot show anything the policy would not.
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

  // A failing read throws: an empty monitor during an outage is the one thing this page must not show.
  const rows = await readGlobal(ctx.db, 'jobs', (q) => (showAll ? q : q.where('status', 'in', [...ATTENTION]))
    .orderBy('created_at', 'desc').limit(100));
  // The old `organizations(name)` embed: the organisation's name where the caller reaches it.
  const names = await organizationNames(ctx.db, rows.map((r) => r.organization_id).filter((id): id is string => typeof id === 'string'));
  const jobs: JobRow[] = rows.map((r) => ({
    id: r.id, organization_id: r.organization_id ?? null, job_type: r.job_type, status: r.status,
    attempts: Number(r.attempts ?? 0), max_attempts: Number(r.max_attempts ?? 0), run_after: r.run_after,
    last_error: r.last_error ?? null, created_at: r.created_at,
    organizations: typeof r.organization_id === 'string' && names.has(r.organization_id) ? { name: names.get(r.organization_id)! } : null,
  }));

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
          ? <a className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft pointer-coarse:min-h-10" href="/platform/jobs">Show only jobs needing attention</a>
          : <a className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft pointer-coarse:min-h-10" href="/platform/jobs?status=all">Show all recent jobs</a>}
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
                          ? <span className="text-xs text-ink-muted [overflow-wrap:anywhere]" title={job.last_error}>{job.last_error.slice(0, 120)}</span>
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
