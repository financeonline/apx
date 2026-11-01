import 'server-only';
import type { DocumentData, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { Permission } from '@/core/permissions';
import {
  effectivePermission, isSuperAdmin, orgRoleOf, adviserOrgIds, type OrgRole,
} from './app/access';
import { globalRow, inChunks, orgCollection, orgRow, type OrgTable } from './schema';
import { readerOf, uidOf, type Db } from './types';

/**
 * Row-level security, ported (FIRESTORE_DATA_MODEL.md §5).
 *
 * On PostgreSQL a page read tables with the user's JWT and every SELECT policy filtered what came
 * back. Firestore's rules refuse all client reads, so the server reads with the Admin SDK and THIS
 * file is the filter: `orgQuery(db, orgId, table)` returns a query on that organisation's
 * collection only when the caller's policy admits the table, narrowed the way the policy narrows
 * rows; `orgRows` runs it and applies any row-level predicate a query cannot express.
 *
 * Every policy is transcribed from `pg_policies` and named after it. A table with no entry here is
 * readable by NO user — fail closed, as a table with RLS on and no policy was.
 *
 * A policy that does not admit the caller returns an EMPTY result, never an error: that is what
 * RLS did, and pages are written for it.
 */

export interface ReadCtx {
  readonly db: Db;
  readonly orgId: string;
  readonly uid: string;
  /** The effective role in this organisation (accessible_org_roles), or null. */
  readonly role: OrgRole | null;
  has(perm: Permission): Promise<boolean>;
  any(...perms: Permission[]): Promise<boolean>;
  /** `app.frozen_org_ids_with_any_permission`: a suspended organisation, judged by the underlying role. */
  frozenAny(...perms: Permission[]): Promise<boolean>;
  features(): Promise<Record<string, unknown>>;
}

type Where = readonly [field: string, op: FirebaseFirestore.WhereFilterOp, value: unknown];

/** What a policy decided: no rows, every row, rows narrowed by `where`, and/or rows passing `keep`. */
export type Decision =
  | false
  | {
    readonly where?: readonly Where[];
    readonly keep?: (rows: DocumentData[]) => Promise<DocumentData[]>;
  };

type Policy = (c: ReadCtx) => Promise<Decision>;

const ALL: Decision = {};
const MANAGERS: ReadonlySet<OrgRole> = new Set(['owner', 'admin', 'super_admin']);
const AI_OVERSEERS: ReadonlySet<OrgRole> = new Set(['owner', 'admin', 'employee', 'super_admin']);

const anyOf = (...perms: Permission[]): Policy => async (c) => ((await c.any(...perms)) ? ALL : false);
const reachable: Policy = async (c) => (c.role ? ALL : false);

const flag = (features: Record<string, unknown>, key: string): boolean => features[key] === true || features[key] === 'true';
const moduleOn = (features: Record<string, unknown>, key: string): boolean => !(key in features) || features[key] === true;

const POLICIES: Partial<Record<OrgTable, Policy>> = {
  access_requests: async (c) => {
    if (!c.role) return false;
    return (await c.has('users.manage' as Permission)) ? ALL : { where: [['requester_id', '==', c.uid]] };
  },
  account_category_history: anyOf('financials.view'),
  accounts: anyOf('financials.view', 'banking.view'),
  action_comments: anyOf('actions.view'),
  actions: anyOf('actions.view'),
  ai_conversations: async (c) => {
    if (!(await c.has('ai.use'))) return false;
    return c.role && AI_OVERSEERS.has(c.role) ? ALL : { where: [['user_id', '==', c.uid]] };
  },
  ai_feedback: async (c) => {
    if (!(await c.has('ai.use'))) return false;
    return c.role && AI_OVERSEERS.has(c.role) ? ALL : { where: [['user_id', '==', c.uid]] };
  },
  // A message is visible when its conversation is (the policy is an EXISTS over ai_conversations).
  ai_messages: async (c) => {
    const parent = await POLICIES.ai_conversations!(c);
    if (parent === false) return false;
    if (!parent.where) return ALL;
    return {
      keep: async (rows) => {
        const visible = await visibleIds(c, 'ai_conversations', rows.map((r) => String(r.conversation_id)));
        return rows.filter((r) => visible.has(String(r.conversation_id)));
      },
    };
  },
  ai_tool_calls: async (c) => ((await c.has('ai.use')) && c.role && AI_OVERSEERS.has(c.role) ? ALL : false),
  alert_revisions: anyOf('financials.view', 'alerts.manage'),
  alerts: async (c) => ((await c.any('financials.view', 'alerts.manage')) || (await c.frozenAny('financials.view', 'alerts.manage')) ? ALL : false),
  bank_accounts: anyOf('banking.view', 'financials.view'),
  bank_transactions: anyOf('banking.view', 'financials.view'),
  budget_lines: anyOf('financials.view'),
  calculation_runs: anyOf('financials.view', 'reports.view'),
  campaign_spend: anyOf('customers.view', 'financials.view'),
  campaigns: anyOf('customers.view', 'financials.view'),
  category_history: anyOf('banking.view', 'financials.view'),
  counterparties: anyOf('financials.view', 'banking.view', 'customers.view'),
  engagement_events: anyOf('actions.view'),
  engagement_items: anyOf('actions.view'),
  evidence_bundles: async (c) => {
    if (!(await c.has('financials.view'))) return false;
    if (c.role && MANAGERS.has(c.role)) return ALL;
    // An AI answer's evidence is its asker's, or a manager's (the policy's EXISTS over ai_messages).
    return {
      keep: async (rows) => {
        const ai = rows.filter((r) => r.kind === 'ai_response');
        if (ai.length === 0) return rows;
        const own = await ownAiMessageIds(c, ai.map((r) => String(r.origin_id)));
        return rows.filter((r) => r.kind !== 'ai_response' || own.has(String(r.origin_id)));
      },
    };
  },
  evidence_items: async (c) => {
    const parent = await POLICIES.evidence_bundles!(c);
    if (parent === false) return false;
    if (!parent.keep) return ALL;
    return {
      keep: async (rows) => {
        const visible = await visibleIds(c, 'evidence_bundles', rows.map((r) => String(r.bundle_id)));
        return rows.filter((r) => visible.has(String(r.bundle_id)));
      },
    };
  },
  fiscal_periods: reachable,
  forecast_runs: anyOf('financials.view'),
  forecast_values: anyOf('financials.view'),
  funding_assessments: async (c) => ((await c.has('reports.view')) && flag(await c.features(), 'funding_readiness') ? ALL : false),
  funding_current: async (c) => ((await c.has('reports.view')) && flag(await c.features(), 'funding_readiness') ? ALL : false),
  health_current: anyOf('dashboard.view'),
  health_scores: anyOf('dashboard.view'),
  import_batches: anyOf('imports.review'),
  import_mappings: anyOf('imports.review'),
  import_rows: async (c) => ((await c.has('imports.review')) && (await c.any('banking.view', 'financials.view')) ? ALL : false),
  investment_reports: async (c) => ((await c.has('reports.view')) && moduleOn(await c.features(), 'module_investment') ? ALL : false),
  invitations: async (c) => (c.role && MANAGERS.has(c.role) ? ALL : false),
  invoice_lines: anyOf('financials.view', 'customers.view'),
  invoices: anyOf('financials.view', 'customers.view'),
  ledger_entries: anyOf('financials.view'),
  marketing_channels: anyOf('customers.view', 'financials.view'),
  marketing_reports: async (c) => ((await c.has('reports.view')) && moduleOn(await c.features(), 'module_marketing') ? ALL : false),
  member_login_claims: async (c) => ({ where: [['created_by', '==', c.uid]] }),
  member_permission_overrides: async (c) => {
    if (!c.role) return false;
    return (await c.has('users.view' as Permission)) ? ALL : { where: [['user_id', '==', c.uid]] };
  },
  metric_current: async (c) => {
    if (!c.role) return false;
    if ((await c.has('financials.view')) || (await c.frozenAny('financials.view'))) return ALL;
    const counterparty = (await c.has('customers.view')) || (await c.frozenAny('customers.view'));
    return {
      keep: async (rows) => rows.filter((r) => r.dimension_type === 'none' || r.dimension_type === 'standard_category'
        || (counterparty && r.dimension_type === 'counterparty')),
    };
  },
  metric_snapshots: async (c) => {
    if (await c.has('financials.view')) return ALL;
    const customers = await c.has('customers.view');
    const dashboard = await c.has('dashboard.view');
    const frozenFin = await c.frozenAny('financials.view');
    const frozenCust = await c.frozenAny('customers.view');
    if (!customers && !dashboard) return false;
    return {
      keep: async (rows) => {
        const current = dashboard ? await currentSnapshotIds(c, rows.map((r) => String(r.id))) : new Set<string>();
        return rows.filter((r) => {
          if (customers && r.dimension_type === 'counterparty') return true;
          if (!dashboard || !current.has(String(r.id))) return false;
          return r.dimension_type === 'none' || r.dimension_type === 'standard_category' || frozenFin
            || (r.dimension_type === 'counterparty' && frozenCust);
        });
      },
    };
  },
  // The department dashboard's monthly targets: everyone who sees the dashboard sees the goals. They
  // are written only by `api.set_monthly_targets` (financials.view + settings.manage).
  monthly_targets: anyOf('dashboard.view'),
  notifications: async (c) => (c.role ? { where: [['user_id', '==', c.uid]] } : false),
  opportunities: anyOf('customers.view', 'financials.view'),
  organization_assignments: async (c) => (c.role && MANAGERS.has(c.role) ? ALL : { where: [['employee_user_id', '==', c.uid]] }),
  organization_memberships: async (c) => (c.role && MANAGERS.has(c.role) ? ALL : { where: [['user_id', '==', c.uid]] }),
  organization_profiles: anyOf('reports.view', 'customers.view'),
  ownership_transfers: async (c) => (c.role && MANAGERS.has(c.role) ? ALL : { where: [['nominee_user_id', '==', c.uid]] }),
  period_balances: anyOf('financials.view'),
  platform_org_settings: async (c) => ((await isSuperAdmin(c.db.fs, c.uid)) ? ALL : false),
  products: anyOf('customers.view', 'financials.view'),
  record_status_events: anyOf('financials.view'),
  recurring_payment_groups: anyOf('banking.view', 'financials.view'),
  report_completeness_attestations: anyOf('imports.review'),
  report_files: async (c) => {
    if (!(await c.has('reports.view'))) return false;
    const financials = await c.has('financials.view');
    const reports = await POLICIES.reports!(c);
    return {
      where: [['deleted_at', '==', null]],
      keep: async (rows) => {
        const ids = rows.map((r) => r.report_id).filter((id): id is string => typeof id === 'string');
        const visible = reports === false ? new Set<string>() : await visibleIds(c, 'reports', ids);
        return rows.filter((r) => (r.report_id == null ? financials : visible.has(String(r.report_id))));
      },
    };
  },
  reports: async (c) => {
    if (!(await c.has('reports.view'))) return false;
    const financials = await c.has('financials.view');
    const funding = flag(await c.features(), 'funding_readiness');
    return {
      keep: async (rows) => rows.filter((r) => (r.report_kind !== 'custom_ai' || r.requested_by === c.uid)
        && (r.report_kind !== 'funding_readiness' || funding)
        && (r.report_kind === 'monthly_management' || r.report_kind === 'funding_readiness' || financials)),
    };
  },
  scenario_runs: anyOf('financials.view'),
  scenario_values: anyOf('financials.view'),
  source_documents: anyOf('documents.view', 'imports.review'),
};

/**
 * Builds the caller's read context for one organisation, memoised per handle and organisation: the
 * role, every permission check and the organisation's features are resolved once per request,
 * however many rows and tables the page reads (a page builds its handle once per request).
 */
const ctxCache = new WeakMap<Db, Map<string, Promise<ReadCtx | null>>>();

export function readCtx(db: Db, orgId: string): Promise<ReadCtx | null> {
  let perDb = ctxCache.get(db);
  if (!perDb) { perDb = new Map(); ctxCache.set(db, perDb); }
  let hit = perDb.get(orgId);
  if (!hit) { hit = buildReadCtx(db, orgId); perDb.set(orgId, hit); }
  return hit;
}

async function buildReadCtx(db: Db, orgId: string): Promise<ReadCtx | null> {
  const uid = uidOf(db);
  if (!uid) return null;
  const role = await orgRoleOf(db.fs, uid, orgId);
  const cache = new Map<string, Promise<boolean>>();
  const has = (perm: Permission) => {
    let hit = cache.get(perm);
    if (!hit) { hit = effectivePermission(db.fs, uid, orgId, role, perm); cache.set(perm, hit); }
    return hit;
  };
  let underlying: Promise<string | null> | null = null;
  let features: Promise<Record<string, unknown>> | null = null;
  return {
    db, orgId, uid, role, has,
    async any(...perms) {
      for (const p of perms) if (await has(p)) return true;
      return false;
    },
    async frozenAny(...perms) {
      if (role !== 'suspended_member') return false;
      underlying ??= underlyingRole(db, orgId, uid);
      const u = await underlying;
      for (const p of perms) if (await effectivePermission(db.fs, uid, orgId, u, p)) return true;
      return false;
    },
    features() {
      features ??= globalRow(db.fs, 'organizations', orgId).get()
        .then((s) => (s.get('features') as Record<string, unknown> | undefined) ?? {});
      return features;
    },
  };
}

/**
 * The server reads as the server (the service role bypassed RLS): a job scoped to an organisation
 * reads that organisation's rows in full and NOTHING of any other — the scope is the boundary, as
 * the `x-motion-org` header was. An unscoped server handle (a sweep, the queue) reads any.
 */
function serverMayRead(db: Db, orgId: string): boolean {
  return db.actor.kind === 'service' && (db.actor.scope === null || db.actor.scope === orgId);
}

/** The policy's decision for this caller, memoised alongside the context. */
const decisionCache = new WeakMap<ReadCtx, Map<OrgTable, Promise<Decision>>>();

async function decide(db: Db, orgId: string, table: OrgTable): Promise<Decision> {
  if (serverMayRead(db, orgId)) return ALL;
  const policy = POLICIES[table];
  if (!policy) return false;
  const c = await readCtx(db, orgId);
  if (!c) return false;
  let perCtx = decisionCache.get(c);
  if (!perCtx) { perCtx = new Map(); decisionCache.set(c, perCtx); }
  let hit = perCtx.get(table);
  if (!hit) { hit = policy(c); perCtx.set(table, hit); }
  return hit;
}

async function underlyingRole(db: Db, orgId: string, uid: string): Promise<string | null> {
  const a = await orgRow(db.fs, orgId, 'organization_assignments', uid).get();
  if (a.exists && a.get('status') === 'active') return 'employee';
  const m = await orgRow(db.fs, orgId, 'organization_memberships', uid).get();
  return m.exists && m.get('status') === 'active' ? String(m.get('role')) : null;
}

/**
 * The caller's view of one organisation's table: a Firestore query to refine further
 * (`.where`, `.orderBy`, `.limit`), or null when the policy admits no rows at all.
 *
 * Use `orgRows` to run it — that applies the row predicates a query cannot express. Running the
 * query directly is only correct for a policy without `keep`; `orgRows` is always correct.
 */
export async function orgQuery(
  db: Db, orgId: string, table: OrgTable,
): Promise<{ query: Query; keep: ((rows: DocumentData[]) => Promise<DocumentData[]>) | null } | null> {
  if (!orgId) return null;
  const decision = await decide(db, orgId, table);
  if (decision === false) return null;
  let query: Query = orgCollection(db.fs, orgId, table);
  for (const [field, op, value] of decision.where ?? []) query = query.where(field, op, value);
  return { query, keep: decision.keep ?? null };
}

/**
 * Reads the rows of `table` the caller may see. `refine` adds the page's own filters, order and
 * limit. Returns plain row objects (snake_case fields, as the old PostgREST rows).
 */
export async function orgRows<T = DocumentData>(
  db: Db, orgId: string, table: OrgTable, refine?: (q: Query) => Query,
): Promise<T[]> {
  const scoped = await orgQuery(db, orgId, table);
  if (!scoped) return [];
  const snap = await (refine ? refine(scoped.query) : scoped.query).get();
  const rows = snap.docs.map((d: QueryDocumentSnapshot) => d.data());
  return (scoped.keep ? await scoped.keep(rows) : rows) as T[];
}

/** One row by id, or null when it does not exist OR the caller may not see it (indistinguishable). */
export async function orgRowById<T = DocumentData>(
  db: Db, orgId: string, table: OrgTable, id: string,
): Promise<T | null> {
  const rows = await orgRowsByIds<T>(db, orgId, table, [id]);
  return rows[0] ?? null;
}

/**
 * Several rows by id in one round trip, keeping only those the caller may see (in no particular
 * order). The policy's `where` clauses are re-applied to each fetched row, then its `keep`.
 */
export async function orgRowsByIds<T = DocumentData>(
  db: Db, orgId: string, table: OrgTable, ids: readonly string[],
): Promise<T[]> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!orgId || unique.length === 0) return [];
  const decision = await decide(db, orgId, table);
  if (decision === false) return [];
  const snaps = await db.fs.getAll(...unique.map((id) => orgRow(db.fs, orgId, table, id)));
  const rows = snaps.filter((s) => s.exists).map((s) => s.data()!)
    .filter((row) => (decision.where ?? []).every(([field, op, value]) => op !== '==' || row[field] === value));
  return (decision.keep ? await decision.keep(rows) : rows) as T[];
}

