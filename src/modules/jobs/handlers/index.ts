import 'server-only';
import {
  finishCalculationRun, finishChunk, finishHealth, persistAlerts, setPeriodCompleteness,
  startCalculationRun,
} from '@/core/db';
import { log } from '@/core/logging';
import { registerJobHandler } from '../services/worker';
import type { ClaimedJob, JobOutcome } from '../domain/types';
import { runCalculationJob } from './calculation-run';
import { evaluateAlertsJob } from './alerts-evaluate';
import { commitLargeBatchJob } from './import-commit-large';
import { runOrgPurgeJob } from './org-purge';
import { runReportRenderJob } from './report-render';
import { runReportComposeJob } from './report-compose';
import { runFundingAssessJob } from './funding-assess';
import { runStorageCleanupJob } from './storage-cleanup';
import { runAiEvalJob } from './ai-eval';
import { runDocumentExtractJob } from './document-extract';
import { runMarketingGenerateJob } from './marketing-generate';
import { runInvestmentGenerateJob } from './investment-generate';

/**
 * Wiring the queue (ADR-013, IMPLEMENTATION_PLAN.md — "handlers arrive with the phases that own
 * them").
 *
 * Until this file existed, `registerJobHandler` was exported and never called: every job the system
 * queued was claimed, found no handler and failed. The engine, the health score and the alert
 * engine were all built and tested, and none of them could run — the cron drained the queue into
 * failures once a minute. That is the defect this module fixes, and the reason it is one file:
 * "which handlers exist" has to be answerable by reading a single list.
 *
 * Registration is a side effect of importing this module, and `/api/jobs/run` imports it. A handler
 * that is never registered fails loudly rather than silently succeeding, which is the behaviour the
 * worker was already written for.
 */

const HANDLERS: ReadonlyArray<readonly [ClaimedJob['jobType'], (job: ClaimedJob, scope: { db: unknown }) => Promise<JobOutcome>]> = [
  ['calculation.run', runCalculationJob],
  ['alerts.evaluate', evaluateAlertsJob],
  ['import.commit_large', commitLargeBatchJob],
  ['report.render', runReportRenderJob],
  ['report.compose', runReportComposeJob],
  ['funding.assess', runFundingAssessJob],
  ['storage.cleanup_orphans', runStorageCleanupJob],
  ['org.purge', runOrgPurgeJob],
  ['ai.eval', runAiEvalJob],
  ['document.extract', runDocumentExtractJob],
  // ADR-170: the marketing report, one paid attempt per request.
  ['marketing.generate', runMarketingGenerateJob],
  // ADR-171: the Investment Pack, one paid attempt per request.
  ['investment.generate', runInvestmentGenerateJob],
];

let registered = false;

/** Idempotent: importing this module twice must not re-register or double-run anything. */
export function registerJobHandlers(): void {
  if (registered) return;
  registered = true;
  for (const [type, handler] of HANDLERS) registerJobHandler(type, handler);
  log.info('job handlers registered', { types: HANDLERS.map(([type]) => type) });
}

registerJobHandlers();

/** The server calls the handlers share, in one place so a test can substitute them wholesale. */
export const serverCalls = {
  startCalculationRun,
  finishChunk,
  finishCalculationRun,
  setPeriodCompleteness,
  finishHealth,
  persistAlerts,
};

export { runCalculationJob, runTriggerRef } from './calculation-run';
export { runReportRenderJob } from './report-render';
export { runReportComposeJob } from './report-compose';
export { runFundingAssessJob } from './funding-assess';
export { runStorageCleanupJob, ORPHAN_GRACE_MS, MAX_REMOVALS_PER_RUN } from './storage-cleanup';
export { runOrgPurgeJob } from './org-purge';
export { evaluateAlertsJob } from './alerts-evaluate';
export { commitLargeBatchJob } from './import-commit-large';
export { runAiEvalJob, evalDeps } from './ai-eval';
export { runDocumentExtractJob, extractDeps, lineCountAgrees, AI_ROW_ISSUE, LINE_COUNT_ISSUE } from './document-extract';
export { runMarketingGenerateJob } from './marketing-generate';
export { runInvestmentGenerateJob } from './investment-generate';
