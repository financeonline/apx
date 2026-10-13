import { inflateRawSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
/*
 * Relative imports, as the other renderer tests: `motion/no-deep-module-import` (correctly) refuses
 * the `@/` deep path, and these files are tested on their own, without the module's services.
 */
import { renderMarketingDocx } from '../../src/modules/marketing/render/docx';
import { renderMarketingPdf } from '../../src/modules/marketing/render/pdf';
import {
  NOT_AVAILABLE, formatReportDate, formatReportMoney, formatReportPercent, formatShare, marketingFilename, shareWidth,
  withoutLead,
} from '../../src/modules/marketing/render/format';
import { MARKETING_AUTHORSHIP, MARKETING_AUTHORSHIP_OFFLINE, MARKETING_NOTICES, authorshipFor, presentMarketingReport, type ReportBlock } from '../../src/modules/marketing/render/present';
import { summariseMarketing } from '../../src/modules/marketing/render/summary';
import { tokenisePdf } from '../../src/modules/imports/domain/parsers/pdf-text';
import type { MarketingView } from '../../src/modules/marketing/domain/types';
import { SAMPLE_MARKETING_REPORT, SAMPLE_REPORT_WITHOUT_FIGURES } from '../fixtures/marketing/sample-report';

/**
 * The Marketing report's renderers (ADR-170): the shared presentation, the Word file and the PDF,
 * on the client's own Beara Beara document.
 */

/** One file out of a .docx (a zip), read from its central directory with nothing but zlib. */
function unzip(bytes: Uint8Array, name: string): string | null {
  const buf = Buffer.from(bytes);
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('not a zip: no end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('broken central directory');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const entry = buf.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (entry === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return (method === 0 ? data : inflateRawSync(data)).toString('utf8');
    }
    at += 46 + nameLength + extra + comment;
  }
  return null;
}

/** The visible text of a Word part: the runs' text, in order, entities decoded. */
function wordText(xml: string): string {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const tokens = await tokenisePdf(bytes);
  return tokens.pages.map((page) => page.lines.map((line) => line.text).join('\n'));
}

describe('the report formats its figures one way, everywhere', () => {
  it('shows money in the report currency, whole units, and an absent figure as a dash', () => {
    expect(formatReportMoney('1633422.00', 'GBP')).toBe('£1,633,422');
    expect(formatReportMoney('-5100.40', 'GBP')).toBe('−£5,100');
    expect(formatReportMoney('2500', 'USD')).toBe('$2,500');
    expect(formatReportMoney(null, 'GBP')).toBe(NOT_AVAILABLE);
    expect(formatReportMoney('n/a', 'GBP')).toBe('n/a');
  });

  it('reads the contract’s percent strings as percentages, not ratios', () => {
    expect(formatReportPercent('57.4')).toBe('57.4%');
    expect(formatReportPercent('-21.3')).toBe('−21.3%');
    expect(formatReportPercent('9.25')).toBe('9.3%');
    expect(formatReportPercent('0.0')).toBe('0.0%');
    expect(formatReportPercent(null)).toBe(NOT_AVAILABLE);
  });

  it('keeps whole shares whole, and turns a share into a safe bar width', () => {
    expect(formatShare('35')).toBe('35%');
    expect(formatShare('12.50')).toBe('12.5%');
    expect(shareWidth('35')).toBe('35%');
    expect(shareWidth('140')).toBe('100%');
    expect(shareWidth('-5')).toBeNull();
    expect(shareWidth('lots')).toBeNull();
  });

  it('dates in UTC, drops a lead the model already wrote, and names the file', () => {
    expect(formatReportDate('2026-10-13T23:30:00.000Z')).toBe('13 Oct 2026');
    expect(withoutLead('Strategic objective: grow.', 'Strategic objective')).toBe('grow.');
    expect(withoutLead('Grow the brand.', 'Strategic objective')).toBe('Grow the brand.');
    expect(withoutLead('recommended combination — use 01 and 02', 'Recommended combination')).toBe('use 01 and 02');
    expect(marketingFilename('beara-beara', '2026-10-13T09:30:00.000Z', 'docx')).toBe('apx-marketing-beara-beara-2026-10-13.docx');
    expect(marketingFilename('Odd Slug!', '2026-10-13T09:30:00.000Z', 'pdf')).toBe('apx-marketing-odd-slug-2026-10-13.pdf');
  });
});

