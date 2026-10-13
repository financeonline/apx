/**
 * The job queue and its worker (DATABASE_ARCHITECTURE.md §9).
 *
 * Handlers register themselves from the phase that owns them; this module owns claiming, scoping,
 * retry and outcome recording, and nothing about what any particular job does.
 */
export { drainJobs, registerJobHandler, type DrainResult, type JobHandler } from './services/worker';
export type { ClaimedJob, JobOutcome, JobStatus, JobType } from './domain/types';

/**
 * Importing this registers every handler the built phases own (ADR-057.1).
 *
 * The import is the registration: a module that is never imported registers nothing, which is
 * precisely how the queue came to drain into failures for five phases.
 */
export { registerJobHandlers, serverCalls } from './handlers';

/**
 * The orphan sweep is exported by name as well as registered, because its two constants ARE its
 * safety argument: a test that hard-coded "24 hours" would still pass if somebody shortened the
 * grace period to a minute.
 */
export {
  runStorageCleanupJob, ORPHAN_GRACE_MS, MAX_REMOVALS_PER_RUN,
} from './handlers';

/** The purge is exported by name so a test can drive it with a claimed job, as the worker does. */
export { runOrgPurgeJob, runTriggerRef } from './handlers';

/** ADR-170: the marketing report's job, by name, so a test can drive it as the worker does. */
export { runMarketingGenerateJob } from './handlers';

/** The ai.eval handler's one seam, for its own test: the model transport (ADR-081). */
export { evalDeps } from './handlers';
export { extractDeps, lineCountAgrees, AI_ROW_ISSUE, LINE_COUNT_ISSUE } from './handlers';
