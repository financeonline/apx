import 'server-only';
import type { Db } from '@/db/types';
import { failInvestmentReport, finishInvestmentReport, startInvestmentReport } from '@/core/db/server-rpc';
import { UpstreamError, ValidationError } from '@/core/errors';
import { log } from '@/core/logging';
import type { ModelTransport } from '@/modules/ai';
import { assembleInvestmentReport } from '../domain/assemble';
import { buildInvestmentFigures } from '../domain/figures';
import type { InvestmentBase, InvestmentFigures } from '../domain/types';
import { findInFlightReport, loadAttempt, loadInvestmentSubject } from '../data/repository';
import { loadInvestmentBase } from './figures';
import { generateInvestmentNarrative } from './generate-narrative';

/**
 * `investment.generate` — writing the Investment Pack (ADR-171), exactly as `marketing.generate`
 * writes the marketing report (ADR-170).
 *
 * Queued by `api.request_investment_report`, with the attempt row it fills, in one transaction, and
 * run with the job's scoped client. One attempt, never retried by the queue: every attempt is a paid
 * model call, so a failure is recorded on the row in plain words and the person decides whether to
 * refresh.
 *
 *   1. `start_investment_report` moves the attempt to running — or says there is nothing to do (it
 *      already finished, or Investment was switched off after it was asked for).
 *   2. The organisation, its profile, the attempt's assumptions (the amount the analyst entered, if
 *      any) and the company's base year are read here, with the scoped client.
 *   3. APX works out every number (`buildInvestmentFigures`). No base year, or no surplus to allocate
 *      — no profit and no amount entered — fails the attempt here, BEFORE any model is called: there
 *      is nothing to write about, and nothing is spent finding that out.
 *   4. ChatGPT writes the words and chooses the options and the portfolio's shares.
 *   5. The pack is assembled — the cover date, the portfolio's amounts and the sources are decided
 *      here, never by the model — and stored with the tokens it cost, which count under the monthly
 *      AI ceiling.
 *
 * Whatever goes wrong after step 1, the attempt is failed with a sentence a person can act on. A
 * provider's own error text is never shown: an `UpstreamError` carries APX's sentence already; any
 * other failure is logged for us and shown as a plain "try again".
 */

/** Under the job's five-minute budget (`app.job_max_runtime`), so the attempt is failed, not lost. */
export const INVESTMENT_TIMEOUT_MS = 4 * 60_000;

/** What the person is shown when an attempt fails — UK English, and each says what to do next. */
export const INVESTMENT_FAILURES = {
  noFigures: 'APX holds no figures for this company yet. Add its accounts in Data & Forms, then create the pack again.',
  /** An amount entered that rounds to nothing in whole units (the pack's figures are whole units). */
  tooSmall: 'The amount entered to allocate is less than 1. Enter an amount of at least 1 and create the pack again.',
  /** An amount entered that APX's arithmetic could not read (the request's checks make this unlikely). */
  surplusUnreadable: 'APX could not read the amount entered to allocate. Enter it again and create the pack again.',
  draftRefused: 'The AI\'s draft did not pass APX\'s checks, so it was not kept. Refresh the pack to try again.',
  timedOut: 'Writing the pack took too long. Try again in a few minutes.',
  generic: 'The pack could not be written just now. Try again in a few minutes.',
} as const;

/** No profit in the base year, and no amount entered: the analyst says how much there is to allocate. */
export function noProfitFailure(yearLabel: string): string {
  return `APX shows no profit to invest for ${yearLabel}. Enter the amount to allocate and create the pack again.`;
}

export interface InvestmentReportDeps {
  readonly loadBase: (db: Db, orgId: string) => Promise<InvestmentBase | null>;
  readonly buildFigures: (base: InvestmentBase, options?: { surplus?: string | null }) => InvestmentFigures | null;
  readonly generateNarrative: typeof generateInvestmentNarrative;
  readonly now: () => Date;
  /** Handed to the writer when set — a test's recorded transport. Production leaves it unset. */
  readonly transport?: ModelTransport;
}

const LIVE: InvestmentReportDeps = {
  loadBase: loadInvestmentBase,
  buildFigures: buildInvestmentFigures,
  generateNarrative: generateInvestmentNarrative,
  now: () => new Date(),
};

export type InvestmentRunOutcome =
  | { readonly status: 'ready'; readonly reportId: string; readonly model: string; readonly inputTokens: number; readonly outputTokens: number }
  /** `failure` is what the person is shown; `detail` is for the job row and the log. */
  | { readonly status: 'failed'; readonly reportId: string; readonly failure: string; readonly detail: string }
  | { readonly status: 'skipped'; readonly reportId: string | null; readonly reason: string };

function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
}

/**
 * Writes one attempt at the pack. `reportId` is the attempt the job was queued for; without it, the
 * attempt in flight for the organisation (there is at most one). `deps` is the test seam.
 */