describe('the presentation follows the client’s document', () => {
  const p = presentMarketingReport(SAMPLE_MARKETING_REPORT);
  const blocksOf = (id: string): ReportBlock[] => p.sections.flatMap((s) => s.subsections).find((x) => x.id === id)?.blocks.slice() ?? [];

  it('has the cover, the overview, the three sections and the sources, in that order', () => {
    expect(p.cover.title).toBe('MARKETING STRATEGY');
    expect(p.cover.strapline).toBe('LUXURY LEATHER ACCESSORIES  |  MARKETING & COMMERCIAL GROWTH STRATEGY');
    expect(p.cover.dateLine).toBe('Strategic planning report  •  October 2026');
    expect(p.cover.links.map((l) => l.label)).toEqual(['Website', 'Instagram']);
    expect(p.sections.map((s) => [s.label, s.title])).toEqual([
      [null, 'Executive overview'],
      ['SECTION 01', 'Competitor & sector profiling'],
      ['SECTION 02', 'Marketing & growth strategy'],
      ['SECTION 03', 'Financial overview & performance review'],
      [null, 'Source references'],
    ]);
    expect(p.sections[1]!.subsections.map((s) => s.number)).toEqual(['1.1', '1.2', '1.3']);
    expect(p.sections[2]!.subsections.map((s) => s.number)).toEqual(['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7']);
    expect(p.sections[3]!.subsections.map((s) => `${s.number ?? '-'} ${s.title}`)).toEqual([
      '3.1 Three-year performance',
      '3.2 Product-sector sales: 2025 vs 2026',
      '3.3 Marketing expenditure and cost efficiency',
      '3.4 Cost and margin review',
      '3.5 Financial management action plan',
      '- Financial conclusion and strategic recommendation',
    ]);
  });

  it('does not repeat a lead the model wrote, and carries the three notices', () => {
    const overview = p.sections[0]!.blocks[0];
    expect(overview).toMatchObject({ kind: 'paragraph', lead: 'Strategic objective:' });
    expect(overview?.kind === 'paragraph' && overview.text.startsWith('strengthen')).toBe(true);
    const notices = p.sections.flatMap((s) => [...s.blocks, ...s.subsections.flatMap((x) => x.blocks)])
      .filter((b) => b.kind === 'notice').map((b) => (b.kind === 'notice' ? b.title : ''));
    expect(notices).toEqual([MARKETING_NOTICES.competitors.title, MARKETING_NOTICES.budget.title, MARKETING_NOTICES.financials.title]);
  });

  it('formats the year table from the figures, and the shares as the document does', () => {
    const table = p.sections[3]!.blocks.find((b) => b.kind === 'table');
    expect(table?.kind === 'table' && table.table.columns).toEqual(['Financial indicator', '2024', '2025', '2026']);
    expect(table?.kind === 'table' && table.table.rows[0]!.map((c) => c.text)).toEqual(['Total turnover', '£1,633,422', '£895,231', '£704,530']);
    expect(table?.kind === 'table' && table.table.rows[2]!.map((c) => c.text)).toEqual(['Cost of sales / turnover', '57.4%', '46.4%', '54.0%']);
    const split = blocksOf('customer-sectors').find((b) => b.kind === 'split');
    expect(split?.kind === 'split' && split.shares.map((s) => `${s.label} ${s.share}`)).toEqual([
      'everyday fashion 35%', 'professional 25%', 'gifting 15%', 'vintage 15%', 'conscious consumption 10%',
    ]);
    const costs = blocksOf('cost-review')[0];
    expect(costs?.kind === 'table' && costs.table.rows[0]!.map((c) => c.text)).toEqual(['Transportation & distribution', '£79,086', 'Audit fulfilment cost by order and geography']);
  });

  it('marks a part year, and leaves out an indicator no year has', () => {
    const f = SAMPLE_MARKETING_REPORT.financials!;
    const partial = presentMarketingReport({
      ...SAMPLE_MARKETING_REPORT,
      financials: { ...f, years: f.years.map((y, i) => ({ ...y, partial: i === 2, adminCosts: null })) },
    });
    const table = partial.sections[3]!.blocks.find((b) => b.kind === 'table');
    expect(table?.kind === 'table' && table.table.columns).toEqual(['Financial indicator', '2024', '2025', '2026 *']);
    expect(table?.kind === 'table' && table.table.rows.map((r) => r[0]!.text)).not.toContain('Administrative costs');
    expect(partial.sections[3]!.blocks.some((b) => b.kind === 'note' && b.text.startsWith('* Part year'))).toBe(true);
  });

  it('keeps the numbering when the model leaves a part empty, and draws no empty table', () => {
    const r = SAMPLE_MARKETING_REPORT;
    const sparse = presentMarketingReport({
      ...r,
      narrative: {
        ...r.narrative,
        competitors: { ...r.narrative.competitors, competitors: [], effortSplit: [] },
        strategy: { ...r.narrative.strategy, retention: ['  '] },
      },
    });
    const s1 = sparse.sections[1]!;
    expect(s1.subsections.map((x) => x.number)).toEqual(['1.1', '1.2', '1.3']);
    expect(s1.subsections[1]!.blocks.some((b) => b.kind === 'table')).toBe(false);
    expect(s1.subsections[2]!.blocks.some((b) => b.kind === 'split')).toBe(false);
    expect(sparse.sections[2]!.subsections[2]!.blocks).toEqual([{ kind: 'note', text: 'Nothing was written for this part.' }]);
  });

  it('says there are no figures yet where Section 03 would be', () => {
    const none = presentMarketingReport(SAMPLE_REPORT_WITHOUT_FIGURES);
    const s3 = none.sections[3]!;
    expect(s3.subsections).toEqual([]);
    expect(s3.blocks).toEqual([{ kind: 'notice', tone: 'info', title: MARKETING_NOTICES.noFigures.title, text: MARKETING_NOTICES.noFigures.text }]);
    expect(none.hasFinancials).toBe(false);
  });
});

