import type { FinancialYear, MarketingFinancials, MarketingReport } from '../domain/types';
import {
  NOT_AVAILABLE, formatReportDate, formatReportDateTime, formatReportMoney, formatReportPercent, formatShare,
  shareWidth, withoutLead,
} from './format';

/**
 * The Marketing report laid out once (ADR-170), for the page, the Word file and the PDF alike.
 *
 * The client's own document (the "Beara Beara Marketing Strategy", October 2026) is the shape: a
 * cover, an executive overview, three numbered sections with numbered subsections, and the sources.
 * Every heading, table cell and note is decided HERE, as text, and the three renderers only draw it —
 * so the screen, the Word file and the PDF can never differ in what they say or in what order. A
 * renderer that wants a different sentence changes it here, for all three.
 *
 * Three notices are APX's own, fixed, and not the model's (owner and client, 2026-10-09): the
 * competitors are directional and unverified; the budget split is illustrative, not approved spend;
 * Section 03's tables are the company's records in APX, with only the commentary written by the AI.
 * A report with no figures says so where Section 03 would be, rather than leaving a silent gap.
 *
 * Pure: a report in, a presentation out. No I/O, no clock.
 */

/** A table cell: its text (several lines separated by "\n") and an optional quieter line beneath. */
export interface ReportCell {
  readonly text: string;
  readonly detail: string | null;
}

export interface ReportTable {
  /** For screen readers, and the PDF's alternative text. */
  readonly caption: string;
  readonly columns: readonly string[];
  /** One flag per column: true where the column holds figures (right-aligned). */
  readonly numeric: readonly boolean[];
  /** Relative column widths for the Word file and the PDF; they add up to 100. */
  readonly widths: readonly number[];
  readonly rows: readonly (readonly ReportCell[])[];
}

export interface PresentedConcept {
  /** "01". */
  readonly number: string;
  readonly title: string;
  readonly description: string;
  readonly purpose: string;
}

export interface PresentedShare {
  readonly label: string;
  /** "35%". */
  readonly share: string;
  /** "35%" as a CSS width for the page's bar, or null when the share is not a number. */
  readonly width: string | null;
}

export type NoticeTone = 'info' | 'warn';

export type ReportBlock =
  /** A paragraph, with an optional bold lead ("Strategic objective:"). */
  | { readonly kind: 'paragraph'; readonly lead: string | null; readonly text: string }
  | { readonly kind: 'bullets'; readonly items: readonly string[] }
  | { readonly kind: 'table'; readonly table: ReportTable }
  /** The document's own small italic notes ("These brands are directional comparators…"). */
  | { readonly kind: 'note'; readonly text: string }
  /** APX's fixed notices: the page shows a banner, the files a shaded paragraph. */
  | { readonly kind: 'notice'; readonly tone: NoticeTone; readonly title: string; readonly text: string }
  | { readonly kind: 'concepts'; readonly items: readonly PresentedConcept[] }
  /** "Proposed effort split: everyday fashion 35%; …", which the page also draws as a bar. */
  | { readonly kind: 'split'; readonly lead: string; readonly shares: readonly PresentedShare[]; readonly note: string | null };

export interface PresentedSubsection {
  /** An anchor id, unique in the report. */
  readonly id: string;
  /** "1.2", or null for an unnumbered closing part ("Financial conclusion…"). */
  readonly number: string | null;
  readonly title: string;
  readonly blocks: readonly ReportBlock[];
}

export interface PresentedSection {
  /** An anchor id: "overview", "section-01" … "sources". */
  readonly id: string;
  /** "SECTION 01", or null for the overview and the sources. */
  readonly label: string | null;
  readonly title: string;
  /** What comes before the first numbered subsection (Section 03's source note and year table). */
  readonly blocks: readonly ReportBlock[];
  readonly subsections: readonly PresentedSubsection[];
}

export interface PresentedCover {
  /** "MARKETING STRATEGY". */
  readonly title: string;
  readonly organisationName: string;
  /** "LUXURY LEATHER ACCESSORIES | MARKETING & COMMERCIAL GROWTH STRATEGY". */
  readonly strapline: string;
  /** "Strategic planning report • October 2026". */
  readonly dateLine: string;
  /** Website, then the social accounts, as the analyst entered them. */
  readonly links: readonly { readonly label: string; readonly url: string }[];
}

