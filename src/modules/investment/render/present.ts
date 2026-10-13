import { sum, tryParseDecimal } from '@/core/money';
import {
  NOT_AVAILABLE, formatReportDate, formatReportDateTime, formatReportMoney, withoutLead,
  type ReportCell, type ReportTable,
} from '@/modules/marketing';
import {
  INVESTMENT_DISCLAIMER,
  type GrowthScenario, type InvestmentReport, type InvestmentView, type ProjectionYear, type RiskLevel,
} from '../domain/types';
import {
  RISK_LEVELS, approximateMoney, chartNumber, countWord, moneyAxis, percentText, rangeText, riskIndex, riskLabel,
  type AxisTick,
} from './format';

/**
 * The Investment Pack laid out once (ADR-171), for the page, the Word file and the PDF alike — the
 * Marketing report's pattern (ADR-170, `modules/marketing/render/present.ts`), whose table cell and
 * table shapes it shares.
 *
 * The client's own example (the "Investment Strategy & Financial Growth Plan — Investment Pack",
 * October 2026) is the shape, section for section: the cover with the strategic objective and the two
 * headline aims; the executive capital allocation; 01 converting growth into surplus capital; 02
 * reinvesting in the core business; 03 the external investment opportunities, their risk positioning,
 * the illustrative portfolio, the return scenarios and the SOW's reinvest-or-invest comparison; the
 * capital allocation process; 04 governance; 05 the committee's four priorities; the reference links;
 * and the important notice. Every heading, sentence of APX's own, table cell and chart is decided
 * HERE, and the three renderers only draw it — so the screen, the Word file and the PDF can never
 * differ in what they say, in what order, or in a figure.
 *
 * The figures are APX's (`report.figures`, `report.portfolio`); the sentences that carry figures in
 * the client's document ("Illustrative £100,000 distributable surplus: …", "By Year 5 … approximately
 * £311,000") are APX's too, written here from those figures — the model writes only the narrative
 * paragraphs and lists. The disclaimer is fixed (`INVESTMENT_DISCLAIMER`) and is not the model's.
 *
 * A chart is presented as data — categories, series, the axis, a one-sentence summary — together with
 * its table, which is the chart's text equivalent on the page (UX_ARCHITECTURE.md §11) and what a
 * renderer that cannot draw it can print instead.
 *
 * Pure: a report in, a presentation out. No I/O, no clock.
 */

export type PackCell = ReportCell;

export interface PackTable extends ReportTable {
  /** True when the last row is a total ("TOTAL | 100% | £35,000"), drawn heavier. */
  readonly total: boolean;
}

export interface ChartSeries {
  readonly key: string;
  /** "20% growth". */
  readonly label: string;
  /** One per category; null is a gap, never a zero. */
  readonly values: readonly (number | null)[];
  /** The same, as shown: "£2,073,600". */
  readonly displays: readonly string[];
}

export interface LineChart {
  readonly type: 'lines';
  readonly id: string;
  readonly title: string;
  /** The chart in one sentence, for a screen reader and the PDF's alternative text. */
  readonly summary: string;
  /** "Year 1" … "Year 5". */
  readonly categories: readonly string[];
  readonly series: readonly ChartSeries[];
  /** The money axis, from zero. */
  readonly max: number;
  readonly ticks: readonly AxisTick[];
  readonly table: PackTable;
}

export interface SplitSlice {
  readonly key: 'business' | 'external' | 'liquidity';
  /** "Business growth". */
  readonly label: string;
  /** The share as a number, for the chart only: 45. */
  readonly percent: number;
  /** Where the slice starts, as a percentage of the whole: 0, 45, 80. */
  readonly start: number;
  /** "45%". */
  readonly share: string;
  /** "£45,000". */
  readonly amount: string;
}

export interface SplitChart {
  readonly type: 'split';
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** "£100,000", the whole being split. */
  readonly total: string;
  readonly slices: readonly SplitSlice[];
  readonly table: PackTable;
}

