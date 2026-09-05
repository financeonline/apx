/**
 * The engine version (FINANCIAL_ENGINE.md §6).
 *
 * Semver, and the rules for bumping it are not stylistic:
 *   PATCH — a bug fix that changes NO golden output.
 *   MINOR — a new metric or a new warning; existing values unchanged.
 *   MAJOR — any change to an existing formula, to precedence, or to a category set.
 *
 * A major bump enqueues a full recalculation for every active organization at deploy time. Until it
 * completes, an organization keeps reading its old snapshots: pointers stand until they are replaced
 * atomically per period, so nobody ever sees half a year computed one way and half the other.
 *
 * The version is written onto every `calculation_runs` row, which is what makes the reproducibility
 * guarantee checkable: given a run id, its fingerprint and the tagged version from git, a replay
 * must reproduce every snapshot value.
 */
export const ENGINE_VERSION = '1.0.0';

/** Bumped independently of the engine (§6). */
export const HEALTH_CONFIG_VERSION = 'health.config.v1';
export const ALERT_RULE_VERSION = 'alerts.rules.v1';

/** At most this many consecutive months per chunk (§2.4). */
export const CHUNK_PERIODS = 12;

/** Comparison inputs read back this far before the first affected period (§2.4 step 2). */
export const COMPARISON_LOOKBACK_MONTHS = 12;
