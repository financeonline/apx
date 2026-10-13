import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listCampaignSpend, listProducts } from '@/modules/commercial';
import { categoryLabel, loadDimensioned, loadMetricSeries, loadPeriods, type SnapshotRow } from '@/modules/dashboard';
import { listAccounts } from '@/modules/financials';
import {
  SECTION_03_KEYS,
  buildMarketingFinancials,
  reportYears,
  type AccountSpendFact,
  type CategorySpendFact,
  type FigureFact,
  type MonthFacts,
  type Section03Key,
} from '../domain/financials';
import type { MarketingFinancials } from '../domain/types';
import * as repo from '../data/financials-repository';

/**
 * Section 03's figures for the Marketing report (ADR-170): the facts `buildMarketingFinancials` adds
 * up, read from where the product already keeps them, inside the report's background job.
 *
 *   - The profit-and-loss figures are the engine's monthly snapshots, through the dashboard's own
 *     `metric_current` readers (`loadMetricSeries`, `loadDimensioned`) — the same rows Home and the
 *     Money pages show, so the report cannot disagree with them (UX_ARCHITECTURE.md §4).
 *   - Cost lines are `expense_by_account` (named from the chart of accounts) or, on a basis without
 *     accounts, `expense_by_category` in the Money page's words (`categoryLabel`).
 *   - Marketing spend is `expense_by_category[marketing]`, else the campaign spend recorded in
 *     Commercial (`listCampaignSpend`, the rows Marketing Efficiency reads — ADR-147).
 *   - Product sales are the invoice lines attributed to Commercial's products (ADR-102).
 *
 * `db` is the job's scoped service client; every read names the organisation. The readers are
 * unpaginated and PostgREST caps a response at 1,000 rows, so the snapshot reads go a year (twelve
 * months) at a time and the per-account read a month at a time: seven keys over twelve months, or
 * every expense account in one month, is far inside the cap.
 */

const MONTHS_PER_READ = 12;

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

/** The category a dimensioned snapshot is a breakdown of: `dimension_key`, else the components (ADR-053). */
function categoryOf(row: SnapshotRow): string | null {
  if (typeof row.dimensionKey === 'string') return row.dimensionKey;
  const fromComponents = row.components.category;
  return typeof fromComponents === 'string' ? fromComponents : null;
}

export async function loadMarketingFinancials(db: SupabaseClient, orgId: string): Promise<MarketingFinancials | null> {
  const [settings, periods] = await Promise.all([
    repo.loadFinancialSettings(db, orgId),
    loadPeriods(db, orgId),
  ]);
  const complete = periods.filter((p) => p.isComplete).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  if (complete.length === 0) return null;

  // The headline figures of every complete month: which year is the latest depends on them.
  const series = (await Promise.all(
    chunk(complete.map((p) => p.id), MONTHS_PER_READ).map((ids) => loadMetricSeries(db, orgId, SECTION_03_KEYS, ids)),
  )).flat();
  const byPeriod = new Map<string, Partial<Record<Section03Key, FigureFact>>>();
  for (const row of series) {
    const figures = byPeriod.get(row.periodId) ?? {};
    figures[row.metricKey as Section03Key] = fact(row);
    byPeriod.set(row.periodId, figures);
  }
  const months: MonthFacts[] = complete.map((p) => ({
    periodId: p.id, periodStart: p.periodStart, periodEnd: p.periodEnd, isComplete: p.isComplete,
    figures: byPeriod.get(p.id) ?? {},
  }));

  const years = reportYears(months, settings.fiscalYearStartMonth);
  const latest = years[years.length - 1];
  if (latest === undefined) return null;
  const windowIds = years.flatMap((y) => y.months.map((m) => m.periodId));
  const latestIds = latest.months.map((m) => m.periodId);

  const [categoryRows, accountRows, accounts, campaignSpend, productLines, products] = await Promise.all([
    Promise.all(chunk(windowIds, MONTHS_PER_READ).map((ids) => loadDimensioned(db, orgId, 'expense_by_category', ids))).then((r) => r.flat()),
    Promise.all(latestIds.map((id) => loadDimensioned(db, orgId, 'expense_by_account', [id]))).then((r) => r.flat()),
    listAccounts(db, orgId),
    Promise.all(chunk(windowIds, MONTHS_PER_READ).map((ids) => listCampaignSpend(db, orgId, { periodIds: ids }))).then((r) => r.flat()),
    repo.loadProductLineSales(db, orgId, windowIds),
    listProducts(db, orgId),
  ]);

  const categorySpend: CategorySpendFact[] = categoryRows.flatMap((row) => {
    const category = categoryOf(row);
    return category === null ? [] : [{ periodId: row.periodId, category, label: categoryLabel(category), value: row.value }];
  });
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const accountSpend: AccountSpendFact[] = accountRows.flatMap((row) => {
    if (row.dimensionId === null) return [];
    const account = accountById.get(row.dimensionId);
    const recorded = row.components.category;
    return [{
      periodId: row.periodId,
      accountId: row.dimensionId,
      name: account?.name ?? 'Unnamed account',
      category: typeof recorded === 'string' ? recorded : account?.standardCategory ?? 'operating_expense',
      value: row.value,
    }];
  });
  const productNames = new Map(products.map((p) => [p.id, p.name]));

  return buildMarketingFinancials({
    currency: settings.currency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    months,
    categorySpend,
    accountSpend,
    campaignSpend: campaignSpend.map((s) => ({ periodId: s.periodId, amount: s.amount })),
    productSales: productLines.map((line) => ({
      periodId: line.periodId, productId: line.productId,
      product: productNames.get(line.productId) ?? 'Unnamed product', amount: line.amount,
    })),
  });
}