export async function runInvestmentReport(
  scoped: Db,
  orgId: string,
  reportId?: string,
  deps: Partial<InvestmentReportDeps> = {},
): Promise<InvestmentRunOutcome> {
  const d: InvestmentReportDeps = { ...LIVE, ...deps };
  const id = reportId ?? await findInFlightReport(scoped, orgId);
  if (id === null) return { status: 'skipped', reportId: null, reason: 'no investment pack is waiting to be written' };

  const started = await startInvestmentReport(orgId, id);
  if (started === null) return { status: 'skipped', reportId: id, reason: 'the pack already finished, or Investment is switched off' };

  // Tokens already spent when something fails after the model answered, so the row records the cost.
  let spent = { model: null as string | null, promptVersion: null as string | null, inputTokens: 0, outputTokens: 0 };
  const fail = async (failure: string, detail: string): Promise<InvestmentRunOutcome> => {
    try {
      await failInvestmentReport(orgId, id, { failure, ...spent });
    } catch (cause) {
      // The job's own end (app.investment_job_ended) fails the attempt if this write could not.
      log.error('investment pack failure could not be recorded', {
        organizationId: orgId, reportId: id, error: cause instanceof Error ? cause.message : String(cause),
      });
    }
    log.warn('investment pack failed', { organizationId: orgId, reportId: id, detail });
    return { status: 'failed', reportId: id, failure, detail };
  };

  try {
    const [subject, attempt] = await Promise.all([
      loadInvestmentSubject(scoped, orgId),
      loadAttempt(scoped, orgId, id),
    ]);
    if (subject === null) return await fail(INVESTMENT_FAILURES.generic, 'the organisation could not be read');
    if (attempt === null) return await fail(INVESTMENT_FAILURES.generic, 'the attempt could not be read');

    const base = await d.loadBase(scoped, orgId);
    if (base === null) return await fail(INVESTMENT_FAILURES.noFigures, 'no base year: the company holds no figures');
    // `buildInvestmentFigures` refuses an amount it cannot read (ValidationError); that is the amount's
    // fault, and the person is told so rather than "try again".
    let figures: InvestmentFigures | null;
    try {
      figures = d.buildFigures(base, { surplus: attempt.surplus });
    } catch (cause) {
      if (cause instanceof ValidationError) return await fail(INVESTMENT_FAILURES.surplusUnreadable, `the figures refused the amount: ${cause.message}`);
      throw cause;
    }
    if (figures === null) {
      // No surplus: the year made no profit and no amount was entered — or (which the request's
      // at-least-1 rule should prevent) the amount entered rounds to nothing in whole units.
      return attempt.surplus === null
        ? await fail(noProfitFailure(base.yearLabel), `no profit in ${base.yearLabel} and no amount entered`)
        : await fail(INVESTMENT_FAILURES.tooSmall, 'the amount entered rounds to nothing in whole units');
    }

    const result = await d.generateNarrative({
      organisationName: subject.name,
      profile: subject.profile,
      countryCode: subject.countryCode,
      figures,
      signal: AbortSignal.timeout(INVESTMENT_TIMEOUT_MS),
      ...(d.transport ? { transport: d.transport } : {}),
    });
    spent = { model: result.model, promptVersion: result.promptVersion, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    if (!result.ok) return await fail(INVESTMENT_FAILURES.draftRefused, `the draft was refused: ${result.reason}`);

    // `allocatePortfolio` refuses shares that do not add up to 100 (ValidationError): a draft that
    // slipped past the writer's checks is refused here like any other, with what it cost recorded.
    let report: ReturnType<typeof assembleInvestmentReport>;
    try {
      report = assembleInvestmentReport({
        organisationName: subject.name,
        timeZone: subject.timeZone,
        profile: subject.profile,
        figures,
        narrative: result.narrative,
        model: result.model,
        promptVersion: result.promptVersion,
        now: d.now(),
      });
    } catch (cause) {
      if (cause instanceof ValidationError) {
        const issues = cause.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
        return await fail(INVESTMENT_FAILURES.draftRefused, `the draft's portfolio could not be allocated: ${issues || cause.message}`);
      }
      throw cause;
    }
    await finishInvestmentReport(orgId, id, {
      report, model: result.model, promptVersion: result.promptVersion,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    });
    log.info('investment pack written', {
      organizationId: orgId, reportId: id, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    });
    return { status: 'ready', reportId: id, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  } catch (cause) {
    if (cause instanceof UpstreamError) return fail(cause.message, `the AI provider could not be used (${cause.provider})`);
    if (isTimeout(cause)) return fail(INVESTMENT_FAILURES.timedOut, 'the model call timed out');
    // The cause's own text stays in the operational log; the job row (read on /platform/jobs) and the
    // attempt carry only its kind and APX's sentence.
    log.error('investment pack could not be written', {
      organizationId: orgId, reportId: id, error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 300),
    });
    return fail(INVESTMENT_FAILURES.generic, `unexpected ${cause instanceof Error ? cause.name : 'error'}`);
  }
}
