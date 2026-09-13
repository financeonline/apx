/**
 * `forecast.config.v1` — every number the forecast depends on, declared once (ADR-099).
 *
 * The same discipline as `health.config.v1`: a threshold inlined in a rule is a number nobody can
 * recover from a stored forecast months later, and "why did it say that?" is the question this
 * module exists to answer. Bumping any value here is a version bump, never an in-place edit — two
 * forecasts made under different rules must not be comparable by accident.
 *
 * Pure.
 */

export const FORECAST_METHOD = 'baseline.v1';
export const FORECAST_CONFIG_VERSION = 'forecast.config.v1';

/**
 * The fewest complete periods a metric needs before MOTION will forecast it at all.
 *
 * Three, following the precedent the health score already set — `MIN_DIMENSIONS_FOR_SCORE = 3`,
 * "fewer than three cannot describe a business". Two points are a line through noise; three is the
 * least that can show a level and whether it is holding. Nothing in the approved documents fixes a
 * number, so this one is chosen, stated and versioned rather than assumed (REQ-FC-01 "where
 * sufficient data exists").
 */
export const MIN_PERIODS = 3;

/**
 * The most recent complete periods the baseline may draw on.
 *
 * Twelve so a full year of seasonality is inside the window when it exists, and no more, because a
 * small business two years ago is often a different business.
 */
export const MAX_PERIODS = 12;

/**
 * How far ahead a forecast runs.
 *
 * Three months. `MVP_SCOPE.md` and `PRODUCT_REQUIREMENTS.md` fix no horizon, and the brief's
 * instruction where none is specified is the smallest useful implementation. Three is the shortest
 * horizon a business can act on — long enough to see a payroll run and a quarter's supplier
 * payments, short enough that a recency-weighted baseline is still a defensible statement about it.
 * Every forecast period must be a real `fiscal_periods` row; nothing here invents a month.
 */
export const HORIZON_MONTHS = 3;

/**
 * Recency weighting. The most recent period in the window weighs `n`, the oldest weighs 1.
 *
 * Linear rather than exponential because the decay constant of an exponential is a second number to
 * justify and there is nothing to justify it with.
 */
export type Weighting = 'linear_recency';
export const WEIGHTING: Weighting = 'linear_recency';

/**
 * How far from the middle a period has to sit before it stops counting as the ordinary run of
 * business (§6, one-off treatment).
 *
 * A period is excluded from the baseline when it is more than `OUTLIER_MAD_MULTIPLE` median absolute
 * deviations from the median. Median and MAD rather than mean and standard deviation, because the
 * one-off being looked for is exactly the thing that drags a mean and inflates a standard deviation
 * — the statistic used to find an outlier must not be the statistic the outlier breaks.
 *
 * 3.5 is the conventional modified-Z threshold. It is deliberately loose: excluding a real month is
 * worse than including an odd one, because the excluded month is invisible in the answer while an
 * odd one is at least in the range a reader can see.
 */
export const OUTLIER_MAD_MULTIPLE = 3.5;

/**
 * Never exclude so much that the baseline stops being about the business.
 *
 * At most one period in four may be dropped as a one-off; past that the spread IS the business and
 * the honest answer is a forecast over everything, flagged as volatile.
 */
export const MAX_EXCLUDED_FRACTION = 0.25;

/** Why a metric could not be forecast. Rendered in words by the presentation layer, never raw. */
export const INSUFFICIENCY_REASONS = [
  'no_history',
  'too_few_periods',
  'history_not_continuous',
  'no_complete_periods',
  'metric_not_computable',
] as const;
export type InsufficiencyReason = (typeof INSUFFICIENCY_REASONS)[number];

/**
 * How much the reader should lean on the answer, in words rather than a number.
 *
 * §19 forbids an invented percentage. These three come from conditions the server can actually
 * check: how many periods the baseline rests on, and whether any of them were incomplete or rested
 * on estimated figures.
 */
export const FORECAST_BASES = ['strong', 'limited', 'weak'] as const;
export type ForecastBasis = (typeof FORECAST_BASES)[number];

/** A full window with nothing excluded and nothing estimated. */
export const STRONG_MIN_PERIODS = 6;
