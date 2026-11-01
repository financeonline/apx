import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import {
  FieldPath, type CollectionReference, type DocumentReference, type Firestore, type Query, type Transaction,
} from 'firebase-admin/firestore';
import { ConflictError } from '@/core/errors';

/**
 * Where every former PostgreSQL table lives in Firestore (FIRESTORE_DATA_MODEL.md §3).
 *
 * Rules that hold for every collection, so a port is mechanical:
 *
 *  - The collection name is the table name, and field names are the column names (snake_case), so
 *    the row shapes the application already reads are unchanged.
 *  - Organisation-scoped tables are sub-collections of their organisation:
 *    `organizations/{orgId}/{table}/{id}`. A query can therefore never run across tenants by
 *    accident; reaching another organisation's data means naming it.
 *  - The document id is the row's `id` (a uuid, also stored as the `id` field), unless the table
 *    is keyed by something else — see `ORG_KEYED` and `GLOBAL`.
 *  - `organization_id` is still stored on every org-scoped document, so collection-group queries
 *    (a user's memberships across organisations, the portfolio) can filter and check it.
 *  - Timestamps are ISO-8601 UTC strings (`nowIso()`), dates are `YYYY-MM-DD`, money and other
 *    `numeric` values are decimal STRINGS (never JS numbers), jsonb is a map, and a SQL NULL is
 *    stored as `null` so equality filters on it work.
 */

/** Tables whose rows belong to one organisation: `organizations/{orgId}/{table}/{docId}`. */
export const ORG_TABLES = [
  'access_requests', 'account_category_history', 'accounts', 'action_comments', 'actions',
  'ai_conversations', 'ai_feedback', 'ai_messages', 'ai_tool_calls', 'alert_revisions', 'alerts',
  'bank_accounts', 'bank_transactions', 'budget_lines', 'calculation_runs', 'campaign_spend',
  'campaigns', 'category_history', 'counterparties', 'engagement_events', 'engagement_items',
  'evidence_bundles', 'evidence_items', 'fiscal_periods', 'forecast_runs', 'forecast_values',
  'funding_assessments', 'funding_current', 'health_current', 'health_scores', 'import_batches',
  'import_mappings', 'import_rows', 'investment_reports', 'invitations', 'invoice_lines', 'invoices',
  'ledger_entries', 'marketing_channels', 'marketing_reports', 'member_login_claims',
  'member_permission_overrides', 'metric_current', 'metric_snapshots', 'monthly_targets', 'notifications',
  'opportunities', 'organization_assignments', 'organization_memberships', 'organization_profiles',
  'ownership_transfers', 'period_balances', 'platform_org_settings', 'products',
  'record_status_events', 'recurring_payment_groups', 'report_completeness_attestations',
  'report_files', 'reports', 'scenario_runs', 'scenario_values', 'source_documents',
] as const;
export type OrgTable = (typeof ORG_TABLES)[number];

/**
 * Top-level collections. `audit_events` and `jobs` keep a nullable `organization_id` field because
 * some rows belong to no organisation (a platform event, a sweep job); `role_permissions` is gone —
 * the permission matrix in `core/permissions` is its single source.
 */
export const GLOBAL_TABLES = [
  'organizations', 'profiles', 'platform_users', 'platform_settings', 'api_rate_limits',
  'portfolio_ai_turns', 'audit_events', 'jobs', 'dashboard_feedback',
] as const;
export type GlobalTable = (typeof GLOBAL_TABLES)[number];

/**
 * Org tables whose document id is NOT a uuid `id`, because the table's key is something else:
 *
 *  - one row per organisation: the document id is the fixed string `ORG_SINGLETON_ID`;
 *  - `organization_memberships`, `organization_assignments`: the person's user id, which is what
 *    makes "one membership per person per organisation" impossible to break (the row keeps its own
 *    uuid in `id` for references);
 *  - the per-period "current" tables: the period id;
 *  - `member_permission_overrides`: `{user_id}__{permission}`;
 *  - `metric_current`: `metricCellId(...)` — the unique cell;
 *  - `monthly_targets`: the month it sets, `YYYY-MM` (one record per company per month).
 */
export const ORG_SINGLETON_ID = 'current';
export const ORG_SINGLETONS = ['organization_profiles', 'platform_org_settings'] as const;

/**
 * Global tables keyed by something other than a uuid: `profiles` and `platform_users` by the
 * Firebase Auth uid, `platform_settings` by its `key`, `api_rate_limits` by `rateLimitId(...)`,
 * `organizations` by the organisation's uuid.
 */

export function orgDoc(fs: Firestore, orgId: string): DocumentReference {
  if (!orgId) throw new Error('orgDoc requires an organization id');
  return fs.collection('organizations').doc(orgId);
}

