import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '@/core/errors';
import { MODULES, enabledModules } from '@/modules/tenancy';
import {
  MARKETING_FAILURES, MARKETING_REPORT_VERSION, assembleMarketingReport, buildSources, normaliseUrl, parseCompanyProfile,
  reportDateLabel, runMarketingReport, type MarketingReportDeps,
} from '@/modules/marketing';
import { SAMPLE_MARKETING_REPORT } from '../fixtures/marketing/sample-report';

/**
 * ADR-170: the marketing report as the job puts it together — the profile as typed, the sources, the
 * cover date, and what the job does with each answer the writer can give. No database and no model:
 * the job's three writes and its two reads are replaced, and the figures and the narrative are fakes.
 */

const rpc = vi.hoisted(() => ({
  startMarketingReport: vi.fn(),
  finishMarketingReport: vi.fn(),
  failMarketingReport: vi.fn(),
}));
vi.mock('@/core/db/server-rpc', async (importOriginal) => ({ ...(await importOriginal<object>()), ...rpc }));

const reads = vi.hoisted(() => ({ loadMarketingSubject: vi.fn(), findInFlightReport: vi.fn() }));
vi.mock('@/modules/marketing/data/repository', async (importOriginal) => ({ ...(await importOriginal<object>()), ...reads }));

const SAMPLE = SAMPLE_MARKETING_REPORT;
const NOW = new Date('2026-10-14T08:00:00.000Z');

