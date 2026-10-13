import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamError, ValidationError } from '@/core/errors';
import { MODULES, enabledModules } from '@/modules/tenancy';
import {
  INVESTMENT_FAILURES, INVESTMENT_REPORT_VERSION, assembleInvestmentReport, buildInvestmentSources, noProfitFailure,
  parseSurplusInput, runInvestmentReport, type InvestmentReportDeps,
} from '@/modules/investment';
import { SAMPLE_INVESTMENT_REPORT } from '../fixtures/investment/sample-report';

/**
 * ADR-171: the Investment Pack as the job puts it together — the amount the analyst types, the
 * sources, the cover date, the portfolio's amounts, and what the job does with each base year and each
 * answer the writer can give. No database and no model: the job's three writes and its reads are
 * replaced, and the base year and the narrative are fakes (the client's own example).
 */

const rpc = vi.hoisted(() => ({
  startInvestmentReport: vi.fn(),
  finishInvestmentReport: vi.fn(),
  failInvestmentReport: vi.fn(),
}));
vi.mock('@/core/db/server-rpc', async (importOriginal) => ({ ...(await importOriginal<object>()), ...rpc }));

const reads = vi.hoisted(() => ({ loadInvestmentSubject: vi.fn(), loadAttempt: vi.fn(), findInFlightReport: vi.fn() }));
vi.mock('@/modules/investment/data/repository', async (importOriginal) => ({ ...(await importOriginal<object>()), ...reads }));

const SAMPLE = SAMPLE_INVESTMENT_REPORT;
const NOW = new Date('2026-10-14T08:00:00.000Z');

describe('parseSurplusInput', () => {
  it('reads an amount as the analyst types it, to the penny', () => {
    expect(parseSurplusInput('')).toEqual({ ok: true, surplus: null });
    expect(parseSurplusInput('   ')).toEqual({ ok: true, surplus: null });
    expect(parseSurplusInput(null)).toEqual({ ok: true, surplus: null });
    expect(parseSurplusInput('95,000')).toEqual({ ok: true, surplus: '95000.00' });
    expect(parseSurplusInput('95000.50')).toEqual({ ok: true, surplus: '95000.50' });
    expect(parseSurplusInput('£95,000')).toEqual({ ok: true, surplus: '95000.00' });
    expect(parseSurplusInput(' 1,234,567.8 ')).toEqual({ ok: true, surplus: '1234567.80' });
    expect(parseSurplusInput('1000000000000')).toEqual({ ok: true, surplus: '1000000000000.00' });
    expect(parseSurplusInput('1')).toEqual({ ok: true, surplus: '1.00' });
  });

  it('refuses what is not a plain amount, less than one whole unit, or beyond any company\'s means', () => {
    for (const bad of ['abc', '9,5000', '95,00', '95000.505', '1e5', '-5', '95 000 pounds', '0x10', '.']) {
      const parsed = parseSurplusInput(bad);
      expect(parsed.ok, bad).toBe(false);
    }
    // The pack's figures are whole currency units: less than 1 would round to nothing to allocate.
    for (const small of ['0', '0.00', '0.40', '0.99']) {
      expect(parseSurplusInput(small), small).toEqual({ ok: false, message: 'Enter an amount of at least 1.' });
    }
    expect(parseSurplusInput('1000000000000.01')).toEqual({ ok: false, message: 'The amount to allocate must be 1,000,000,000,000 or less.' });
  });
});