export interface RiskPoint {
  /** "01", the option's number. */
  readonly number: string;
  readonly label: string;
  readonly risk: RiskLevel;
  /** 0 for lower … 5 for very high. */
  readonly level: number;
  /** "Lower risk". */
  readonly riskLabel: string;
}

export interface RiskChart {
  readonly type: 'risk';
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** The six levels, lower to very high: "Lower", "Low–medium" … */
  readonly levels: readonly { readonly key: RiskLevel; readonly label: string }[];
  readonly points: readonly RiskPoint[];
  readonly table: PackTable;
}

export type PresentedChart = LineChart | SplitChart | RiskChart;

export interface PresentedOption {
  /** "01". */
  readonly number: string;
  readonly name: string;
  readonly risk: RiskLevel;
  /** "Lower risk". */
  readonly riskLabel: string;
  readonly description: string;
  /** An http(s) address, or null when none was given. */
  readonly reference: string | null;
}

export interface PresentedPriority {
  /** "Priority 1". */
  readonly label: string;
  readonly title: string;
  readonly text: string;
}

export interface PresentedLink {
  readonly label: string;
  /** An http(s) address, or null for a source that is only named ("the company's records in APX"). */
  readonly url: string | null;
}

export type NoticeTone = 'info' | 'warn';

export type PackBlock =
  /** A paragraph, with an optional bold lead ("Strategic objective:"). */
  | { readonly kind: 'paragraph'; readonly lead: string | null; readonly text: string }
  | { readonly kind: 'bullets'; readonly items: readonly string[] }
  | { readonly kind: 'table'; readonly table: PackTable }
  /** The document's own small italic notes ("Risk-return positioning is conceptual, …"). */
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'notice'; readonly tone: NoticeTone; readonly title: string; readonly text: string }
  | { readonly kind: 'chart'; readonly chart: PresentedChart }
  /** 03's numbered options, each with its risk profile and reference. */
  | { readonly kind: 'options'; readonly items: readonly PresentedOption[] }
  /** 05's "Priority 1 — Protect growth". */
  | { readonly kind: 'priorities'; readonly items: readonly PresentedPriority[] }
  | { readonly kind: 'links'; readonly items: readonly PresentedLink[] };

export interface PresentedPackSubsection {
  /** An anchor id, unique in the pack. */
  readonly id: string;
  readonly title: string;
  readonly blocks: readonly PackBlock[];
}

export interface PresentedPackSection {
  /** An anchor id: "allocation", "section-01" … "references". */
  readonly id: string;
  /** "01" … "05", or null for the unnumbered parts (the allocation, the process, the references). */
  readonly label: string | null;
  readonly title: string;
  /**
   * True where the printed files start a new page: 01, 02 and 03, the long sections. The process,
   * 04, 05 and the references are short and run on together, as in the client's document.
   */
  readonly newPage: boolean;
  readonly blocks: readonly PackBlock[];
  readonly subsections: readonly PresentedPackSubsection[];
}

export interface PresentedHeadline {
  /** "CORE BUSINESS". */
  readonly label: string;
  /** "20–50%". */
  readonly figure: string;
  /** "annual revenue growth ambition". */
  readonly text: string;
}

export interface PresentedPackCover {
  /** "INVESTMENT PACK". */
  readonly title: string;
  /** "INVESTMENT PACK  |  OCTOBER 2026". */
  readonly dateLine: string;
  readonly organisationName: string;
  /** "A visual investment pack  |  Capital allocation • Business reinvestment • Diversified investments". */
  readonly strapline: string;
  readonly objectiveLead: string;
  /** The model's objective, without a lead it may have written itself. */
  readonly objective: string;
  readonly headlines: readonly [PresentedHeadline, PresentedHeadline];
  /** "Based on 2026: revenue £1,000,000; net profit £150,000 (15% net margin)." */
  readonly basis: string;
}

