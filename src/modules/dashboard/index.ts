/**
 * The dashboard read layer (UX_ARCHITECTURE.md §4, §5).
 *
 * Every figure it returns comes from `metric_current` joined to `metric_snapshots` and from nowhere
 * else. Nothing here computes a financial number: the engine does that, once, and this module reads
 * and formats what it wrote (SERVICE_ARCHITECTURE.md §8).
 */

export {
  BASIS_TEXT,
  PARTIAL_DATA_THRESHOLD,
  missingReasonText,
  statusFor,
  type StatusBadge,
  type StatusKind,
} from './domain/status';

export {
  METRIC_LABELS,
  changeFrom,
  formatValue,
  labelFor,
  toMetricCard,
  type CardOptions,
  type ChangeView,
  type MetricCardView,
  type PeriodLabel,
  type SnapshotRow,
  type VarianceRow,
} from './domain/view-models';

export {
  isRecalculating,
  loadDimensioned,
  loadLastDataDate,
  loadMetricSeries,
  loadPeriodSnapshots,
  loadPeriods,
  loadPeriodsWithData,
  loadPendingBatch,
  type PendingBatch,
} from './data/repository';

export {
  latestCompletePeriod,
  loadHealthTrend,
  loadHome,
  loadTrend,
  partialPeriod,
  type HomeState,
  type HomeView,
  type PartialMonthLine,
  type TrendSeries,
} from './services/home';

/**
 * The Money section, Customers and the chart of accounts (UX_ARCHITECTURE.md §3.2).
 * Same rule as Home: every figure is read from `metric_current`, none is computed here.
 */
export {
  AGING_BUCKETS,
  AGING_LABELS,
  CATEGORY_LABELS,
  CONFIDENCE_LABELS,
  CUSTOMER_TREND_MONTHS,
  INVOICE_PAGE_SIZE,
  TRANSACTION_PAGE_SIZE,
  accountReference,
  agingBucket,
  categoryLabel,
  dimensionKeyOf,
  formatFigure,
  isUncategorised,
  loadAccountsPage,
  loadBanking,
  loadBankAccountsForBalances,
  loadCash,
  loadCustomerDetail,
  loadCustomers,
  loadLedgerBook,
  loadMoneyIndex,
  loadPeriodScope,
  loadProfitAndLoss,
  previousPeriodOf,
  resolvePeriod,
  sortAccountsForMapping,
  toAccountRow,
  toCashAccount,
  toFigure,
  toInvoiceView,
  toTransactionView,
  type AccountRow,
  type AccountsView,
  type AgingBucket,
  type BankingFilter,
  type BankingView,
  type BreakdownRow,
  type CashAccountView,
  type CashView,
  type CustomerDetailView,
  type CustomerRow,
  type CustomerTrendPoint,
  type CustomersView,
  type FigureOptions,
  type InvoiceView,
  type LedgerBookView,
  type MoneyIndexView,
  type MoneyLink,
  type PeriodScope,
  type ProfitAndLossView,
  type TransactionView,
} from './services/money';

export {
  loadInsights,
  type InsightsState,
  type InsightsView,
  type MovementView,
} from './services/insights';
