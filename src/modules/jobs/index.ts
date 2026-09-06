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