export interface InvestmentPresentation {
  /** The file's title: "Investment pack - Northwind Trading Ltd - October 2026". */
  readonly documentTitle: string;
  readonly cover: PresentedPackCover;
  readonly sections: readonly PresentedPackSection[];
  /** The important notice, shown at the top and the foot of the page and in both files. */
  readonly disclaimer: { readonly title: string; readonly text: string };
  /** "14 Oct 2026". */
  readonly generatedOn: string;
  readonly authorship: string;
  /** Which pack, prompt and model produced this, and when — a printed page outlives its screen. */
  readonly provenance: string;
}

export const INVESTMENT_AUTHORSHIP = 'Written by ChatGPT from your company profile and figures; every figure is APX’s.';

/** Said instead when no model wrote it: the offline mode for demos and tests (`offline-template`). */
export const INVESTMENT_AUTHORSHIP_OFFLINE =
  'Written from APX’s standard investment playbook, without ChatGPT, from your company profile and figures; every figure is APX’s.';

/** The model that names a pack written offline (as Marketing's OFFLINE_MODEL). */
const OFFLINE_MODEL = 'offline-template';

export function investmentAuthorshipFor(report: Pick<InvestmentReport, 'model'>): string {
  return report.model === OFFLINE_MODEL ? INVESTMENT_AUTHORSHIP_OFFLINE : INVESTMENT_AUTHORSHIP;
}

/** The fixed notices of APX's own (ADR-171). Not the model's words: they are true whatever it wrote. */
export const INVESTMENT_NOTICES = {
  disclaimer: { title: 'Important notice', text: INVESTMENT_DISCLAIMER },
  riskPositioning: 'Risk-return positioning is conceptual, not a statistical estimate or expected return forecast.',
  references: 'These links are starting points for the company’s own research. APX has not checked them, and none is a recommendation of a provider.',
  noReferences: 'No reference links were given for this pack.',
} as const;

const cell = (text: string, detail: string | null = null): PackCell => ({ text, detail });

