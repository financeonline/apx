import 'server-only';
import type { Db } from '@/db/types';
import { listCampaignSpend } from '@/modules/commercial';
import { categoryLabel, loadDimensioned, loadMetricSeries, loadPeriods, type PeriodLabel, type SnapshotRow } from '@/modules/dashboard';
import type { AnnualFacts } from '../domain/annual';
import {
  SECTION_03_KEYS, reportYears,
  type CategorySpendFact, type FigureFact, type MonthFacts, type Section03Key,
} from '../domain/financials';
import * as repo from '../data/financials-repository';

/**
 * The department dashboard's year figures (ADR-180): the facts `domain/annual.ts` adds up — Key
 * Report Indicators, "How can I Grow?", Comparative Financials and Marketing vs Revenue.
 *
 * The same reads as Section 03 (`services/financials.ts`), so the dashboard and the Marketing report
 * cannot disagree, without the per-account and per-product reads the report's cost lines and product
 * table need and the dashboard does not.
 *
 *   - Months: the latest `MONTHS_READ` periods — enough for the three financial years Comparative
 *     Financials shows plus the year in progress — INCLUDING a month still in progress, because the
 *     dashboard's Marketing vs Revenue shows the months it shows. The year totals still use complete
 *     months only (`monthHasFigures`).
 *   - Figures: `metric_current` (`loadMetricSeries`) for SECTION_03_KEYS, twelve months per read.
 *   - Marketing: `expense_by_category` and Commercial's campaign spend over the report years and the
 *     dashboard's most recent months.
 *
 * `db` is the caller's handle: every read goes through the read policies, so a reader who may not see
 * a figure gets it absent, never zero.
 */

const MONTHS_PER_READ = 12;
/** Three whole financial years and one in progress. */
const MONTHS_READ = 48;
/** The dashboard's longest window (six months) and the month before it. */
const RECENT_MONTHS = 7;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const fact = (row: SnapshotRow): FigureFact => ({
  value: row.value,
  basis: row.basis,
  warnings: row.dataQuality?.warnings ?? [],
  missing: row.dataQuality?.missing ?? [],
});

function categoryOf(row: SnapshotRow): string | null {
  if (typeof row.dimensionKey === 'string') return row.dimensionKey;
  const fromComponents = row.components.category;
  return typeof fromComponents === 'string' ? fromComponents : null;
}

/** The facts, or null when the company has no period yet. `periods` may be passed when already read. */
export async function loadAnnualFacts(
  db: Db, orgId: string, options: { readonly periods?: readonly PeriodLabel[]; readonly requestId?: string } = {},
): Promise<AnnualFacts | null> {
  const [settings, periods] = await Promise.all([
    repo.loadFinancialSettings(db, orgId),
    options.periods ? Promise.resolve(options.periods) : loadPeriods(db, orgId, options.requestId),
  ]);
  const chosen = [...periods].sort((a, b) => a.periodStart.localeCompare(b.periodStart)).slice(-MONTHS_READ);
  if (chosen.length === 0) return null;

  const series = (await Promise.all(
    chunk(chosen.map((p) => p.id), MONTHS_PER_READ)
      .map((ids) => loadMetricSeries(db, orgId, SECTION_03_KEYS, ids, options.requestId)),
  )).flat();
  const byPeriod = new Map<string, Partial<Record<Section03Key, FigureFact>>>();
  for (const row of series) {
    const figures = byPeriod.get(row.periodId) ?? {};
    figures[row.metricKey as Section03Key] = fact(row);
    byPeriod.set(row.periodId, figures);
  }
  const months: MonthFacts[] = chosen.map((p) => ({
    periodId: p.id, periodStart: p.periodStart, periodEnd: p.periodEnd, isComplete: p.isComplete,
    figures: byPeriod.get(p.id) ?? {},
  }));

  const years = reportYears(months, settings.fiscalYearStartMonth);
  const spendIds = [...new Set([
    ...years.flatMap((y) => y.months.map((m) => m.periodId)),
    ...months.filter((m) => Object.keys(m.figures).length > 0).slice(-RECENT_MONTHS).map((m) => m.periodId),
  ])];

  const [categoryRows, campaignSpend] = await Promise.all([
    Promise.all(chunk(spendIds, MONTHS_PER_READ)
      .map((ids) => loadDimensioned(db, orgId, 'expense_by_category', ids, options.requestId))).then((r) => r.flat()),
    // One read of up to 30 periods per `in`: the commercial repository chunks it.
    spendIds.length === 0 ? Promise.resolve([]) : listCampaignSpend(db, orgId, { periodIds: spendIds }),
  ]);

  const categorySpend: CategorySpendFact[] = categoryRows.flatMap((row) => {
    const category = categoryOf(row);
    return category === null ? [] : [{ periodId: row.periodId, category, label: categoryLabel(category), value: row.value }];
  });

  return {
    currency: settings.currency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    months,
    categorySpend,
    campaignSpend: campaignSpend.map((s) => ({ periodId: s.periodId, amount: s.amount })),
  };
}