export interface MarketingPresentation {
  /** The file's title: "Marketing strategy - Beara Beara Ltd - October 2026". */
  readonly documentTitle: string;
  readonly cover: PresentedCover;
  readonly sections: readonly PresentedSection[];
  /** "13 Oct 2026". */
  readonly generatedOn: string;
  readonly authorship: string;
  /** Which report, prompt and model produced this, and when — a printed page outlives its screen. */
  readonly provenance: string;
  readonly hasFinancials: boolean;
}

/** APX's fixed notices (ADR-170). Not the model's words: they are true whatever it wrote. */
export const MARKETING_NOTICES = {
  competitors: {
    title: 'Directional, not verified',
    text: 'ChatGPT suggests these comparators from the company profile and what it knows of the industry. '
      + 'APX has not checked them or their links, and they are not a ranking by market share or engagement.',
  },
  budget: {
    title: 'Illustrative, not approved spend',
    text: 'The split shows how a test budget could be divided across channels. It is not a recommendation '
      + 'to spend: set the amount from product contribution, the cost of acquiring a customer and the cash available.',
  },
  financials: {
    title: 'From the company’s records in APX',
    text: 'The tables in this section are the company’s own figures as APX holds them. '
      + 'ChatGPT wrote only the commentary around them.',
  },
  noFigures: {
    title: 'No figures yet',
    text: 'APX holds no figures for this company yet, so this report has no financial overview. '
      + 'Once figures are imported, refresh the report to add Section 03.',
  },
} as const;

export const MARKETING_AUTHORSHIP = 'Written by ChatGPT from your company profile and figures.';

/** Said instead when no model wrote it: the offline mode for demos and tests (`offline-template`). */
export const MARKETING_AUTHORSHIP_OFFLINE =
  'Written from APX’s standard playbook for the industry, without ChatGPT, from your company profile and figures.';

/** The model that names a report written offline (generate-narrative's OFFLINE_MODEL). */
const OFFLINE_MODEL = 'offline-template';

export function authorshipFor(report: Pick<MarketingReport, 'model'>): string {
  return report.model === OFFLINE_MODEL ? MARKETING_AUTHORSHIP_OFFLINE : MARKETING_AUTHORSHIP;
}

const cell = (text: string, detail: string | null = null): ReportCell => ({ text, detail });

function notice(key: keyof typeof MARKETING_NOTICES, tone: NoticeTone = 'info'): ReportBlock {
  return { kind: 'notice', tone, title: MARKETING_NOTICES[key].title, text: MARKETING_NOTICES[key].text };
}