/** Drops empty strings the model may have left in a list. */
function kept(items: readonly string[]): string[] {
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

function paragraph(text: string | null, lead: string | null = null): PackBlock[] {
  const body = text?.trim() ?? '';
  return body === '' ? [] : [{ kind: 'paragraph', lead, text: body }];
}

function note(text: string | null): PackBlock[] {
  const body = text?.trim() ?? '';
  return body === '' ? [] : [{ kind: 'note', text: body }];
}

/** Only an http(s) address is a link; anything else the model wrote is not drawn as one. */
function httpUrl(value: string | null | undefined): string | null {
  const url = value?.trim() ?? '';
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
}

function table(spec: Omit<PackTable, 'total'> & { total?: boolean }): PackBlock {
  return { kind: 'table', table: { ...spec, total: spec.total ?? false } };
}

function money(value: string | null, report: InvestmentReport): string {
  return formatReportMoney(value, report.figures.base.currency);
}

/** "Year 5", the last year of a projection; "the final year" when there are none. */
function lastLabel(years: readonly ProjectionYear[]): string {
  return years[years.length - 1]?.label ?? 'The final year';
}

/* ------------------------------------------------------------------------------------------------ */
/* The cover                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

function cover(report: InvestmentReport): PresentedPackCover {
  const { base, assumptions } = report.figures;
  return {
    title: 'INVESTMENT PACK',
    dateLine: `INVESTMENT PACK  |  ${report.reportDate.toLocaleUpperCase('en-GB')}`,
    organisationName: report.organisationName,
    strapline: 'A visual investment pack  |  Capital allocation • Business reinvestment • Diversified investments',
    objectiveLead: 'Strategic objective:',
    objective: withoutLead(report.narrative.objective, 'Strategic objective'),
    headlines: [
      { label: 'CORE BUSINESS', figure: rangeText(assumptions.growthRates), text: 'annual revenue growth ambition' },
      {
        label: 'EXTERNAL INVESTMENTS', figure: percentText(assumptions.targetReturnPct),
        text: 'illustrative long-term annual return target (not guaranteed)',
      },
    ],
    basis: `Based on ${base.yearLabel}: revenue ${money(base.revenue, report)}; net profit ${money(base.netProfit, report)} `
      + `(${percentText(base.netMarginPct)} net margin).`,
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* Executive capital allocation                                                                     */
/* ------------------------------------------------------------------------------------------------ */

const SPLIT_LABELS = { business: 'Business growth', external: 'External investments', liquidity: 'Additional liquidity' } as const;

function splitChart(report: InvestmentReport): SplitChart {
  const { allocation, assumptions } = report.figures;
  const keys = ['business', 'external', 'liquidity'] as const;
  let start = 0;
  const slices = keys.map((key): SplitSlice => {
    const percent = Math.max(0, chartNumber(allocation[key].percent) ?? 0);
    const slice = {
      key, label: SPLIT_LABELS[key], percent, start, share: percentText(allocation[key].percent), amount: money(allocation[key].amount, report),
    };
    start += percent;
    return slice;
  });
  const total = money(assumptions.surplus, report);
  return {
    type: 'split',
    id: 'chart-allocation',
    title: 'How the surplus is allocated',
    summary: `${total} split: ${slices.map((s) => `${s.label.toLocaleLowerCase('en-GB')} ${s.amount} (${s.share})`).join(', ')}.`,
    total,
    slices,
    table: {
      caption: `How the ${total} surplus is allocated`,
      columns: ['Use of surplus', 'Share', 'Amount'],
      numeric: [false, true, true],
      widths: [50, 20, 30],
      rows: [
        ...slices.map((s) => [cell(s.label), cell(s.share), cell(s.amount)]),
        [cell('TOTAL'), cell(percentText(sum(keys.map((k) => tryParseDecimal(allocation[k].percent) ?? '0')).toFixed())), cell(total)],
      ],
      total: true,
    },
  };
}

function allocationSection(report: InvestmentReport): PresentedPackSection {
  const { allocation, assumptions, base } = report.figures;
  const part = (key: keyof typeof allocation, words: string) => `${money(allocation[key].amount, report)} ${words} (${percentText(allocation[key].percent)})`;
  const source = assumptions.surplusSource === 'net_profit'
    ? `The surplus is the net profit for ${base.yearLabel} as APX holds it${base.annualised ? ', scaled to a full year' : ''}. `
      + 'Replace it with the amount actually free to invest once tax, reserves and commitments are known.'
    : 'The surplus is the amount entered when the pack was created, not a figure from the company’s records.';
  return {
    id: 'allocation',
    label: null,
    title: 'Executive capital allocation',
    newPage: false,
    blocks: [
      ...paragraph(
        `Illustrative ${money(assumptions.surplus, report)} distributable surplus: ${part('business', 'business growth')}, `
        + `${part('external', 'external investments')} and ${part('liquidity', 'additional liquidity')}. `
        + 'The surplus should be what remains after tax, reserves and committed obligations.',
      ),
      { kind: 'chart', chart: splitChart(report) },
      ...note(source),
    ],
    subsections: [],
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* 01 Converting growth into surplus capital                                                        */
/* ------------------------------------------------------------------------------------------------ */

function growthSection(report: InvestmentReport): PresentedPackSection {
  const { base, baseCase } = report.figures;
  const final = baseCase.years[baseCase.years.length - 1];
  return {
    id: 'section-01',
    label: '01',
    title: 'Converting growth into surplus capital',
    newPage: true,
    blocks: [
      ...paragraph(report.narrative.growthToSurplus),
      table({
        caption: `${baseCase.name}: ${percentText(baseCase.growthPct)} annual growth at a constant ${percentText(base.netMarginPct)} net margin`,
        columns: ['Year', 'Revenue', `Net profit at ${percentText(base.netMarginPct)}`],
        numeric: [false, true, true],
        widths: [30, 35, 35],
        rows: baseCase.years.map((y) => [cell(y.label), cell(money(y.revenue, report)), cell(money(y.netProfit, report))]),
      }),
      ...(final === undefined ? [] : note(
        `By ${final.label}, illustrative annual net profit rises to approximately ${approximateMoney(final.netProfit, base.currency)}. `
        + 'This does not imply that the full amount is available for investment.',
      )),
      ...note(`${base.sourceNote.trim()}${base.annualised ? ' The year held fewer than twelve months; its figures were scaled to a full year.' : ''}`),
    ],
    subsections: [],
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* 02 Reinvesting in the core business                                                              */
/* ------------------------------------------------------------------------------------------------ */

function scenarioChart(
  report: InvestmentReport,
  id: string,
  title: string,
  field: 'revenue' | 'netProfit',
  noun: string,
): LineChart {
  const scenarios: readonly GrowthScenario[] = report.figures.growthScenarios;
  const categories = scenarios[0]?.years.map((y) => y.label) ?? [];
  const series = scenarios.map((s, i): ChartSeries => ({
    key: `scenario-${i + 1}`,
    label: `${percentText(s.growthPct)} growth`,
    values: categories.map((_, c) => chartNumber(s.years[c]?.[field] ?? null)),
    displays: categories.map((_, c) => money(s.years[c]?.[field] ?? null, report)),
  }));
  const highest = Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const axis = moneyAxis(highest, report.figures.base.currency);
  const last = categories[categories.length - 1] ?? 'the final year';
  const each = series.length === 0 ? 0 : Math.floor((72 / series.length) * 10) / 10;
  return {
    type: 'lines',
    id,
    title,
    summary: `${title}: by ${last}, ${noun} reaches ${series.map((s) => `${s.displays[s.displays.length - 1] ?? NOT_AVAILABLE} at ${s.label}`).join(', ')}.`,
    categories,
    series,
    max: axis.max,
    ticks: axis.ticks,
    table: {
      caption: title,
      columns: ['Year', ...series.map((s) => s.label)],
      numeric: [false, ...series.map(() => true)],
      widths: [Math.round((100 - each * series.length) * 10) / 10, ...series.map(() => each)],
      rows: categories.map((label, c) => [cell(label), ...series.map((s) => cell(s.displays[c] ?? NOT_AVAILABLE))]),
      total: false,
    },
  };
}

function reinvestmentSection(report: InvestmentReport): PresentedPackSection {
  const { base, growthScenarios } = report.figures;
  const years = growthScenarios[0]?.years ?? [];
  const last = lastLabel(years);
  const periods = Math.max(0, years.length - 1);
  return {
    id: 'section-02',
    label: '02',
    title: 'Reinvesting in the core business',
    newPage: true,
    blocks: [
      ...paragraph(report.narrative.reinvestment),
      table({
        caption: 'Investment levers',
        columns: ['Investment lever', 'Proposed action', 'Key measurement'],
        numeric: [false, false, false],
        widths: [26, 44, 30],
        rows: report.narrative.levers.map((l) => [cell(l.lever), cell(l.action), cell(l.measure)]),
      }),
      { kind: 'chart', chart: scenarioChart(report, 'chart-revenue', 'Five-year revenue growth scenarios', 'revenue', 'revenue') },
      { kind: 'chart', chart: scenarioChart(report, 'chart-profit', 'Five-year profit scenarios', 'netProfit', 'net profit') },
      ...note(
        `Illustrations use ${money(base.revenue, report)} starting annual revenue and a constant ${percentText(base.netMarginPct)} net profit margin. `
        + `${last} follows ${countWord(periods)} annual growth period${periods === 1 ? '' : 's'}. Growth is not the same as investment return.`,
      ),
      table({
        caption: `Growth scenarios at ${last}`,
        columns: ['Annual growth', `${last} revenue`, `${last} net profit`],
        numeric: [false, true, true],
        widths: [34, 33, 33],
        rows: growthScenarios.map((s) => {
          const final = s.years[s.years.length - 1];
          return [cell(percentText(s.growthPct), s.name), cell(money(final?.revenue ?? null, report)), cell(money(final?.netProfit ?? null, report))];
        }),
      }),
    ],
    subsections: [],
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* 03 External investment opportunities                                                             */
/* ------------------------------------------------------------------------------------------------ */

const number = (i: number) => String(i + 1).padStart(2, '0');

function riskChart(options: readonly PresentedOption[]): RiskChart {
  const points = options.map((o): RiskPoint => ({
    number: o.number, label: o.name, risk: o.risk, level: riskIndex(o.risk), riskLabel: o.riskLabel,
  }));
  return {
    type: 'risk',
    id: 'chart-risk',
    title: 'Relative risk positioning',
    summary: `The options from lower to very high risk: ${[...points].sort((a, b) => a.level - b.level)
      .map((p) => `${p.number} ${p.label}, ${p.riskLabel.toLocaleLowerCase('en-GB')}`).join('; ')}.`,
    levels: RISK_LEVELS.map((level) => ({ key: level.key, label: level.short })),
    points,
    table: {
      caption: 'Relative risk positioning of the options',
      columns: ['Option', 'Risk profile'],
      numeric: [false, false],
      widths: [65, 35],
      rows: points.map((p) => [cell(`${p.number}  ${p.label}`), cell(p.riskLabel)]),
      total: false,
    },
  };
}

function externalSection(report: InvestmentReport): PresentedPackSection {
  const { allocation, assumptions, returnScenarios, comparison, base } = report.figures;
  const options = report.narrative.options
    .filter((o) => o.name.trim() !== '')
    .map((o, i): PresentedOption => ({
      number: number(i), name: o.name.trim(), risk: o.risk, riskLabel: riskLabel(o.risk), description: o.description.trim(), reference: httpUrl(o.referenceUrl),
    }));
  const portfolioTotal = report.portfolio.length === 0 ? [] : [[
    cell('TOTAL'),
    cell(percentText(sum(report.portfolio.map((p) => tryParseDecimal(p.percent) ?? '0')).toFixed())),
    cell(money(sum(report.portfolio.map((p) => tryParseDecimal(p.amount) ?? '0')).toFixed(2), report)),
  ]];
  const horizon = `Year ${assumptions.horizonYears}`;
  const start = returnScenarios[0]?.startAmount ?? allocation.external.amount;

  return {
    id: 'section-03',
    label: '03',
    title: 'External investment opportunities',
    newPage: true,
    blocks: [
      ...paragraph(report.narrative.externalIntro),
      { kind: 'options', items: options },
    ],
    subsections: [
      {
        id: 'risk-positioning',
        title: 'Relative risk positioning',
        blocks: options.length === 0 ? [] : [{ kind: 'chart', chart: riskChart(options) }, ...note(INVESTMENT_NOTICES.riskPositioning)],
      },
      {
        id: 'portfolio',
        title: 'Diversified external portfolio',
        blocks: [
          ...paragraph(`Illustrative deployment of ${money(allocation.external.amount, report)} from the proposed ${money(assumptions.surplus, report)} annual distributable surplus.`),
          table({
            caption: 'Diversified external portfolio',
            columns: ['Asset class', 'Allocation', 'Amount'],
            numeric: [false, true, true],
            widths: [50, 20, 30],
            rows: report.portfolio.length === 0 ? [] : [
              ...report.portfolio.map((p) => [cell(p.assetClass, riskLabel(p.risk)), cell(percentText(p.percent)), cell(money(p.amount, report))]),
              ...portfolioTotal,
            ],
            total: true,
          }),
          ...note(report.narrative.portfolioNote),
        ],
      },
      {
        id: 'return-scenarios',
        title: `${countWord(assumptions.horizonYears).replace(/^./, (c) => c.toLocaleUpperCase('en-GB'))}-year investment return scenarios`,
        blocks: [
          ...paragraph(
            `Starting investment: ${money(start, report)}. Assumes annual compounding with no withdrawals. `
            + 'Figures are before fees, taxes and inflation; returns may be negative.',
          ),
          table({
            caption: 'Investment return scenarios',
            columns: ['Return scenario', `${horizon} value`, 'Cumulative gain'],
            numeric: [false, true, true],
            widths: [40, 30, 30],
            rows: returnScenarios.map((r) => [cell(`${percentText(r.ratePct)} annual`), cell(money(r.finalValue, report)), cell(money(r.gain, report))]),
          }),
        ],
      },
      {
        id: 'reinvest-or-invest',
        title: 'Reinvest or invest: the comparison',
        blocks: [
          ...paragraph(report.narrative.comparison),
          table({
            caption: 'Reinvest or invest: the comparison',
            columns: ['Comparison', 'Figure'],
            numeric: [false, true],
            widths: [70, 30],
            rows: [
              [
                cell(`${money(comparison.amount, report)} invested for ${countWord(comparison.years)} year${comparison.years === 1 ? '' : 's'} at ${percentText(comparison.ratePct)} a year`, 'Value at the end'),
                cell(money(comparison.value, report)),
              ],
              [cell('Gain'), cell(money(comparison.gain, report))],
              [
                cell(
                  `Extra sales the business would need at its ${percentText(base.netMarginPct)} net margin to earn the same`,
                  comparison.salesNeededForSameGain === null ? 'Not worked out: the base year shows no net margin to compare with.' : null,
                ),
                cell(money(comparison.salesNeededForSameGain, report)),
              ],
            ],
          }),
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* The process, 04 governance, 05 the recommendation, the references                                */
/* ------------------------------------------------------------------------------------------------ */

function processSection(report: InvestmentReport): PresentedPackSection {
  const stages = [...report.narrative.process].sort((a, b) => a.stage - b.stage);
  return {
    id: 'process',
    label: null,
    title: 'Capital allocation process',
    newPage: false,
    blocks: [table({
      caption: 'Capital allocation process',
      columns: ['Stage', 'Action', 'Timing'],
      numeric: [false, false, false],
      widths: [12, 60, 28],
      rows: stages.map((s) => [cell(String(s.stage)), cell(s.action), cell(s.timing)]),
    })],
    subsections: [],
  };
}

function governanceSection(report: InvestmentReport): PresentedPackSection {
  const items = kept(report.narrative.governance);
  return {
    id: 'section-04',
    label: '04',
    title: 'Governance and investment controls',
    newPage: false,
    blocks: items.length === 0 ? [] : [{ kind: 'bullets', items }],
    subsections: [],
  };
}

function recommendationSection(report: InvestmentReport): PresentedPackSection {
  const items = report.narrative.recommendation
    .filter((p) => p.title.trim() !== '' || p.text.trim() !== '')
    .map((p, i): PresentedPriority => ({ label: `Priority ${i + 1}`, title: p.title.trim(), text: p.text.trim() }));
  return {
    id: 'section-05',
    label: '05',
    title: 'Investment committee recommendation',
    newPage: false,
    blocks: [{ kind: 'priorities', items }],
    subsections: [],
  };
}

function referencesSection(report: InvestmentReport): PresentedPackSection {
  const items = report.sources
    .map((s): PresentedLink => ({ label: s.label.trim(), url: httpUrl(s.url) }))
    .filter((s) => s.label !== '' || s.url !== null)
    .map((s) => (s.label === '' && s.url !== null ? { label: s.url, url: s.url } : s));
  const anyLink = items.some((s) => s.url !== null);
  return {
    id: 'references',
    label: null,
    title: 'Reference links',
    newPage: false,
    blocks: items.length === 0
      ? note(INVESTMENT_NOTICES.noReferences)
      : [{ kind: 'links', items }, ...(anyLink ? note(INVESTMENT_NOTICES.references) : [])],
    subsections: [],
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* The whole pack                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/** A table with no rows, or a list with no items, says nothing: it is dropped rather than drawn empty. */
function hasContent(block: PackBlock): boolean {
  if (block.kind === 'table') return block.table.rows.length > 0;
  if (block.kind === 'bullets' || block.kind === 'options' || block.kind === 'priorities' || block.kind === 'links') return block.items.length > 0;
  if (block.kind === 'chart') {
    const c = block.chart;
    return c.type === 'lines' ? c.categories.length > 0 && c.series.length > 0 : c.type === 'risk' ? c.points.length > 0 : c.slices.length > 0;
  }
  return true;
}

const NOTHING_WRITTEN: PackBlock = { kind: 'note', text: 'Nothing was written for this part.' };

/**
 * The numbered sections keep their place whatever the model returned, so a part it left empty says
 * so instead of disappearing and renumbering the rest.
 */
function tidy(section: PresentedPackSection): PresentedPackSection {
  const blocks = section.blocks.filter(hasContent);
  const subsections = section.subsections.map((sub) => {
    const kept = sub.blocks.filter(hasContent);
    return { ...sub, blocks: kept.length === 0 ? [NOTHING_WRITTEN] : kept };
  });
  return { ...section, blocks: blocks.length === 0 && subsections.length === 0 ? [NOTHING_WRITTEN] : blocks, subsections };
}

export function presentInvestmentReport(report: InvestmentReport): InvestmentPresentation {
  const authorship = investmentAuthorshipFor(report);
  return {
    documentTitle: `Investment pack - ${report.organisationName} - ${report.reportDate}`,
    cover: cover(report),
    sections: [
      allocationSection(report), growthSection(report), reinvestmentSection(report), externalSection(report),
      processSection(report), governanceSection(report), recommendationSection(report), referencesSection(report),
    ].map(tidy),
    disclaimer: INVESTMENT_NOTICES.disclaimer,
    generatedOn: formatReportDate(report.generatedAt),
    authorship,
    provenance: `Generated ${formatReportDateTime(report.generatedAt)} by APX. ${authorship} `
      + `Model ${report.model}; prompt ${report.promptVersion}; pack ${report.version}.`,
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* Before there is a pack: what "create" will use                                                   */
/* ------------------------------------------------------------------------------------------------ */

export interface InvestmentStart {
  /** False when APX holds no full figures for the company. */
  readonly hasFigures: boolean;
  /** "2026: revenue £1,000,000; net profit £150,000 (15% net margin)." or null. */
  readonly basis: string | null;
  /** Where the figures came from, with the part-year note when it applies; null with no figures. */
  readonly sourceNote: string | null;
  /** "APX will allocate £150,000 — the net profit for 2026." or why an amount must be entered. */
  readonly surplusLine: string;
  /** True when the form must have an amount: no figures, or a year without a profit. */
  readonly amountRequired: boolean;
  /** Under the amount field. */
  readonly amountHint: string;
}

/**
 * The page's words before a pack exists, or beside the refresh: the base year APX would build on and
 * the surplus it would allocate by default (ADR-171). Formatting stays here, out of the component
 * (UX_ARCHITECTURE.md §11).
 */
export function presentInvestmentStart(view: Pick<InvestmentView, 'base' | 'defaultSurplus' | 'currency'>): InvestmentStart {
  const { base } = view;
  const example = 'For example 95,000.';
  if (base === null) {
    return {
      hasFigures: false,
      basis: null,
      sourceNote: null,
      surplusLine: 'APX holds no figures for this company yet, so enter the amount to allocate.',
      amountRequired: true,
      amountHint: `The surplus after tax, reserves and committed obligations. ${example}`,
    };
  }
  const fmt = (value: string | null) => formatReportMoney(value, base.currency);
  const basis = `${base.yearLabel}: revenue ${fmt(base.revenue)}; net profit ${fmt(base.netProfit)} (${percentText(base.netMarginPct)} net margin).`;
  const sourceNote = `${base.sourceNote.trim()}${base.annualised ? ' The year held fewer than twelve months; its figures were scaled to a full year.' : ''}`;
  if (view.defaultSurplus === null) {
    return {
      hasFigures: true,
      basis,
      sourceNote,
      surplusLine: `${base.yearLabel} shows no profit, so there is no surplus to allocate by default: enter the amount to allocate.`,
      amountRequired: true,
      amountHint: `The surplus after tax, reserves and committed obligations. ${example}`,
    };
  }
  const amount = fmt(view.defaultSurplus);
  return {
    hasFigures: true,
    basis,
    sourceNote,
    surplusLine: `APX will allocate ${amount} — the net profit for ${base.yearLabel}.`,
    amountRequired: false,
    amountHint: `Optional. Leave it empty to allocate ${amount}, or enter the surplus actually free to invest. ${example}`,
  };
}
