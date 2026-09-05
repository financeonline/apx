/**
 * The dashboard component library (UX_ARCHITECTURE.md §5–§7, DESIGN.md).
 *
 * Everything here renders a view model and nothing here computes or formats a financial figure:
 * the services in `modules/dashboard` do that, once (SERVICE_ARCHITECTURE.md §8). The pure parts —
 * copy, badge tones, chart geometry — are separated out so they can be asserted without a DOM.
 */

export { MetricCard, type MetricCardVariant } from './metric-card';
export { Disclaimer, HealthScoreCard, HealthScoreInline } from './health-score-card';
export { HealthExplainPanel } from './health-explain';
export { HealthHistoryChart } from './health-history-chart';
export { TrendChart } from './trend-chart';
export { PeriodPicker } from './period-picker';
export { DataQualityBadge, StatusBadgeView } from './data-quality-badge';
export { PermissionGate } from './permission-gate';

export {
  ActionsNoneEmpty,
  AlertsNoneEmpty,
  AnalystNoConversationsEmpty,
  AnalystNoDataEmpty,
  CustomersNoneEmpty,
  HomeAwaitingReviewEmpty,
  HomeBankDataOnlyEmpty,
  HomeFirstRunEmpty,
  InsightsNeedsTwoPeriodsEmpty,
  InsightsNoAdjacentMonthEmpty,
  MoneyNoInvoicesEmpty,
  PlatformNoOrganisationsEmpty,
  PortfolioNoAssignmentsEmpty,
  ReportsBeforeFirstMonthEmpty,
} from './empty-states';

export {
  DeniedState,
  ErrorState,
  LoadingCard,
  NotFoundState,
  RecalculatingBanner,
  SlowLoadingNotice,
  StaleFigure,
  StaleFigureTag,
  SuspendedBanner,
} from './states';

export {
  BAND_SCALE,
  BAND_TONES,
  CHANGE_TONE_CLASS,
  DIMENSION_DESCRIPTIONS,
  DIMENSION_LABELS,
  EXCLUSION_TEXT,
  HEALTH_DISCLAIMER,
  NOT_ENOUGH_DATA_BODY,
  NOT_ENOUGH_DATA_TITLE,
  NO_SCORE_FOR_PARTIAL_MONTH,
  PROXY_CAP_NOTE,
  RULE_LABELS,
  SKIP_TEXT,
  bandText,
  bandTone,
  changeText,
  changeTone,
  dimensionsNote,
  orderedDimensions,
  pointsText,
  skipText,
} from './health-presentation';

export type { EmptyStateCopy } from './empty-state-copy';
export type { ErrorVariant, StateCopy } from './state-copy';
export type {
  BadgeSize,
  ChartBox,
  ChartScale,
  PeriodOptionInput,
  PeriodOptionView,
  PlottedPoint,
  TrendPointView,
  TrendSeriesView,
} from './presentation';