/** Drops empty strings the model may have left in a list. */
function present(items: readonly string[]): string[] {
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

function bullets(items: readonly string[]): ReportBlock[] {
  const kept = present(items);
  return kept.length === 0 ? [] : [{ kind: 'bullets', items: kept }];
}

function paragraph(text: string | null, lead: string | null = null): ReportBlock[] {
  const body = text?.trim() ?? '';
  return body === '' ? [] : [{ kind: 'paragraph', lead, text: body }];
}

function note(text: string | null): ReportBlock[] {
  const body = text?.trim() ?? '';
  return body === '' ? [] : [{ kind: 'note', text: body }];
}

/** Equal widths for the figure columns after a first column of `first` per cent. */
function widthsWithFirst(first: number, others: number): number[] {
  if (others === 0) return [100];
  const each = Math.floor(((100 - first) / others) * 10) / 10;
  return [Math.round((100 - each * others) * 10) / 10, ...Array.from({ length: others }, () => each)];
}

function cover(report: MarketingReport): PresentedCover {
  const { profile } = report;
  const industry = profile.industry?.trim() || profile.productsServices?.trim() || report.organisationName;
  const links = [
    ...(profile.website?.trim() ? [{ label: 'Website', url: profile.website.trim() }] : []),
    ...profile.socialLinks.filter((link) => link.url.trim() !== '').map((link) => ({ label: link.label.trim() || 'Social', url: link.url.trim() })),
  ];
  return {
    title: 'MARKETING STRATEGY',
    organisationName: report.organisationName,
    strapline: `${industry.toLocaleUpperCase('en-GB')}  |  MARKETING & COMMERCIAL GROWTH STRATEGY`,
    dateLine: `Strategic planning report  •  ${report.reportDate}`,
    links,
  };
}

function overviewSection(report: MarketingReport): PresentedSection {
  const { narrative } = report;
  return {
    id: 'overview',
    label: null,
    title: 'Executive overview',
    blocks: [
      ...paragraph(withoutLead(narrative.objective, 'Strategic objective'), 'Strategic objective:'),
      ...paragraph(narrative.overview),
    ],
    subsections: [],
  };
}

function competitorSection(report: MarketingReport): PresentedSection {
  const c = report.narrative.competitors;
  const shares: PresentedShare[] = c.effortSplit.map((s) => ({ label: s.sector, share: formatShare(s.percent), width: shareWidth(s.percent) }));
  const split: ReportBlock[] = shares.length === 0 ? [] : [{ kind: 'split', lead: 'Proposed effort split:', shares, note: c.effortNote?.trim() || null }];
  return {
    id: 'section-01',
    label: 'SECTION 01',
    title: 'Competitor & sector profiling',
    blocks: [],
    subsections: [
      { id: 'brand-positioning', number: '1.1', title: 'Brand positioning', blocks: paragraph(c.brandPositioning) },
      {
        id: 'competitor-benchmarks',
        number: '1.2',
        title: 'Comparable competitor benchmarks',
        blocks: [
          {
            kind: 'table',
            table: {
              caption: 'Comparable competitor benchmarks',
              columns: ['Brand / positioning', 'Competitive learning', 'Website & social'],
              numeric: [false, false, false],
              widths: [30, 40, 30],
              rows: c.competitors.map((x) => [
                cell(x.name, x.positioning.trim() || null),
                cell(x.learning),
                cell([x.website, x.social].filter((v): v is string => Boolean(v?.trim())).join('\n') || NOT_AVAILABLE),
              ]),
            },
          },
          ...note(c.competitorNote),
          notice('competitors', 'warn'),
        ],
      },
      {
        id: 'customer-sectors',
        number: '1.3',
        title: 'Customer-sector strategy',
        blocks: [
          {
            kind: 'table',
            table: {
              caption: 'Customer-sector strategy',
              columns: ['Sector', 'Profile / purchase trigger', 'Campaign direction'],
              numeric: [false, false, false],
              widths: [26, 37, 37],
              rows: c.customerSectors.map((s) => [cell(s.sector), cell(s.profile), cell(s.campaignDirection)]),
            },
          },
          ...split,
        ],
      },
    ],
  };
}

function strategySection(report: MarketingReport): PresentedSection {
  const s = report.narrative.strategy;
  const priorities = [...s.priorities].sort((a, b) => a.priority - b.priority);
  return {
    id: 'section-02',
    label: 'SECTION 02',
    title: 'Marketing & growth strategy',
    blocks: [],
    subsections: [
      { id: 'strategy-a', number: '2.1', title: 'Strategy A — Digital customer acquisition', blocks: bullets(s.digitalAcquisition) },
      {
        id: 'strategy-b',
        number: '2.2',
        title: 'Strategy B — Product-led campaigns',
        blocks: [{
          kind: 'table',
          table: {
            caption: 'Product-led campaigns',
            columns: ['Product sector', 'Proposed positioning', 'Execution'],
            numeric: [false, false, false],
            widths: [22, 32, 46],
            rows: s.productCampaigns.map((p) => [cell(p.product), cell(p.positioning), cell(p.execution)]),
          },
        }],
      },
      { id: 'strategy-c', number: '2.3', title: 'Strategy C — Retention & basket value', blocks: bullets(s.retention) },
      {
        id: 'campaign-concepts',
        number: '2.4',
        title: 'Alternative campaign concepts',
        blocks: [
          {
            kind: 'concepts',
            items: s.concepts.map((x, i) => ({
              number: String(i + 1).padStart(2, '0'), title: x.title.trim(), description: x.description.trim(), purpose: x.purpose.trim(),
            })),
          },
          ...paragraph(withoutLead(s.recommendedCombination, 'Recommended combination'), 'Recommended combination:'),
        ],
      },
      {
        id: 'budget',
        number: '2.5',
        title: 'Illustrative marketing budget allocation',
        blocks: [
          {
            kind: 'table',
            table: {
              caption: 'Illustrative marketing budget allocation',
              columns: ['Channel', 'Share', 'Purpose'],
              numeric: [false, true, false],
              widths: [34, 14, 52],
              rows: s.budget.map((b) => [cell(b.channel), cell(formatShare(b.percent)), cell(b.purpose)]),
            },
          },
          ...note(s.budgetNote),
          notice('budget', 'warn'),
        ],
      },
      {
        id: 'first-90-days',
        number: '2.6',
        title: 'First 90 days',
        blocks: [{
          kind: 'table',
          table: {
            caption: 'First 90 days',
            columns: ['Period', 'Activities', 'Decision / deliverable'],
            numeric: [false, false, false],
            widths: [18, 46, 36],
            rows: s.first90Days.map((p) => [cell(p.period), cell(p.activities), cell(p.deliverable)]),
          },
        }],
      },
      {
        id: 'priorities',
        number: '2.7',
        title: 'Management priorities and KPIs',
        blocks: [{
          kind: 'table',
          table: {
            caption: 'Management priorities and KPIs',
            columns: ['Priority', 'Management action', 'KPI'],
            numeric: [false, false, false],
            widths: [12, 50, 38],
            rows: priorities.map((p) => [cell(String(p.priority)), cell(p.action), cell(p.kpi)]),
          },
        }],
      },
    ],
  };
}

type YearField = keyof Pick<FinancialYear,
  'turnover' | 'costOfSales' | 'costOfSalesPct' | 'grossProfit' | 'grossProfitPct' | 'adminCosts' | 'netProfit'
  | 'netProfitPct' | 'marketingSpend' | 'marketingPct'>;

/** One indicator across the years, or nothing when no year has it. */
function yearRow(f: MarketingFinancials, label: string, field: YearField, kind: 'money' | 'percent'): ReportCell[][] {
  if (f.years.every((y) => y[field] === null)) return [];
  return [[
    cell(label),
    ...f.years.map((y) => cell(kind === 'money' ? formatReportMoney(y[field], f.currency) : formatReportPercent(y[field]))),
  ]];
}

function yearTable(f: MarketingFinancials, caption: string, first: string, rows: ReportCell[][]): ReportBlock[] {
  if (f.years.length === 0 || rows.length === 0) return [];
  return [{
    kind: 'table',
    table: {
      caption,
      columns: [first, ...f.years.map((y) => (y.partial ? `${y.label} *` : y.label))],
      numeric: [false, ...f.years.map(() => true)],
      widths: widthsWithFirst(f.years.length > 2 ? 34 : 44, f.years.length),
      rows,
    },
  }];
}

const PART_YEAR_NOTE = '* Part year: fewer than twelve complete months of figures.';

function financialSection(report: MarketingReport): PresentedSection {
  const f = report.financials;
  const base = { id: 'section-03', label: 'SECTION 03', title: 'Financial overview & performance review' };
  if (f === null) return { ...base, blocks: [notice('noFigures')], subsections: [] };

  const commentary = report.narrative.financialCommentary;
  const partial = f.years.some((y) => y.partial) ? note(PART_YEAR_NOTE) : [];
  const overview = yearTable(f, 'Financial overview by year', 'Financial indicator', [
    ...yearRow(f, 'Total turnover', 'turnover', 'money'),
    ...yearRow(f, 'Cost of sales', 'costOfSales', 'money'),
    ...yearRow(f, 'Cost of sales / turnover', 'costOfSalesPct', 'percent'),
    ...yearRow(f, 'Gross profit', 'grossProfit', 'money'),
    ...yearRow(f, 'Gross profit / turnover', 'grossProfitPct', 'percent'),
    ...yearRow(f, 'Administrative costs', 'adminCosts', 'money'),
    ...yearRow(f, 'Net profit', 'netProfit', 'money'),
    ...yearRow(f, 'Net profit / turnover', 'netProfitPct', 'percent'),
  ]);

  const subsections: PresentedSubsection[] = [];
  const add = (id: string, title: string, blocks: ReportBlock[]): void => {
    if (blocks.length === 0) return;
    subsections.push({ id, number: `3.${subsections.length + 1}`, title, blocks });
  };

  const span = f.years.length === 3 ? 'Three-year performance' : f.years.length === 2 ? 'Two-year performance' : 'Performance';
  add('performance', span, paragraph(commentary?.performance ?? null));

  const sales = f.productSales;
  if (sales !== null && sales.rows.length > 0) {
    add('product-sales', `Product-sector sales: ${sales.previousLabel} vs ${sales.currentLabel}`, [
      {
        kind: 'table',
        table: {
          caption: `Product-sector sales, ${sales.previousLabel} and ${sales.currentLabel}`,
          columns: ['Sector', sales.previousLabel, sales.currentLabel, 'Change'],
          numeric: [false, true, true, true],
          widths: [34, 22, 22, 22],
          rows: sales.rows.map((r) => [
            cell(r.product), cell(formatReportMoney(r.previous, f.currency)), cell(formatReportMoney(r.current, f.currency)),
            cell(formatReportPercent(r.changePct)),
          ]),
        },
      },
      ...paragraph(commentary?.productSales ?? null),
    ]);
  }

  const spend = yearTable(f, 'Marketing expenditure by year', 'Indicator', [
    ...yearRow(f, 'Advertising & marketing', 'marketingSpend', 'money'),
    ...yearRow(f, 'Marketing / turnover', 'marketingPct', 'percent'),
  ]);
  add('marketing-expenditure', 'Marketing expenditure and cost efficiency', [
    ...spend,
    ...(spend.length === 0 && commentary !== null ? note('The figures show no advertising or marketing line.') : []),
    ...paragraph(commentary?.marketingEfficiency ?? null),
  ]);

  if (f.costLines.length > 0) {
    const latest = f.years[f.years.length - 1]?.label ?? 'Latest year';
    const withActions = commentary !== null && commentary.costActions.length > 0;
    add('cost-review', 'Cost and margin review', [{
      kind: 'table',
      table: {
        caption: `The largest cost lines of ${latest}`,
        columns: withActions ? ['Cost area', latest, 'Commercial action'] : ['Cost area', latest],
        numeric: withActions ? [false, true, false] : [false, true],
        widths: withActions ? [30, 18, 52] : [60, 40],
        rows: f.costLines.map((line, i) => [
          cell(line.name), cell(formatReportMoney(line.amount, f.currency)),
          ...(withActions ? [cell(commentary?.costActions[i]?.trim() || NOT_AVAILABLE)] : []),
        ]),
      },
    }]);
  }

  add('action-plan', 'Financial management action plan', bullets(commentary?.actionPlan ?? []));
  const conclusion = paragraph(commentary?.conclusion ?? null);
  if (conclusion.length > 0) {
    subsections.push({ id: 'financial-conclusion', number: null, title: 'Financial conclusion and strategic recommendation', blocks: conclusion });
  }

  return {
    ...base,
    blocks: [...note(f.sourceNote), notice('financials'), ...overview, ...partial],
    subsections,
  };
}

function sourcesSection(report: MarketingReport): PresentedSection {
  const items = report.sources
    .filter((s) => s.label.trim() !== '' || s.url.trim() !== '')
    .map((s) => (s.url.trim() === '' ? s.label.trim() : s.label.trim() === '' ? s.url.trim() : `${s.label.trim()}: ${s.url.trim()}`));
  return {
    id: 'sources',
    label: null,
    title: 'Source references',
    blocks: items.length === 0 ? paragraph('The company profile in APX.') : bullets(items),
    subsections: [],
  };
}

/** A table with no rows, or a list with no items, says nothing: it is dropped rather than drawn empty. */
function hasContent(block: ReportBlock): boolean {
  if (block.kind === 'table') return block.table.rows.length > 0;
  if (block.kind === 'bullets' || block.kind === 'concepts') return block.items.length > 0;
  if (block.kind === 'split') return block.shares.length > 0;
  return true;
}

const NOTHING_WRITTEN: ReportBlock = { kind: 'note', text: 'Nothing was written for this part.' };

/**
 * Sections 01 and 02 keep their numbering whatever the model returned, so a part it left empty
 * says so instead of disappearing and renumbering the rest.
 */
function tidy(section: PresentedSection): PresentedSection {
  return {
    ...section,
    blocks: section.blocks.filter(hasContent),
    subsections: section.subsections.map((sub) => {
      const blocks = sub.blocks.filter(hasContent);
      return { ...sub, blocks: blocks.length === 0 ? [NOTHING_WRITTEN] : blocks };
    }),
  };
}

export function presentMarketingReport(report: MarketingReport): MarketingPresentation {
  const generatedOn = formatReportDate(report.generatedAt);
  return {
    documentTitle: `Marketing strategy - ${report.organisationName} - ${report.reportDate}`,
    cover: cover(report),
    sections: [overviewSection(report), competitorSection(report), strategySection(report), financialSection(report), sourcesSection(report)].map(tidy),
    generatedOn,
    authorship: authorshipFor(report),
    provenance: `Generated ${formatReportDateTime(report.generatedAt)} by APX. ${authorshipFor(report)} `
      + `Model ${report.model}; prompt ${report.promptVersion}; report ${report.version}.`,
    hasFinancials: report.financials !== null,
  };
}