describe('the pack as assembled', () => {
  it('lists the sources once each — the references, each option\'s own page, the website, then the figures', () => {
    const sources = buildInvestmentSources({
      organisationName: 'Northwind Trading Ltd',
      profile: SAMPLE.profile,
      narrative: {
        references: [...SAMPLE.narrative.references, { label: 'FCA again', url: 'http://fca.org.uk' }, { label: 'Not a page', url: 'javascript:alert(1)' }],
        options: SAMPLE.narrative.options,
      },
      sourceNote: SAMPLE.figures.base.sourceNote,
    });
    expect(sources.slice(0, SAMPLE.narrative.references.length)).toEqual(SAMPLE.narrative.references);
    // The same page written another way is listed once; a link that is not a web address is left out.
    expect(sources.filter((s) => s.url.includes('fca.org.uk'))).toHaveLength(1);
    expect(sources.some((s) => s.url.startsWith('javascript'))).toBe(false);
    // An option's page the references did not already name is added under the option's name.
    expect(sources).toContainEqual({ label: 'Growth shares & sector ETFs', url: 'https://www.ishares.com/uk/individual/en/products/etf-investments' });
    expect(sources.filter((s) => s.url.includes('dmo.gov.uk'))).toHaveLength(1);
    expect(sources.at(-2)).toEqual({ label: 'Northwind Trading Ltd website', url: 'https://www.northwind.example/' });
    // The figures' source is a sentence, last, with no link.
    expect(sources.at(-1)).toEqual({ label: SAMPLE.figures.base.sourceNote, url: '' });
  });

  it('has no figures source when there is no note, and no website when the profile has none', () => {
    const sources = buildInvestmentSources({
      organisationName: 'X', profile: { ...SAMPLE.profile, website: null }, narrative: { references: [], options: [] }, sourceNote: ' ',
    });
    expect(sources).toEqual([]);
  });

  it('is the contract\'s document: APX\'s figures, the writer\'s words, and the portfolio\'s amounts worked out by APX', () => {
    const report = assembleInvestmentReport({
      organisationName: 'Northwind Trading Ltd', timeZone: 'Europe/London', profile: SAMPLE.profile,
      figures: SAMPLE.figures, narrative: SAMPLE.narrative, model: 'gpt-test', promptVersion: 'investment-prompt-test', now: NOW,
    });
    expect(report).toMatchObject({
      version: INVESTMENT_REPORT_VERSION, organisationName: 'Northwind Trading Ltd', generatedAt: NOW.toISOString(),
      reportDate: 'October 2026', model: 'gpt-test', promptVersion: 'investment-prompt-test',
    });
    expect(report.figures).toBe(SAMPLE.figures);
    expect(report.narrative).toBe(SAMPLE.narrative);
    // The client's own table: £35,000 split 45/25/20/5/5.
    expect(report.portfolio).toEqual(SAMPLE.portfolio);
    expect(report.portfolio.map((p) => p.amount)).toEqual(['15750.00', '8750.00', '7000.00', '1750.00', '1750.00']);
  });

  it('dates the cover in the company\'s own time zone', () => {
    const lateOnTheLastDay = new Date('2026-10-31T22:30:00.000Z');
    const at = (timeZone: string) => assembleInvestmentReport({
      organisationName: 'X', timeZone, profile: SAMPLE.profile, figures: SAMPLE.figures, narrative: SAMPLE.narrative,
      model: 'm', promptVersion: 'p', now: lateOnTheLastDay,
    }).reportDate;
    expect(at('Europe/London')).toBe('October 2026');
    expect(at('Asia/Dubai')).toBe('November 2026');
  });
});

