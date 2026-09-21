export {
  FORECAST_BASES, FORECAST_CONFIG_VERSION, FORECAST_METHOD, HORIZON_MONTHS, MAX_PERIODS,
  MIN_PERIODS, OUTLIER_MAD_MULTIPLE, STRONG_MIN_PERIODS,
  type ForecastBasis, type InsufficiencyReason,
} from './domain/config';

export {
  buildBaseline, findOneOffs, selectWindow, type SufficiencyVerdict,
} from './domain/baseline';

export {
  FORECAST_LEAVES, FORECAST_METRICS, composeForecast, composeFromLevels,
  type ComposeInput, type LeafLevels, type LevelComposeInput,
} from './domain/compose';

export type {
  ActualPoint, Baseline, BasisPoint, ForecastPoint, ForecastResult, HorizonPeriod, Unforecastable,
} from './domain/types';

export {
  BASIS_LABEL, BASIS_TEXT, FORECAST_DISCLAIMER, FORECAST_HEADLINE_KEYS, FORECAST_METRIC_LABELS,
  UNAVAILABLE_TEXT, basisSentence, metricLabel, unavailableText,
} from './domain/presentation';

export {
  generateForecast,
  hasForecast,
  loadForecast,
  type ForecastMetricView,
  type ForecastPeriodView,
  type ForecastState,
  type ForecastView,
  type NoForecast,
} from './services';
