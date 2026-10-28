import 'server-only';
import type { DbFunctions } from '../registry';
import { aggregateFunctions } from '../app/engine-aggregate';
import { runFunctions } from '../app/engine-runs';
import { bankingFunctions } from '../app/engine-banking';
import { resultFunctions } from '../app/engine-results';

/**
 * `api_server.*` functions of the financial engine, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md
 * §8; FINANCIAL_ENGINE.md §2.4):
 *
 *  - the reads a calculation chunk aggregates from (`engine-aggregate.ts`): the GROUP BY / SUM
 *    queries, computed in TypeScript with decimal.js over the organisation's rows;
 *  - the run's own writes (`engine-runs.ts`): the run row, each chunk's snapshots and pointers, the
 *    finish (and a failed run's restore), period completeness, Health scores and metric bundles;
 *  - the banking pass (`engine-banking.ts`);
 *  - the engine's other outputs (`engine-results.ts`): forecasts, scenarios, Funding Readiness.
 *
 * Every one of them first refuses a caller that is not the server (`requireServer`), and every
 * organisation-scoped write also refuses a scope that is not that organisation (`requireScope`),
 * exactly where the SQL called `app.role_claim()` and `app.require_scope`.
 */
export const functions: DbFunctions = {
  ...aggregateFunctions,
  ...runFunctions,
  ...bankingFunctions,
  ...resultFunctions,
};
