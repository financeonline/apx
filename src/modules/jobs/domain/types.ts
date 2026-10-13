/** Pure job types (DATABASE_ARCHITECTURE.md §9, ADR-043.3). */

export type JobType =
  | 'calculation.run' | 'document.extract' | 'import.commit_large' | 'alerts.evaluate'
  | 'org.purge' | 'report.render' | 'report.compose' | 'funding.assess' | 'ai.eval' | 'storage.cleanup_orphans'
  | 'snapshots.compact' | 'marketing.generate' | 'investment.generate';

export type JobStatus =
  | 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled' | 'deferred_upstream';

export interface ClaimedJob {
  readonly jobId: string;
  /** NULL for platform-level jobs. Every other job is scoped to this id, never to its payload. */
  readonly organizationId: string | null;
  readonly jobType: JobType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requestedBy: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface JobOutcome {
  readonly status: 'succeeded' | 'failed' | 'deferred_upstream';
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}
