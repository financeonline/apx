# APX — Firestore Data Model and the Port from PostgreSQL

Status: the only database of APX (branch `feat/firebase`, 2026-10-28; ADR-178). Replaces
`DATABASE_ARCHITECTURE.md` (PostgreSQL / Supabase) as the description of how APX stores data. Owner
decisions 2026-10-28: full move from Supabase to Firebase (Firestore, Firebase Authentication,
Firebase Storage), then Supabase removed from the code completely; developed and tested on the local
Firebase emulators first, connected to a real Firebase project later.

## 1. What runs where

| Concern | Before (Supabase) | Now (Firebase) |
|---|---|---|
| Data | PostgreSQL tables, RLS, SQL functions | Firestore collections; checks and logic in TypeScript under `src/db` |
| Sign-in | Supabase Auth (GoTrue), JWT cookie | Firebase Authentication; server-verified **session cookie** `__session` |
| Files | Supabase Storage buckets | Firebase Storage (same bucket/path layout), served only by the server |
| Local | `supabase start` (Docker) | `npm run db:start` — Auth 9099, Firestore 8080, Storage 9199, UI 4000 |
| Project | local Supabase | `demo-apx` (a `demo-` project can never reach Google's servers) |

Connecting a real project later: set `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, the web
config (`NEXT_PUBLIC_FIREBASE_*`) and service-account credentials, unset the `*_EMULATOR_HOST`
variables, deploy `firebase/firestore.rules`, `firebase/storage.rules` and
`firebase/firestore.indexes.json`. No code change.

## 2. The security model

The browser **never** talks to Firestore or Storage: `firebase/firestore.rules` and
`firebase/storage.rules` deny everything. All access is the Next.js server using the Admin SDK, and
the Admin SDK bypasses rules — so the checks in `src/db` ARE the tenant boundary, as RLS and the
`SECURITY DEFINER` functions were. Consequences every port must keep:

1. **Reads** that a page made with the user's JWT under RLS go through `src/db/rls.ts`
   (`orgRows`, `orgRowById`, `orgQuery`). Each table's policy is transcribed there from
   `pg_policies`; a table without a policy is unreadable. A refused read returns **no rows**, not an
   error.
2. **Writes** go through `api.*` functions (`callApi(db, name, args)`), each re-checking the
   caller with `requireOrg` / `requirePermission` (`src/db/app/access.ts`) exactly where the SQL
   function called `app.require_org` / `app.require_permission`.
3. **Server facts** go through `api_server.*` functions, which first call `requireServer(db)`
   (or `requireScope(db, org)` for an organisation-scoped write).
4. The caller is `db.actor` (`src/db/types.ts`): `user` (verified session), `anon`, or `service`
   (with the job's organisation `scope`). There is no ambient `auth.uid()`; pass it explicitly.
5. NotFound, never PermissionDenied, for an organisation the caller cannot reach (§14 of the
   security model) — `requireOrg` already does this.

## 3. Collections

* Organisation-scoped tables are sub-collections: `organizations/{orgId}/{table}/{docId}`
  (`ORG_TABLES` in `src/db/schema.ts`). Use `orgCollection`, `orgRow`.
* Global: `organizations`, `profiles`, `platform_users`, `platform_settings`, `api_rate_limits`,
  `portfolio_ai_turns`, `audit_events`, `jobs` (`globalCollection`, `globalRow`).
* `role_permissions` is gone: `core/permissions` `ROLE_MATRIX` is the only source.
* Collection = table name; field = column name (snake_case). Every org document also stores
  `organization_id`. Collection-group queries (`acrossOrgs`) serve the portfolio and platform.

Document ids:

| Table | Document id |
|---|---|
| most tables | the row's uuid `id` (also stored as a field); `newId()` |
| `organizations`, `profiles`, `platform_users` | org uuid / Firebase Auth uid / Auth uid |
| `organization_memberships`, `organization_assignments` | the member's / employee's user id (row keeps its own `id`) |
| `fiscal_periods` | `periodId(orgId, period_start)` — deterministic uuid (`src/db/app/shared.ts`) |
| `organization_profiles`, `platform_org_settings` | `ORG_SINGLETON_ID` (`'current'`) |
| `health_current`, `funding_current` | the `period_id` |
| `member_permission_overrides` | `overrideId(user_id, permission)` |
| `metric_current` | `metricCellId({...})` |
| `platform_settings` | its `key` |
| `api_rate_limits` | `hashKey([actor, bucket, window_start])` |
| `audit_events`, `record_status_events` | uuid (they were `bigint` identities; an id is now a string) |

Values: timestamps are ISO-8601 UTC strings (`nowIso()`); dates `YYYY-MM-DD`; **money and every
`numeric` is a decimal string** (use `decimal.js`, never JS arithmetic on money); jsonb is a map;
arrays are arrays; enums are strings; NULL is stored as `null` (never omit a column — equality
filters on null depend on it). `undefined` is refused by the SDK on purpose.

## 4. Constraints and triggers

* **Unique constraints** become guard documents, claimed in the same transaction as the row:
  `uniqueGuard(fs, {orgId} | 'global', '<constraint name>', [key parts])` — `read(tx)` early,
  `take(tx, ownerId)` with the writes, `release(tx)` when the row leaves a partial index's state.
  Use the constraint names from `pg_indexes` (e.g. `accounts_org_normalized_unique`).
* **Foreign keys / `same_org_ref`**: org-scoped sub-collections make a cross-tenant reference
  impossible to resolve; still check a referenced row EXISTS in the same organisation where the
  SQL did, and raise `invalid('… references a row that does not exist')`.
* **Triggers** do not exist. Every trigger's effect must be done by the writing function itself:
  `set_updated_at` (set `updated_at: nowIso()`), audit triggers (`prepareAudit`), status history
  (`writeRecordStatusEvent`), category history, `period_assign` (`preparePeriods`),
  `derive_normalized_name` (`normalizeName`), notifications (`prepareNotify`), recalculation
  (`prepareRecalculation`), append-only / immutability guards (simply never offer the mutation),
  `flag_runs_stale`, etc. Read the trigger list for your tables in the schema dump.

## 5. Reads (RLS)

`src/db/rls.ts`. `orgRows(db, orgId, table, q => q.where(...).orderBy(...).limit(n))` returns plain
rows. PostgREST embedded selects (`select('*, accounts(name)')`) become a second read: collect the
ids, `fs.getAll(...refs)` or `where('id', 'in', chunk)` (≤ 30 per `in`), and join in TypeScript.
Aggregates (`sum`, `count`, `group by`) are computed in TypeScript over the rows (with `Decimal`).

## 6. Function contract

`src/db/registry.ts`. An `api.*` / `api_server.*` SQL function becomes a TypeScript function with
the same name, the same `p_` arguments and the same result shape (`DbFunction = (db, args) =>
Promise<unknown>`), registered in its area file `src/db/api/<area>.ts` or
`src/db/api_server/<area>.ts` (the indexes reject a name defined twice). `raise exception` →
`raise.notFound() / denied(s) / invalid(s) / conflict(s) / quota(s)` with the SQL's sentence.
`app.*` helpers used by one area live with that area's file; helpers used by several live in
`src/db/app/`.

## 7. Transactions

`runTx(db, async (tx) => …)` (`src/db/tx.ts`). Firestore requires **every read before the first
write**, and may **re-run** the function on contention — so: gather (reads, permission checks,
guard reads, `prepare*` helpers), decide, then write; no side effects outside `tx`. A batch larger
than one transaction can hold (import rows) is written with `fs.bulkWriter()` in a state that is not
yet visible (e.g. the batch stays `uploading`), then flipped visible in one transaction.

## 8. Where each function went

Area files under `src/db/api` and `src/db/api_server`. The table of every function and its area is
in `docs/FIRESTORE_PORT_PLAN.md`.

## 9. Tests

`npm run test:integration` runs `vitest --project integration` inside
`firebase emulators:exec`. `test/integration/setup.ts`: `clientFor(uid)` (a user handle),
`serviceClientScoped(org?)`, `rpc(db, fn, args)` → `{data, error}`, `sqlstate(error)` for ported
assertions, `createAuthUser(email)` (async), `fs()` for fixtures, `resetFixtures()`.