describe('renderMarketingDocx', () => {
  it('produces a Word file with the client’s sections, competitors and figures', async () => {
    const bytes = await renderMarketingDocx(SAMPLE_MARKETING_REPORT);
    expect(bytes.byteLength).toBeGreaterThan(5_000);
    expect(unzip(bytes, '[Content_Types].xml')).toContain('wordprocessingml.document.main+xml');

    const xml = unzip(bytes, 'word/document.xml');
    expect(xml).not.toBeNull();
    const text = wordText(xml!);
    for (const heading of [
      'MARKETING STRATEGY', 'Executive overview', 'SECTION 01', 'Competitor & sector profiling', 'SECTION 02',
      'Marketing & growth strategy', 'SECTION 03', 'Financial overview & performance review', 'Source references',
      '1.2', 'Comparable competitor benchmarks', '2.4', 'Alternative campaign concepts', '3.4', 'Cost and margin review',
    ]) expect(text, heading).toContain(heading);
    expect(text).toContain('Cambridge Satchel');
    expect(text).toContain('£1,633,422');
    expect(text).toContain('57.4%');
    expect(text).toContain('−21.9%');
    expect(text).toContain(MARKETING_NOTICES.competitors.title);
    // The table header row repeats on each page, and the bullets are a real Word list.
    expect(xml).toContain('<w:tblHeader');
    expect(xml).toContain('<w:numPr>');

    const headers = ['word/header1.xml', 'word/header2.xml', 'word/header3.xml'].map((n) => unzip(bytes, n)).filter((x): x is string => x !== null);
    expect(headers.map(wordText).join(' ')).toContain('Finance in motion');
    const footers = ['word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml'].map((n) => unzip(bytes, n)).filter((x): x is string => x !== null);
    expect(footers.join('')).toMatch(/PAGE/);
  });

  it('leaves Section 03 without tables, and says why, when there are no figures', async () => {
    const text = wordText(unzip(await renderMarketingDocx(SAMPLE_REPORT_WITHOUT_FIGURES), 'word/document.xml')!);
    expect(text).toContain('SECTION 03');
    expect(text).toContain(MARKETING_NOTICES.noFigures.title);
    expect(text).not.toContain('£1,633,422');
    expect(text).not.toContain('Three-year performance');
  });
});