describe('normaliseUrl', () => {
  it('adds https:// to a bare domain and keeps what was typed otherwise', () => {
    expect(normaliseUrl('bearabeara.co.uk')).toBe('https://bearabeara.co.uk');
    expect(normaliseUrl('  www.instagram.com/beara_beara/ ')).toBe('https://www.instagram.com/beara_beara/');
    expect(normaliseUrl('http://example.com/shop?x=1')).toBe('http://example.com/shop?x=1');
  });

  it('refuses anything that is not a web address', () => {
    for (const bad of ['javascript:alert(1)', 'mailto:hello@example.com', 'ftp://example.com', 'not a url', 'example', '', '   ', null]) {
      expect(normaliseUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('parseCompanyProfile', () => {
  it('drops blank rows, names a link from its address, and turns blanks into "not given"', () => {
    const parsed = parseCompanyProfile({
      website: 'bearabeara.co.uk',
      socialLinks: [{ label: '', url: 'instagram.com/beara_beara' }, { label: ' ', url: '' }, { label: 'Shop', url: 'https://shop.example.com' }],
      productsServices: ' Luxury leather bags ', industry: '', description: '   ',
    });
    expect(parsed).toEqual({
      ok: true,
      profile: {
        website: 'https://bearabeara.co.uk',
        socialLinks: [{ label: 'Instagram', url: 'https://instagram.com/beara_beara' }, { label: 'Shop', url: 'https://shop.example.com' }],
        productsServices: 'Luxury leather bags', industry: null, description: null,
      },
    });
  });

  it('lists every problem by the field the form shows', () => {
    const parsed = parseCompanyProfile({
      website: 'javascript:alert(1)',
      socialLinks: [{ label: 'Instagram', url: '' }, { label: 'TikTok', url: 'not an address' }],
      industry: 'x'.repeat(121),
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((i) => i.path)).toEqual(['Website', 'Social link 1', 'Social link 2', 'Industry']);
    expect(parsed.issues[1]!.message).toBe('Add the address for Instagram.');
  });

  it('holds a profile to twelve social links', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ label: `L${i}`, url: `https://example.com/${i}` }));
    const parsed = parseCompanyProfile({ socialLinks: many });
    expect(parsed.ok).toBe(false);
  });
});

describe('the report as assembled', () => {
  it('dates the cover in the company\'s own time zone', () => {
    const lateOnTheLastDay = new Date('2026-10-31T22:30:00.000Z');
    expect(reportDateLabel(lateOnTheLastDay, 'Europe/London')).toBe('October 2026');
    expect(reportDateLabel(lateOnTheLastDay, 'Asia/Dubai')).toBe('November 2026');
    expect(reportDateLabel(lateOnTheLastDay, 'Not/AZone')).toBe('October 2026');
  });

  it('lists the sources once each — the company, its social pages, the competitors, then the figures', () => {
    const sources = buildSources({
      organisationName: 'Beara Beara Ltd',
      profile: { ...SAMPLE.profile, socialLinks: [...SAMPLE.profile.socialLinks, { label: 'Instagram again', url: 'http://instagram.com/beara_beara' }] },
      competitors: [
        ...SAMPLE.narrative.competitors.competitors,
        { name: 'Copycat', positioning: 'x', learning: 'y', website: 'https://bearabeara.co.uk', social: '@copycat' },
      ],
      financials: SAMPLE.financials,
    });
    expect(sources[0]).toEqual({ label: 'Beara Beara Ltd website', url: 'https://www.bearabeara.co.uk/' });
    expect(sources[1]).toEqual({ label: 'Beara Beara Ltd on Instagram', url: 'https://www.instagram.com/beara_beara/' });
    // The same page written another way is not listed twice; a handle is not a link.
    expect(sources.filter((s) => s.url.includes('instagram.com/beara_beara'))).toHaveLength(1);
    expect(sources.some((s) => s.label.startsWith('Copycat'))).toBe(false);
    expect(sources).toContainEqual({ label: 'Cambridge Satchel website', url: 'https://cambridgesatchel.com' });
    expect(sources).toContainEqual({ label: 'Cambridge Satchel on Instagram', url: 'https://instagram.com/cambridge_satchel/' });
    // The figures' source is a sentence, last, with no link.
    expect(sources.at(-1)).toEqual({ label: SAMPLE.financials!.sourceNote, url: '' });
  });

  it('has no figures source when there are no figures', () => {
    const sources = buildSources({ organisationName: 'X', profile: SAMPLE.profile, competitors: [], financials: null });
    expect(sources.every((s) => s.url !== '')).toBe(true);
  });

  it('is the contract\'s document, with the writer\'s model and the product\'s figures', () => {
    const report = assembleMarketingReport({
      organisationName: 'Beara Beara Ltd', timeZone: 'Europe/London', profile: SAMPLE.profile, narrative: SAMPLE.narrative,
      financials: SAMPLE.financials, model: 'gpt-test', promptVersion: 'marketing-prompt-test', now: NOW,
    });
    expect(report).toMatchObject({
      version: MARKETING_REPORT_VERSION, organisationName: 'Beara Beara Ltd', generatedAt: NOW.toISOString(),
      reportDate: 'October 2026', model: 'gpt-test', promptVersion: 'marketing-prompt-test',
    });
    expect(report.narrative).toBe(SAMPLE.narrative);
    expect(report.financials).toBe(SAMPLE.financials);
  });
});

describe('runMarketingReport', () => {
  const db = {} as never;
  const subject = { name: 'Beara Beara Ltd', currency: 'GBP', timeZone: 'Europe/London', profile: SAMPLE.profile };
  const usage = { model: 'gpt-test', promptVersion: 'marketing-prompt-test', inputTokens: 1200, outputTokens: 3400 };
  let deps: MarketingReportDeps;
  let generate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    rpc.startMarketingReport.mockResolvedValue('report-1');
    rpc.finishMarketingReport.mockResolvedValue(undefined);
    rpc.failMarketingReport.mockResolvedValue(undefined);
    reads.loadMarketingSubject.mockResolvedValue(subject);
    reads.findInFlightReport.mockResolvedValue('report-1');
    generate = vi.fn().mockResolvedValue({ ok: true, narrative: SAMPLE.narrative, ...usage });
    deps = {
      loadFinancials: vi.fn().mockResolvedValue(SAMPLE.financials),
      generateNarrative: generate as unknown as MarketingReportDeps['generateNarrative'],
      now: () => NOW,
    };
  });

  it('writes the narrative from the profile and the figures, and stores the assembled report with its cost', async () => {
    const outcome = await runMarketingReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toEqual({ status: 'ready', reportId: 'report-1', model: 'gpt-test', inputTokens: 1200, outputTokens: 3400 });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      organisationName: 'Beara Beara Ltd', profile: SAMPLE.profile, currency: 'GBP', financials: SAMPLE.financials,
    }));
    expect(generate.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    const [org, id, stored] = rpc.finishMarketingReport.mock.calls[0]!;
    expect([org, id]).toEqual(['org-1', 'report-1']);
    expect(stored).toMatchObject({ model: 'gpt-test', promptVersion: 'marketing-prompt-test', inputTokens: 1200, outputTokens: 3400 });
    expect(stored.report).toMatchObject({ version: MARKETING_REPORT_VERSION, reportDate: 'October 2026', financials: SAMPLE.financials });
    expect(stored.report.sources.at(-1).url).toBe('');
    expect(rpc.failMarketingReport).not.toHaveBeenCalled();
  });

  it('finds the attempt in flight when the job names none', async () => {
    await runMarketingReport(db, 'org-1', undefined, deps);
    expect(rpc.startMarketingReport).toHaveBeenCalledWith('org-1', 'report-1');
  });

  it('does nothing when the attempt already finished or Marketing was switched off', async () => {
    rpc.startMarketingReport.mockResolvedValue(null);
    const outcome = await runMarketingReport(db, 'org-1', 'report-1', deps);
    expect(outcome.status).toBe('skipped');
    expect(generate).not.toHaveBeenCalled();
    expect(rpc.finishMarketingReport).not.toHaveBeenCalled();
    expect(rpc.failMarketingReport).not.toHaveBeenCalled();
  });

  it('fails without calling the model when the profile has since been emptied', async () => {
    reads.loadMarketingSubject.mockResolvedValue({ ...subject, profile: { ...SAMPLE.profile, productsServices: ' ', industry: null } });
    const outcome = await runMarketingReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: MARKETING_FAILURES.profileNotReady });
    expect(generate).not.toHaveBeenCalled();
    expect(rpc.failMarketingReport).toHaveBeenCalledWith('org-1', 'report-1', expect.objectContaining({ failure: MARKETING_FAILURES.profileNotReady, inputTokens: 0 }));
  });

  it('keeps a draft the writer refused out of the report, records what it cost, and shows a plain sentence', async () => {
    generate.mockResolvedValue({ ok: false, reason: 'competitors: 2 given, 3 to 6 needed', ...usage });
    const outcome = await runMarketingReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: MARKETING_FAILURES.draftRefused });
    expect(rpc.failMarketingReport).toHaveBeenCalledWith('org-1', 'report-1', {
      failure: MARKETING_FAILURES.draftRefused, model: 'gpt-test', promptVersion: 'marketing-prompt-test', inputTokens: 1200, outputTokens: 3400,
    });
    expect(rpc.finishMarketingReport).not.toHaveBeenCalled();
  });

  it('shows the provider\'s outage in APX\'s own words', async () => {
    generate.mockRejectedValue(new UpstreamError('openai', 'ChatGPT could not be reached to write the marketing report. Try again in a few minutes.'));
    const outcome = await runMarketingReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: 'ChatGPT could not be reached to write the marketing report. Try again in a few minutes.' });
    expect(rpc.failMarketingReport).toHaveBeenCalledWith('org-1', 'report-1', expect.objectContaining({ inputTokens: 0, outputTokens: 0 }));
  });

  it('never shows an unexpected error\'s own text', async () => {
    generate.mockRejectedValue(new Error('401 Incorrect API key provided: sk-proj-****abcd'));
    const outcome = await runMarketingReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: MARKETING_FAILURES.generic, detail: 'unexpected Error' });
    expect(JSON.stringify(rpc.failMarketingReport.mock.calls)).not.toContain('sk-proj');
  });

  it('fails the attempt when the finished report cannot be stored', async () => {
    rpc.finishMarketingReport.mockRejectedValue(new Error('connection reset'));
    const outcome = await runMarketingReport(db, 'org-1', 'report-1', deps);
    expect(outcome).toMatchObject({ status: 'failed', failure: MARKETING_FAILURES.generic });
    expect(rpc.failMarketingReport).toHaveBeenCalledWith('org-1', 'report-1', expect.objectContaining({ inputTokens: 1200, outputTokens: 3400 }));
  });
});

describe('the Marketing switch', () => {
  it('is on for every company unless the super admin switches it off', () => {
    expect(MODULES.find((m) => m.key === 'marketing')).toMatchObject({ featureKey: 'module_marketing', defaultOn: true });
    expect(enabledModules({}).has('marketing')).toBe(true);
    expect(enabledModules({ module_marketing: false }).has('marketing')).toBe(false);
  });
});
