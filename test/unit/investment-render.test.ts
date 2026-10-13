import { inflateRawSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
/*
 * Relative imports, as the other renderer tests: `motion/no-deep-module-import` (correctly) refuses
 * the `@/` deep path, and these files are tested on their own, without the module's services.
 */
import { renderInvestmentDocx } from '../../src/modules/investment/render/docx';
import { renderInvestmentPdf } from '../../src/modules/investment/render/pdf';
import {
  approximateMoney, investmentFilename, moneyAxis, percentText, rangeText, riskIndex, riskLabel,
} from '../../src/modules/investment/render/format';
import {
  INVESTMENT_AUTHORSHIP, INVESTMENT_AUTHORSHIP_OFFLINE, INVESTMENT_NOTICES, investmentAuthorshipFor, presentInvestmentReport,
  presentInvestmentStart, type PackBlock, type PresentedChart,
} from '../../src/modules/investment/render/present';
import { summariseInvestment } from '../../src/modules/investment/render/summary';
import { tokenisePdf } from '../../src/modules/imports/domain/parsers/pdf-text';
import { INVESTMENT_DISCLAIMER, type InvestmentView } from '../../src/modules/investment/domain/types';
import { SAMPLE_INVESTMENT_REPORT, SAMPLE_PACK_WITHOUT_OPTIONALS } from '../fixtures/investment/sample-report';

/**
 * The Investment Pack's renderers (ADR-171): the shared presentation, the Word file, the PDF and the
 * Departments line, on the client's own example pack.
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

const allBlocks = (p: ReturnType<typeof presentInvestmentReport>): PackBlock[] =>
  p.sections.flatMap((s) => [...s.blocks, ...s.subsections.flatMap((x) => x.blocks)]);
const charts = (p: ReturnType<typeof presentInvestmentReport>): PresentedChart[] =>
  allBlocks(p).flatMap((b) => (b.kind === 'chart' ? [b.chart] : []));

describe('the pack formats its figures one way, everywhere', () => {
  it('writes shares, ranges, rounded amounts and risk levels as the client’s document does', () => {
    expect(percentText('45')).toBe('45%');
    expect(percentText('15.0')).toBe('15%');
    expect(percentText('14.6')).toBe('14.6%');
    expect(rangeText(['20', '35', '50'])).toBe('20–50%');
    expect(rangeText(['20', '20', '20'])).toBe('20%');
    expect(approximateMoney('311040.00', 'GBP')).toBe('£311,000');
    expect(riskLabel('low_medium')).toBe('Low–medium risk');
    expect(riskIndex('lower')).toBe(0);
    expect(riskIndex('very_high')).toBe(5);
  });

  it('draws a money axis from zero to a round figure above the highest value', () => {
    const axis = moneyAxis(5_062_500, 'GBP');
    expect(axis.ticks[0]).toEqual({ value: 0, label: '£0' });
    expect(axis.max).toBeGreaterThanOrEqual(5_062_500);
    expect(axis.ticks.at(-1)?.label).toBe('£6,000,000');
    expect(moneyAxis(0, 'GBP').ticks.length).toBeGreaterThan(1);
  });

  it('names the file', () => {
    expect(investmentFilename('northwind', '2026-10-14T09:30:00.000Z', 'docx')).toBe('apx-investment-northwind-2026-10-14.docx');
    expect(investmentFilename('Odd Slug!', '2026-10-14T09:30:00.000Z', 'pdf')).toBe('apx-investment-odd-slug-2026-10-14.pdf');
  });
});

describe('the presentation follows the client’s document', () => {
  const p = presentInvestmentReport(SAMPLE_INVESTMENT_REPORT);

  it('has the cover the client’s pack opens with', () => {
    expect(p.documentTitle).toBe('Investment pack - Northwind Trading Ltd - October 2026');
    expect(p.cover.dateLine).toBe('INVESTMENT PACK  |  OCTOBER 2026');
    expect(p.cover.strapline).toBe('A visual investment pack  |  Capital allocation • Business reinvestment • Diversified investments');
    // The lead the model wrote is not said twice.
    expect(p.cover.objective.startsWith('Convert the company’s achieved 20%')).toBe(true);
    expect(p.cover.headlines).toEqual([
      { label: 'CORE BUSINESS', figure: '20–50%', text: 'annual revenue growth ambition' },
      { label: 'EXTERNAL INVESTMENTS', figure: '10%', text: 'illustrative long-term annual return target (not guaranteed)' },
    ]);
    expect(p.cover.basis).toBe('Based on 2026: revenue £1,000,000; net profit £150,000 (15% net margin).');
  });

  it('has the sections in the document’s order and numbering', () => {
    expect(p.sections.map((s) => [s.label, s.title])).toEqual([
      [null, 'Executive capital allocation'],
      ['01', 'Converting growth into surplus capital'],
      ['02', 'Reinvesting in the core business'],
      ['03', 'External investment opportunities'],
      [null, 'Capital allocation process'],
      ['04', 'Governance and investment controls'],
      ['05', 'Investment committee recommendation'],
      [null, 'Reference links'],
    ]);
    expect(p.sections[3]!.subsections.map((s) => s.title)).toEqual([
      'Relative risk positioning', 'Diversified external portfolio', 'Five-year investment return scenarios', 'Reinvest or invest: the comparison',
    ]);
    const options = p.sections[3]!.blocks.find((b) => b.kind === 'options');
    expect(options?.kind === 'options' && options.items.map((o) => `${o.number} ${o.name} | ${o.riskLabel}`)).toEqual([
      '01 Cash deposits & short-dated gilts | Lower risk',
      '02 Investment-grade bond funds | Low–medium risk',
      '03 Global equity index funds | Higher risk',
      '04 Growth shares & sector ETFs | High risk',
      '05 Minority stakes in businesses | Very high risk',
    ]);
    const priorities = p.sections[6]!.blocks[0];
    expect(priorities?.kind === 'priorities' && priorities.items.map((x) => `${x.label} — ${x.title}`)).toEqual([
      'Priority 1 — Protect growth', 'Priority 2 — Accelerate expansion', 'Priority 3 — Diversify wealth creation', 'Priority 4 — Preserve flexibility',
    ]);
  });

  it('writes the figures’ sentences and tables from APX’s figures', () => {
    const allocation = p.sections[0]!.blocks[0];
    expect(allocation).toEqual({
      kind: 'paragraph', lead: null,
      text: 'Illustrative £100,000 distributable surplus: £45,000 business growth (45%), £35,000 external investments (35%) and £20,000 additional liquidity (20%). The surplus should be what remains after tax, reserves and committed obligations.',
    });
    const growth = p.sections[1]!.blocks.find((b) => b.kind === 'table');
    expect(growth?.kind === 'table' && growth.table.columns).toEqual(['Year', 'Revenue', 'Net profit at 15%']);
    expect(growth?.kind === 'table' && growth.table.rows.at(-1)!.map((c) => c.text)).toEqual(['Year 5', '£2,073,600', '£311,040']);
    expect(p.sections[1]!.blocks.some((b) => b.kind === 'note' && b.text.startsWith('By Year 5, illustrative annual net profit rises to approximately £311,000.'))).toBe(true);

    const scenarios = p.sections[2]!.blocks.filter((b) => b.kind === 'table').at(-1);
    expect(scenarios?.kind === 'table' && scenarios.table.rows.map((r) => r.map((c) => c.text))).toEqual([
      ['20%', '£2,073,600', '£311,040'], ['35%', '£3,321,506', '£498,226'], ['50%', '£5,062,500', '£759,375'],
    ]);
    expect(p.sections[2]!.blocks.some((b) => b.kind === 'note' && b.text.includes('Year 5 follows four annual growth periods.'))).toBe(true);

    const portfolio = p.sections[3]!.subsections[1]!.blocks.find((b) => b.kind === 'table');
    expect(portfolio?.kind === 'table' && portfolio.table.total).toBe(true);
    expect(portfolio?.kind === 'table' && portfolio.table.rows.at(-1)!.map((c) => c.text)).toEqual(['TOTAL', '100%', '£35,000']);
    expect(portfolio?.kind === 'table' && portfolio.table.rows[0]!.map((c) => c.text)).toEqual(['Global equity funds', '45%', '£15,750']);
    const returns = p.sections[3]!.subsections[2]!.blocks.find((b) => b.kind === 'table');
    expect(returns?.kind === 'table' && returns.table.rows[1]!.map((c) => c.text)).toEqual(['10% annual', '£56,368', '£21,368']);
  });

  it('presents the four charts as data, each with its table', () => {
    const all = charts(p);
    expect(all.map((c) => `${c.type}:${c.title}`)).toEqual([
      'split:How the surplus is allocated',
      'lines:Five-year revenue growth scenarios',
      'lines:Five-year profit scenarios',
      'risk:Relative risk positioning',
    ]);
    const revenue = all[1]!;
    expect(revenue.type === 'lines' && revenue.series.map((s) => s.label)).toEqual(['20% growth', '35% growth', '50% growth']);
    expect(revenue.type === 'lines' && revenue.series[2]!.displays.at(-1)).toBe('£5,062,500');
    expect(revenue.summary).toContain('£5,062,500 at 50% growth');
    const split = all[0]!;
    expect(split.type === 'split' && split.slices.map((s) => [s.percent, s.start])).toEqual([[45, 0], [35, 45], [20, 80]]);
    const risk = all[3]!;
    expect(risk.type === 'risk' && risk.points.map((x) => x.level)).toEqual([0, 1, 3, 4, 5]);
    for (const c of all) expect(c.table.rows.length).toBeGreaterThan(0);
  });

  it('carries the disclaimer, the risk note and the reference links', () => {
    expect(p.disclaimer).toEqual({ title: 'Important notice', text: INVESTMENT_DISCLAIMER });
    expect(allBlocks(p).some((b) => b.kind === 'note' && b.text === INVESTMENT_NOTICES.riskPositioning)).toBe(true);
    const links = p.sections[7]!.blocks[0];
    expect(links?.kind === 'links' && links.items.at(-1)).toEqual({ label: 'Figures: the company’s records in APX, year to 30 September 2026', url: null });
    expect(links?.kind === 'links' && links.items[0]).toEqual({ label: 'UK Debt Management Office', url: 'https://www.dmo.gov.uk/' });
  });

  it('says where the surplus came from', () => {
    expect(p.sections[0]!.blocks.at(-1)).toEqual({ kind: 'note', text: 'The surplus is the amount entered when the pack was created, not a figure from the company’s records.' });
    const fromProfit = presentInvestmentReport({
      ...SAMPLE_INVESTMENT_REPORT,
      figures: { ...SAMPLE_INVESTMENT_REPORT.figures, assumptions: { ...SAMPLE_INVESTMENT_REPORT.figures.assumptions, surplusSource: 'net_profit' } },
    });
    expect(fromProfit.sections[0]!.blocks.at(-1)).toMatchObject({ kind: 'note', text: expect.stringMatching(/^The surplus is the net profit for 2026 as APX holds it\./) });
  });

  it('keeps every section when the optional parts are absent, and says what is missing', () => {
    const sparse = presentInvestmentReport(SAMPLE_PACK_WITHOUT_OPTIONALS);
    expect(sparse.sections.map((s) => s.id)).toEqual(p.sections.map((s) => s.id));
    const options = sparse.sections[3]!.blocks.find((b) => b.kind === 'options');
    expect(options?.kind === 'options' && options.items.every((o) => o.reference === null)).toBe(true);
    const comparison = sparse.sections[3]!.subsections[3]!.blocks.find((b) => b.kind === 'table');
    expect(comparison?.kind === 'table' && comparison.table.rows[2]!.map((c) => c.text).at(-1)).toBe('—');
    expect(comparison?.kind === 'table' && comparison.table.rows[2]![0]!.detail).toContain('no net margin');
    expect(sparse.sections[7]!.blocks).toEqual([{ kind: 'note', text: INVESTMENT_NOTICES.noReferences }]);
    expect(sparse.sections[1]!.blocks.some((b) => b.kind === 'note' && b.text.includes('scaled to a full year'))).toBe(true);
  });

  it('keeps the numbering when the model leaves a part empty, and draws no empty table', () => {
    const r = SAMPLE_INVESTMENT_REPORT;
    const empty = presentInvestmentReport({ ...r, narrative: { ...r.narrative, levers: [], governance: ['  '] } });
    expect(empty.sections[2]!.blocks.filter((b) => b.kind === 'table')).toHaveLength(1);
    expect(empty.sections[5]!).toMatchObject({ label: '04', blocks: [{ kind: 'note', text: 'Nothing was written for this part.' }] });
  });
});

describe('before there is a pack', () => {
  const base = SAMPLE_INVESTMENT_REPORT.figures.base;

  it('says what the pack will allocate by default', () => {
    const start = presentInvestmentStart({ base, defaultSurplus: '150000.00', currency: 'GBP' });
    expect(start).toMatchObject({ hasFigures: true, amountRequired: false, surplusLine: 'APX will allocate £150,000 — the net profit for 2026.' });
    expect(start.basis).toBe('2026: revenue £1,000,000; net profit £150,000 (15% net margin).');
  });

  it('asks for an amount when the year made no profit, or there are no figures', () => {
    expect(presentInvestmentStart({ base, defaultSurplus: null, currency: 'GBP' })).toMatchObject({
      amountRequired: true, surplusLine: expect.stringContaining('2026 shows no profit'),
    });
    expect(presentInvestmentStart({ base: null, defaultSurplus: null, currency: 'GBP' })).toMatchObject({ hasFigures: false, amountRequired: true, basis: null });
  });
});

describe('renderInvestmentDocx', () => {
  it('produces a Word file with the client’s sections, options and figures', async () => {
    const bytes = await renderInvestmentDocx(SAMPLE_INVESTMENT_REPORT);
    expect(bytes.byteLength).toBeGreaterThan(5_000);
    expect(unzip(bytes, '[Content_Types].xml')).toContain('wordprocessingml.document.main+xml');

    const xml = unzip(bytes, 'word/document.xml');
    expect(xml).not.toBeNull();
    const text = wordText(xml!);
    for (const heading of [
      'INVESTMENT PACK  |  OCTOBER 2026', 'CORE BUSINESS', 'EXTERNAL INVESTMENTS', 'Executive capital allocation',
      'Converting growth into surplus capital', 'Reinvesting in the core business', 'External investment opportunities',
      'Capital allocation process', 'Governance and investment controls', 'Investment committee recommendation',
      'Reference links', 'Important notice', 'Five-year revenue growth scenarios', 'Relative risk positioning',
      'Diversified external portfolio',
    ]) expect(text, heading).toContain(heading);
    expect(text).toContain('Cash deposits & short-dated gilts');
    expect(text).toContain('RISK PROFILE');
    expect(text).toContain('£2,073,600');
    expect(text).toContain('45%');
    expect(text).toContain('TOTAL');
    expect(text).toContain('Priority 4');
    expect(text).toContain(INVESTMENT_DISCLAIMER);
    // The order is the document's.
    const order = ['Executive capital allocation', 'Converting growth', 'Reinvesting in the core', 'External investment opportunities',
      'Capital allocation process', 'Governance and investment', 'Investment committee', 'Reference links'].map((h) => text.indexOf(h));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Tables repeat their header, the bars are drawn in the chart colours, the references are links.
    expect(xml).toContain('<w:tblHeader');
    for (const fill of ['FF2D55', 'FF8A4C', '38BDF8']) expect(xml).toContain(`w:fill="${fill}"`);
    expect(xml).toContain('<w:hyperlink');
    expect(unzip(bytes, 'word/_rels/document.xml.rels')).toContain('https://www.dmo.gov.uk/');

    const headers = ['word/header1.xml', 'word/header2.xml', 'word/header3.xml'].map((n) => unzip(bytes, n)).filter((x): x is string => x !== null);
    expect(headers.map(wordText).join(' ')).toContain('Finance in motion');
  });

  it('renders the pack without its optional parts', async () => {
    const text = wordText(unzip(await renderInvestmentDocx(SAMPLE_PACK_WITHOUT_OPTIONALS), 'word/document.xml')!);
    expect(text).toContain(INVESTMENT_NOTICES.noReferences);
    expect(text).not.toContain('https://www.dmo.gov.uk/');
  });
});

describe('renderInvestmentPdf', () => {
  it('produces a PDF of several pages, in the same order as the Word file', async () => {
    const bytes = await renderInvestmentPdf(SAMPLE_INVESTMENT_REPORT);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(5);
    expect(doc.getTitle()).toBe('Investment pack - Northwind Trading Ltd - October 2026');

    const pages = await pdfText(bytes);
    const all = pages.join('\n');
    expect(pages[0]).toContain('INVESTMENT PACK');
    expect(pages[0]).toContain('CORE BUSINESS');
    const order = ['Executive capital allocation', 'Converting growth into surplus capital', 'Reinvesting in the core business',
      'External investment opportunities', 'Capital allocation process', 'Governance and investment controls',
      'Investment committee recommendation', 'Reference links'].map((h) => all.indexOf(h));
    // The notice ends the pack, and its words are on the cover too.
    order.push(all.indexOf('Important notice'));
    expect(all.indexOf('Returns are not guaranteed')).toBeLessThan(order[0]!);
    expect(all.lastIndexOf('Returns are not guaranteed')).toBeGreaterThan(order.at(-1)!);
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(all).toContain('Cash deposits & short-dated gilts');
    expect(all).toContain('£2,073,600');
    // The charts' own labels: the axis, the scenario names and the risk scale.
    expect(all).toContain('£6,000,000');
    expect(all).toContain('50% growth');
    expect(all).toContain('Very high');
    expect(all).toContain('Returns are not guaranteed and may be');
    expect(pages.every((page, i) => page.includes(`Page ${i + 1} of ${pages.length}`))).toBe(true);
    expect(pages.every((page) => page.includes('Finance in motion'))).toBe(true);
  });

  it('renders the pack without its optional parts', async () => {
    const all = (await pdfText(await renderInvestmentPdf(SAMPLE_PACK_WITHOUT_OPTIONALS))).join('\n');
    expect(all).toContain('No reference links were given');
    expect(all).not.toContain('Reference: https://');
  });
});

describe('the Departments summary comes from the pack’s real state', () => {
  const view: InvestmentView = {
    organisationName: 'Northwind Trading Ltd',
    currency: 'GBP',
    profile: SAMPLE_INVESTMENT_REPORT.profile,
    base: SAMPLE_INVESTMENT_REPORT.figures.base,
    defaultSurplus: '150000.00',
    status: 'ready',
    report: SAMPLE_INVESTMENT_REPORT,
    failure: null,
    canRefresh: true,
    canEditProfile: true,
  };

  it('names the pack’s date and its allocation when ready', () => {
    expect(summariseInvestment(view)).toEqual({
      tone: 'good', label: 'Pack ready 14 Oct 2026', asOf: '14 Oct 2026',
      headline: '£100,000 surplus: 45% business growth, 35% external investments, 20% liquidity.',
    });
  });

  it('says preparing, failed, no pack or no figures — never a figure it does not have', () => {
    expect(summariseInvestment({ ...view, status: 'running' }).label).toBe('Preparing');
    expect(summariseInvestment({ ...view, status: 'queued', report: null })).toMatchObject({ tone: 'quiet', label: 'Preparing', asOf: null });
    expect(summariseInvestment({ ...view, status: 'failed' })).toMatchObject({ tone: 'attention', label: 'Last attempt failed' });
    expect(summariseInvestment({ ...view, status: 'none', report: null })).toMatchObject({ tone: 'quiet', label: 'No pack yet', headline: 'Ready to create from the 2026 figures.' });
    expect(summariseInvestment({ ...view, status: 'none', report: null, base: null, defaultSurplus: null })).toMatchObject({ tone: 'attention', label: 'No figures yet' });
  });
});

describe('who wrote it', () => {
  it('says ChatGPT for a pack a model wrote, and the playbook for one written offline', () => {
    expect(investmentAuthorshipFor(SAMPLE_INVESTMENT_REPORT)).toBe(INVESTMENT_AUTHORSHIP);
    expect(investmentAuthorshipFor({ model: 'offline-template' })).toBe(INVESTMENT_AUTHORSHIP_OFFLINE);
    expect(presentInvestmentReport({ ...SAMPLE_INVESTMENT_REPORT, model: 'offline-template' }).authorship).toBe(INVESTMENT_AUTHORSHIP_OFFLINE);
  });
});