export function orgCollection(fs: Firestore, orgId: string, table: OrgTable): CollectionReference {
  return orgDoc(fs, orgId).collection(table);
}

export function orgRow(fs: Firestore, orgId: string, table: OrgTable, id: string): DocumentReference {
  if (!id) throw new Error(`orgRow(${table}) requires an id`);
  return orgCollection(fs, orgId, table).doc(id);
}

export function globalCollection(fs: Firestore, table: GlobalTable): CollectionReference {
  return fs.collection(table);
}

export function globalRow(fs: Firestore, table: GlobalTable, id: string): DocumentReference {
  if (!id) throw new Error(`globalRow(${table}) requires an id`);
  return fs.collection(table).doc(id);
}

/** Every organisation's rows of one table — for the portfolio and platform, never a tenant page. */
export function acrossOrgs(fs: Firestore, table: OrgTable): Query {
  return fs.collectionGroup(table);
}

/**
 * Reads `values` in slices of `size` (an `in` filter takes at most 30), all slices at once, and
 * joins the results in slice order. One slice after another made a read of a few hundred ids a few
 * dozen round trips in a row — seconds on a page that asks for every current figure.
 */
export async function inChunks<V, T>(values: readonly V[], size: number, read: (slice: V[]) => Promise<T[]>): Promise<T[]> {
  const slices: V[][] = [];
  for (let i = 0; i < values.length; i += size) slices.push(values.slice(i, i + size));
  return (await Promise.all(slices.map(read))).flat();
}

/** The document id as a field to order or page by (a stable tie-breaker after any other order). */
export const documentIdField = (): FieldPath => FieldPath.documentId();

export const newId = (): string => randomUUID();
export const nowIso = (at: Date = new Date()): string => at.toISOString();
export const todayIso = (at: Date = new Date()): string => at.toISOString().slice(0, 10);

/** `{user_id}__{permission}` — the composite key of member_permission_overrides. */
export const overrideId = (userId: string, permission: string): string => `${userId}__${permission}`;

/** The composite key of the old `metric_current_cell_unique` (NULLS NOT DISTINCT). */
export function metricCellId(parts: {
  period_id: string; metric_key: string; dimension_type: string | null;
  dimension_id: string | null; dimension_key: string | null;
}): string {
  return hashKey([parts.period_id, parts.metric_key, parts.dimension_type, parts.dimension_id, parts.dimension_key]);
}

/** A stable, path-safe id from key parts; NULL and '' are kept distinct. */
export function hashKey(parts: ReadonlyArray<string | number | boolean | null | undefined>): string {
  const canonical = JSON.stringify(parts.map((p) => (p === undefined ? null : p)));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 40);
}

/**
 * Unique constraints (FIRESTORE_DATA_MODEL.md §4).
 *
 * Firestore has no unique index. A constraint becomes a guard document at
 * `organizations/{orgId}/_unique/{constraint}__{hash(key)}` (or `_unique/...` at the top level for a
 * global one) holding the id of the row that owns it. Claiming it inside the same transaction that
 * writes the row makes the pair atomic: a second writer of the same key finds the guard and gets
 * ConflictError, exactly as `23505` used to raise. A partial unique index ("one PENDING invitation per
 * email") is released by deleting the guard when the row leaves that state.
 *
 * The guard must be READ before any write in the transaction (Firestore's rule), so callers do
 * `const claim = await uniqueGuard(...).read(tx)` early and `claim.take(tx)` with the writes.
 */
export function uniqueGuard(
  fs: Firestore,
  scope: { orgId: string } | 'global',
  constraint: string,
  key: ReadonlyArray<string | number | boolean | null | undefined>,
) {
  const parent = scope === 'global' ? fs : orgDoc(fs, scope.orgId);
  const ref = parent.collection('_unique').doc(`${constraint}__${hashKey(key)}`);
  return {
    ref,
    /** Reads the guard; `owner` is the id holding the key, or null when it is free. */
    async read(tx: Transaction) {
      const snap = await tx.get(ref);
      const owner = snap.exists ? ((snap.data()?.owner_id as string | undefined) ?? null) : null;
      return {
        owner,
        /** Claims the key for `ownerId`; ConflictError when another row already holds it. */
        take(writer: Transaction, ownerId: string, message?: string) {
          if (owner && owner !== ownerId) {
            throw new ConflictError(message ?? 'That already exists.', { existingId: owner });
          }
          writer.set(ref, { owner_id: ownerId, constraint, created_at: nowIso() });
        },
        release(writer: Transaction) {
          writer.delete(ref);
        },
      };
    },
  };
}

/** Stored timestamps are ISO strings; this reads one back as a Date (null stays null). */
export function asDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}
