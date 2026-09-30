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
/**
 * 2.0.0 (ADR-120): MAJOR. The run now carries cash and the runway window between periods (existing
 * cash values change) and writes the receivables family for the first time. §6: a change to an
 * existing value is a major bump, and the first run on it recomputes each organisation's history.
 */
/**
 * 3.0.0 (ADR-124): MAJOR. Cash is solved per bank account, day by day, from what the statements state
 * (D-1, D-2); a completed month's receivables and payables need a list that states the month's END
 * (D-3); a ledger balance starts on its opening journal's DATE (D-4). It also carries ADR-123's
 * figure changes, which were released on 2.0.0 without the bump §6 requires — so organisations a
 * 2.0.0 engine computed before ADR-123 were never recomputed (audit N-6).
 *
 * The bump is ENFORCED, not remembered: `test/unit/engine-version-golden.test.ts` hashes the engine's
 * outputs over a fixed corpus and fails when they change while this string does not.
 */
export const ENGINE_VERSION = '3.0.0';

/** Bumped independently of the engine (§6). */
export const HEALTH_CONFIG_VERSION = 'health.config.v1';
export const ALERT_RULE_VERSION = 'alerts.rules.v1';

/** At most this many consecutive months per chunk (§2.4). */
export const CHUNK_PERIODS = 12;

/** Comparison inputs read back this far before the first affected period (§2.4 step 2). */
export const COMPARISON_LOOKBACK_MONTHS = 12;