describe('runInvestmentReport', () => {
  const db = {} as never;
  const subject = {
    name: 'Northwind Trading Ltd', slug: 'northwind', currency: 'GBP', countryCode: 'GB', timeZone: 'Europe/London', profile: SAMPLE.profile,
  };
  const attempt = (surplus: string | null) => ({
    id: 'report-1', status: 'running', failure: null, surplus, createdAt: NOW.toISOString(), finishedAt: null,
  });
  const usage = { model: 'gpt-test', promptVersion: 'investment-prompt-test', inputTokens: 1200, outputTokens: 3400 };
  let deps: Partial<InvestmentReportDeps>;
  let generate: ReturnType<typeof vi.fn>;
  let loadBase: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    rpc.startInvestmentReport.mockResolvedValue('report-1');
    rpc.finishInvestmentReport.mockResolvedValue(undefined);
    rpc.failInvestmentReport.mockResolvedValue(undefined);
    reads.loadInvestmentSubject.mockResolvedValue(subject);
    reads.loadAttempt.mockResolvedValue(attempt('100000.00'));
    reads.findInFlightReport.mockResolvedValue('report-1');
    generate = vi.fn().mockResolvedValue({ ok: true, narrative: SAMPLE.narrative, ...usage });
    loadBase = vi.fn().mockResolvedValue(SAMPLE.figures.base);
    // The real `buildInvestmentFigures`: the job's arithmetic is APX's, and the example's is known.
    deps = { loadBase, generateNarrative: generate as unknown as InvestmentReportDeps['generateNarrative'], now: () => NOW };
  });

  it('builds the figures on the amount the analyst entered, has ChatGPT write the words, and stores the pack with its cost', async () => {
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toEqual({ status: 'ready', reportId: 'report-1', model: 'gpt-test', inputTokens: 1200, outputTokens: 3400 });

    expect(loadBase).toHaveBeenCalledWith(db, 'org-1');
    const input = generate.mock.calls[0]![0];
    expect(input).toMatchObject({ organisationName: 'Northwind Trading Ltd', profile: SAMPLE.profile, countryCode: 'GB' });
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(input.figures.assumptions).toMatchObject({ surplus: '100000.00', surplusSource: 'analyst' });
    expect(input.figures.allocation.external).toEqual({ percent: '35', amount: '35000.00' });

    const [org, id, stored] = rpc.finishInvestmentReport.mock.calls[0]!;
    expect([org, id]).toEqual(['org-1', 'report-1']);
    expect(stored).toMatchObject({ model: 'gpt-test', promptVersion: 'investment-prompt-test', inputTokens: 1200, outputTokens: 3400 });
    expect(stored.report).toMatchObject({ version: INVESTMENT_REPORT_VERSION, reportDate: 'October 2026', organisationName: 'Northwind Trading Ltd' });
    expect(stored.report.figures).toBe(input.figures);
    expect(stored.report.portfolio.map((p: { amount: string }) => p.amount)).toEqual(['15750.00', '8750.00', '7000.00', '1750.00', '1750.00']);
    expect(stored.report.sources.at(-1)).toEqual({ label: SAMPLE.figures.base.sourceNote, url: '' });
    expect(rpc.failInvestmentReport).not.toHaveBeenCalled();
  });

  it('allocates the base year\'s net profit when no amount was entered', async () => {
    reads.loadAttempt.mockResolvedValue(attempt(null));
    const buildFigures = vi.fn().mockReturnValue(SAMPLE.figures);
    await runInvestmentReport(db, 'org-1', 'report-1', { ...deps, buildFigures });
    expect(buildFigures).toHaveBeenCalledWith(SAMPLE.figures.base, { surplus: null });
    expect(rpc.finishInvestmentReport).toHaveBeenCalledOnce();
  });

  it('finds the attempt in flight when the job names none', async () => {
    await runInvestmentReport(db, 'org-1', undefined, deps);
    expect(rpc.startInvestmentReport).toHaveBeenCalledWith('org-1', 'report-1');
    expect(reads.loadAttempt).toHaveBeenCalledWith(db, 'org-1', 'report-1');
  });

  it('does nothing when the attempt already finished or Investment was switched off', async () => {
    rpc.startInvestmentReport.mockResolvedValue(null);
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(outcome.status).toBe('skipped');
    expect(loadBase).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(rpc.finishInvestmentReport).not.toHaveBeenCalled();
    expect(rpc.failInvestmentReport).not.toHaveBeenCalled();
  });

  it('fails without calling the model when APX holds no figures for the company', async () => {
    loadBase.mockResolvedValue(null);
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.noFigures });
    expect(INVESTMENT_FAILURES.noFigures).toMatch(/^APX holds no figures for this company yet\./);
    expect(generate).not.toHaveBeenCalled();
    expect(rpc.failInvestmentReport).toHaveBeenCalledWith('org-1', 'report-1', expect.objectContaining({ failure: INVESTMENT_FAILURES.noFigures, inputTokens: 0 }));
  });

  it('fails without calling the model when the base year shows no profit and no amount was entered', async () => {
    reads.loadAttempt.mockResolvedValue(attempt(null));
    loadBase.mockResolvedValue({ ...SAMPLE.figures.base, netProfit: '-12000.00', netMarginPct: '-1.2' });
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(noProfitFailure('2026')).toBe('APX shows no profit to invest for 2026. Enter the amount to allocate and create the pack again.');
    expect(outcome).toMatchObject({ status: 'failed', failure: noProfitFailure('2026') });
    expect(generate).not.toHaveBeenCalled();
    expect(rpc.finishInvestmentReport).not.toHaveBeenCalled();
  });

  it('builds the pack on an amount the analyst entered even when the year shows no profit', async () => {
    loadBase.mockResolvedValue({ ...SAMPLE.figures.base, netProfit: '-12000.00', netMarginPct: '-1.2' });
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(outcome.status).toBe('ready');
  });

  it('says so when an amount below 1 reaches the job (the request refuses one; a direct write could not)', async () => {
    reads.loadAttempt.mockResolvedValue(attempt('0.40'));
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.tooSmall });
    expect(generate).not.toHaveBeenCalled();
  });

  it('tells the person when APX\'s arithmetic cannot read the amount entered, without calling the model', async () => {
    const buildFigures = vi.fn(() => { throw new ValidationError('That amount could not be read.'); });
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', { ...deps, buildFigures });
    expect(outcome).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.surplusUnreadable });
    expect(generate).not.toHaveBeenCalled();
  });

  it('refuses a draft whose portfolio shares do not add up to 100, and records what it cost', async () => {
    const portfolio = SAMPLE.narrative.portfolio.map((p, i) => (i === 0 ? { ...p, percent: '40' } : p));
    generate.mockResolvedValue({ ok: true, narrative: { ...SAMPLE.narrative, portfolio }, ...usage });
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.draftRefused });
    expect(outcome.status === 'failed' && outcome.detail).toMatch(/portfolio/);
    expect(rpc.failInvestmentReport).toHaveBeenCalledWith('org-1', 'report-1', expect.objectContaining({ inputTokens: 1200, outputTokens: 3400 }));
    expect(rpc.finishInvestmentReport).not.toHaveBeenCalled();
  });

  it('keeps a draft the writer refused out of the pack, records what it cost, and shows a plain sentence', async () => {
    generate.mockResolvedValue({ ok: false, reason: 'portfolio: shares add up to 95', ...usage });
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.draftRefused });
    expect(rpc.failInvestmentReport).toHaveBeenCalledWith('org-1', 'report-1', {
      failure: INVESTMENT_FAILURES.draftRefused, model: 'gpt-test', promptVersion: 'investment-prompt-test', inputTokens: 1200, outputTokens: 3400,
    });
    expect(rpc.finishInvestmentReport).not.toHaveBeenCalled();
  });

  it('shows the provider\'s outage in APX\'s own words', async () => {
    generate.mockRejectedValue(new UpstreamError('openai', 'ChatGPT could not be reached to write the Investment Pack. Try again in a few minutes.'));
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: 'ChatGPT could not be reached to write the Investment Pack. Try again in a few minutes.' });
    expect(rpc.failInvestmentReport).toHaveBeenCalledWith('org-1', 'report-1', expect.objectContaining({ inputTokens: 0, outputTokens: 0 }));
  });

  it('says the writing took too long when the model call times out', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    generate.mockRejectedValue(timeout);
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.timedOut });
  });

  it('never shows an unexpected error\'s own text', async () => {
    generate.mockRejectedValue(new Error('401 Incorrect API key provided: sk-proj-****abcd'));
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.generic, detail: 'unexpected Error' });
    expect(JSON.stringify(rpc.failInvestmentReport.mock.calls)).not.toContain('sk-proj');
  });

  it('fails the attempt when the finished pack cannot be stored, recording what it cost', async () => {
    rpc.finishInvestmentReport.mockRejectedValue(new Error('connection reset'));
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.generic });
    expect(rpc.failInvestmentReport).toHaveBeenCalledWith('org-1', 'report-1', expect.objectContaining({ inputTokens: 1200, outputTokens: 3400 }));
  });

  it('still reports the failure when the failure itself cannot be recorded (the job\'s end fails the attempt)', async () => {
    loadBase.mockResolvedValue(null);
    rpc.failInvestmentReport.mockRejectedValue(new Error('connection reset'));
    const outcome = await runInvestmentReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: INVESTMENT_FAILURES.noFigures });
  });
});

describe('the Investment switch', () => {
  it('is on for every company unless the super admin switches it off', () => {
    expect(MODULES.find((m) => m.key === 'investment')).toMatchObject({
      label: 'Investment', featureKey: 'module_investment', defaultOn: true,
      description: 'The Investment Pack: surplus allocation, growth and investment scenarios.',
    });
    expect(enabledModules({}).has('investment')).toBe(true);
    expect(enabledModules({ module_investment: false }).has('investment')).toBe(false);
  });
});