async function visibleIds(c: ReadCtx, table: OrgTable, ids: string[]): Promise<Set<string>> {
  const rows = await orgRowsByIds(c.db, c.orgId, table, ids);
  return new Set(rows.map((r) => String(r.id)));
}

async function ownAiMessageIds(c: ReadCtx, messageIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const fs = c.db.fs;
  for (const id of [...new Set(messageIds)]) {
    const m = await orgRow(fs, c.orgId, 'ai_messages', id).get();
    if (!m.exists) continue;
    const conv = await orgRow(fs, c.orgId, 'ai_conversations', String(m.get('conversation_id'))).get();
    if (conv.exists && conv.get('user_id') === c.uid) out.add(id);
  }
  return out;
}

async function currentSnapshotIds(c: ReadCtx, snapshotIds: string[]): Promise<Set<string>> {
  const current = await inChunks([...new Set(snapshotIds)], 30, async (chunk) => {
    const snap = await orgCollection(c.db.fs, c.orgId, 'metric_current').where('snapshot_id', 'in', chunk).get();
    return snap.docs.map((d) => String(d.get('snapshot_id')));
  });
  return new Set(current);
}

/** Global tables' SELECT policies. */
export async function canReadGlobal(
  db: Db, table: 'jobs' | 'api_rate_limits' | 'platform_settings' | 'platform_users' | 'portfolio_ai_turns' | 'profiles' | 'audit_events',
): Promise<boolean> {
  const uid = uidOf(db);
  if (!uid) return false;
  if (table === 'profiles' || table === 'platform_users' || table === 'portfolio_ai_turns' || table === 'audit_events') return true;
  return isSuperAdmin(db.fs, uid, readerOf());
}

/** `portfolio_ai_turns_select`: a super admin's, or the caller's own within their adviser scope. */
export async function canReadPortfolioTurn(db: Db, turn: { user_id: string; scope_organization_ids: string[] }): Promise<boolean> {
  const uid = uidOf(db);
  if (!uid) return false;
  if (await isSuperAdmin(db.fs, uid)) return true;
  if (turn.user_id !== uid) return false;
  const scope = new Set(await adviserOrgIds(db.fs, uid));
  return turn.scope_organization_ids.every((id) => scope.has(id));
}