describe('renderMarketingPdf', () => {
  it('produces a PDF of several pages, in the same order as the Word file', async () => {
    const bytes = await renderMarketingPdf(SAMPLE_MARKETING_REPORT);
    const doc = await PDFDocument.load(bytes);
    // The cover and overview, then each section on its own page — and the tables run over.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(4);
    expect(doc.getTitle()).toBe('Marketing strategy - Beara Beara Ltd - October 2026');

    const pages = await pdfText(bytes);
    const all = pages.join('\n');
    expect(pages[0]).toContain('MARKETING STRATEGY');
    expect(pages[0]).toContain('Executive overview');
    const order = ['SECTION 01', 'SECTION 02', 'SECTION 03', 'Source references'].map((h) => all.indexOf(h));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(all).toContain('Cambridge Satchel');
    expect(all).toContain('£1,633,422');
    expect(pages.every((page, i) => page.includes(`Page ${i + 1} of ${pages.length}`))).toBe(true);
    expect(pages.every((page) => page.includes('Finance in motion'))).toBe(true);
  });

  it('renders a report with no figures', async () => {
    const pages = await pdfText(await renderMarketingPdf(SAMPLE_REPORT_WITHOUT_FIGURES));
    const all = pages.join('\n');
    expect(all).toContain('No figures yet');
    expect(all).not.toContain('£1,633,422');
  });
});

describe('the Departments summary comes from the report’s real state', () => {
  const base: MarketingView = {
    organisationName: 'Beara Beara Ltd',
    profile: SAMPLE_MARKETING_REPORT.profile,
    profileReady: true,
    status: 'ready',
    report: SAMPLE_MARKETING_REPORT,
    failure: null,
    canRefresh: true,
    canEditProfile: true,
  };

  it('names the report date and the first three competitors when ready', () => {
    const s = summariseMarketing(base);
    expect(s).toMatchObject({ tone: 'good', label: 'Report ready 13 Oct 2026', asOf: '13 Oct 2026' });
    expect(s.competitors.map((c) => c.name)).toEqual(['Cambridge Satchel', 'O My Bag Amsterdam', 'SMAAK Amsterdam']);
    expect(s.competitors[0]?.positioning).toBe('direct heritage competitor');
  });

  it('says preparing, failed, no report, or fill in the profile — never a figure it does not have', () => {
    expect(summariseMarketing({ ...base, status: 'running' }).label).toBe('Preparing');
    expect(summariseMarketing({ ...base, status: 'queued', report: null }).competitors).toEqual([]);
    expect(summariseMarketing({ ...base, status: 'failed' })).toMatchObject({ tone: 'attention', label: 'Last attempt failed' });
    expect(summariseMarketing({ ...base, status: 'none', report: null })).toMatchObject({ tone: 'quiet', label: 'No report yet' });
    expect(summariseMarketing({ ...base, status: 'none', report: null, profileReady: false })).toMatchObject({ tone: 'attention', label: 'Fill in the company profile' });
  });
});

describe('who wrote it', () => {
  it('says ChatGPT for a report a model wrote, and the playbook for one written offline', () => {
    expect(authorshipFor(SAMPLE_MARKETING_REPORT)).toBe(MARKETING_AUTHORSHIP);
    expect(authorshipFor({ model: 'offline-template' })).toBe(MARKETING_AUTHORSHIP_OFFLINE);
    expect(presentMarketingReport({ ...SAMPLE_MARKETING_REPORT, model: 'offline-template' }).authorship).toBe(MARKETING_AUTHORSHIP_OFFLINE);
  });
});
