import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { failMarketingReport, finishMarketingReport, startMarketingReport } from '@/core/db/server-rpc';
import { UpstreamError } from '@/core/errors';
import { log } from '@/core/logging';
import type { ModelTransport } from '@/modules/ai';
import { assembleMarketingReport } from '../domain/assemble';
import { profileIsReady, type MarketingFinancials } from '../domain/types';
import { findInFlightReport, loadMarketingSubject } from '../data/repository';
import { loadMarketingFinancials } from './financials';
import { generateMarketingNarrative } from './generate-narrative';

/**
 * `marketing.generate` — writing the marketing report (ADR-170).
 *
 * Queued by `api.request_marketing_report`, with the attempt row it fills, in one transaction, and run
 * with the job's scoped client. One attempt, never retried by the queue: every attempt is a paid model
 * call, so a failure is recorded on the row in plain words and the person decides whether to refresh.
 *
 *   1. `start_marketing_report` moves the attempt to running — or says there is nothing to do (it
 *      already finished, or Marketing was switched off after it was asked for).
 *   2. The organisation, its profile (re-checked: it may have been emptied since the request) and the
 *      product's own figures for Section 03 are read here, with the scoped client.
 *   3. The model writes Sections 01–02 and the Section 03 commentary from the profile and the figures.
 *   4. The report is assembled — the cover date and the sources are decided here, never by the model —
 *      and stored with the tokens it cost, which count under the monthly AI ceiling.
 *
 * Whatever goes wrong after step 1, the attempt is failed with a sentence a person can act on. A
 * provider's own error text is never shown: an `UpstreamError` carries APX's sentence already; any
 * other failure is logged for us and shown as a plain "try again".
 */

/** Under the job's five-minute budget (`app.job_max_runtime`), so the attempt is failed, not lost. */
export const MARKETING_TIMEOUT_MS = 4 * 60_000;

export const MARKETING_FAILURES = {
  profileNotReady: 'Add what the company sells, or its industry, to the company profile, then refresh the report.',
  draftRefused: 'The AI\'s draft did not pass APX\'s checks, so it was not kept. Refresh the report to try again.',
  timedOut: 'Writing the report took too long. Try again in a few minutes.',
  generic: 'The report could not be written just now. Try again in a few minutes.',
} as const;

export interface MarketingReportDeps {
  readonly loadFinancials: (db: SupabaseClient, orgId: string) => Promise<MarketingFinancials | null>;
  readonly generateNarrative: typeof generateMarketingNarrative;
  readonly now: () => Date;
  /** Handed to the writer when set — a test's recorded transport. Production leaves it unset. */
  readonly transport?: ModelTransport;
}

const LIVE: MarketingReportDeps = {
  loadFinancials: loadMarketingFinancials,
  generateNarrative: generateMarketingNarrative,
  now: () => new Date(),
};

export type MarketingRunOutcome =
  | { readonly status: 'ready'; readonly reportId: string; readonly model: string; readonly inputTokens: number; readonly outputTokens: number }
  /** `failure` is what the person is shown; `detail` is for the job row and the log. */
  | { readonly status: 'failed'; readonly reportId: string; readonly failure: string; readonly detail: string }
  | { readonly status: 'skipped'; readonly reportId: string | null; readonly reason: string };

function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
}

/**
 * Writes one attempt at the report. `reportId` is the attempt the job was queued for; without it, the
 * attempt in flight for the organisation (there is at most one). `deps` is the test seam.
 */
export async function runMarketingReport(
  scoped: SupabaseClient,
  orgId: string,
  reportId?: string,
  deps: Partial<MarketingReportDeps> = {},
): Promise<MarketingRunOutcome> {
  const d: MarketingReportDeps = { ...LIVE, ...deps };
  const id = reportId ?? await findInFlightReport(scoped, orgId);
  if (id === null) return { status: 'skipped', reportId: null, reason: 'no marketing report is waiting to be written' };

  const started = await startMarketingReport(orgId, id);
  if (started === null) return { status: 'skipped', reportId: id, reason: 'the report already finished, or Marketing is switched off' };

  // Tokens already spent when something fails after the model answered, so the row records the cost.
  let spent = { model: null as string | null, promptVersion: null as string | null, inputTokens: 0, outputTokens: 0 };
  const fail = async (failure: string, detail: string): Promise<MarketingRunOutcome> => {
    try {
      await failMarketingReport(orgId, id, { failure, ...spent });
    } catch (cause) {
      // The job's own end (app.marketing_job_ended) fails the attempt if this write could not.
      log.error('marketing report failure could not be recorded', {
        organizationId: orgId, reportId: id, error: cause instanceof Error ? cause.message : String(cause),
      });
    }
    log.warn('marketing report failed', { organizationId: orgId, reportId: id, detail });
    return { status: 'failed', reportId: id, failure, detail };
  };

  try {
    const subject = await loadMarketingSubject(scoped, orgId);
    if (subject === null) return await fail(MARKETING_FAILURES.generic, 'the organisation could not be read');
    if (!profileIsReady(subject.profile)) return await fail(MARKETING_FAILURES.profileNotReady, 'the company profile is not ready');

    const financials = await d.loadFinancials(scoped, orgId);
    const result = await d.generateNarrative({
      organisationName: subject.name,
      profile: subject.profile,
      currency: subject.currency,
      financials,
      signal: AbortSignal.timeout(MARKETING_TIMEOUT_MS),
      ...(d.transport ? { transport: d.transport } : {}),
    });
    spent = { model: result.model, promptVersion: result.promptVersion, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    if (!result.ok) return await fail(MARKETING_FAILURES.draftRefused, `the draft was refused: ${result.reason}`);

    const report = assembleMarketingReport({
      organisationName: subject.name,
      timeZone: subject.timeZone,
      profile: subject.profile,
      narrative: result.narrative,
      financials,
      model: result.model,
      promptVersion: result.promptVersion,
      now: d.now(),
    });
    await finishMarketingReport(orgId, id, {
      report, model: result.model, promptVersion: result.promptVersion,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    });
    log.info('marketing report written', {
      organizationId: orgId, reportId: id, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    });
    return { status: 'ready', reportId: id, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  } catch (cause) {
    if (cause instanceof UpstreamError) return fail(cause.message, `the AI provider could not be used (${cause.provider})`);
    if (isTimeout(cause)) return fail(MARKETING_FAILURES.timedOut, 'the model call timed out');
    // The cause's own text stays in the operational log; the job row (read on /platform/jobs) and the
    // attempt carry only its kind and APX's sentence.
    log.error('marketing report could not be written', {
      organizationId: orgId, reportId: id, error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 300),
    });
    return fail(MARKETING_FAILURES.generic, `unexpected ${cause instanceof Error ? cause.name : 'error'}`);
  }
}
