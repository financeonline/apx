import 'server-only';
import type { DocumentData, Query } from 'firebase-admin/firestore';
import type { Permission } from '@/core/permissions';
import { orgRoleOf } from './access';
import { orgRows, readCtx } from '../rls';
import { globalRow, inChunks, orgCollection, type OrgTable } from '../schema';
import { uidOf, type Db } from '../types';

/**
 * Reads for the engine's result modules — Health, Forecast, Scenarios, Funding — on Firestore
 * (FIRESTORE_DATA_MODEL.md §2, §5).
 *
 * The same service functions ran both for a person (a page, under RLS) and as the server (a job
 * inside `withOrgScope`, the service role). That split is kept: a USER handle reads through
 * `src/db/rls.ts`, the port of the policies; a SERVICE handle reads the organisation's collections
 * directly — but only the organisation its scope names when it has one (ADR-090), and nothing
 * otherwise, as the service role reading another tenant's rows would have been a bug.
 */

type Refine = (q: Query) => Query;

/** Every row of `table` the caller may read, refined by `refine` (filters, order, limit). */
export async function readRows(db: Db, orgId: string, table: OrgTable, refine?: Refine): Promise<DocumentData[]> {
  if (db.actor.kind === 'service') {
    if (db.actor.scope && db.actor.scope !== orgId) return [];
    const base = orgCollection(db.fs, orgId, table);
    const snap = await (refine ? refine(base) : base).get();
    return snap.docs.map((d) => d.data());
  }
  return orgRows(db, orgId, table, refine);
}

/** `.in(field, ids)`: chunked at Firestore's 30 values per `in`, then joined. */
export async function readRowsIn(
  db: Db, orgId: string, table: OrgTable, field: string, ids: readonly (string | null | undefined)[], refine?: Refine,
): Promise<DocumentData[]> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  return inChunks(unique, 30, (chunk) =>
    readRows(db, orgId, table, (q) => (refine ? refine(q.where(field, 'in', chunk)) : q.where(field, 'in', chunk))));
}

/**
 * One `organizations` row, or null: `organizations_select` admits the organisations the person can
 * reach (`accessible_org_roles`); the server reads its scoped organisation.
 */
export async function readOrganization(db: Db, orgId: string): Promise<DocumentData | null> {
  if (db.actor.kind === 'service') {
    if (db.actor.scope && db.actor.scope !== orgId) return null;
  } else {
    const role = await orgRoleOf(db.fs, uidOf(db), orgId);
    if (!role) return null;
  }
  const snap = await globalRow(db.fs, 'organizations', orgId).get();
  return snap.exists ? snap.data()! : null;
}

/**
 * Whether the caller reads the detail behind a figure — the decision the definer views
 * `metric_snapshot_payloads` and `health_score_breakdowns` made (ADR-172 hardening): the server
 * always; a person with `perm`, or with it under their underlying role in a suspended organisation.
 */
export async function readsDetail(db: Db, orgId: string, perm: string): Promise<boolean> {
  if (db.actor.kind === 'service') return !db.actor.scope || db.actor.scope === orgId;
  const ctx = await readCtx(db, orgId);
  if (!ctx) return false;
  return (await ctx.has(perm as Permission)) || (await ctx.frozenAny(perm as Permission));
}

/** `app.redact_metric_components`: only keys that name no ids, holding numbers, booleans, null, decimals or dates. */
export function redactMetricComponents(components: unknown): Record<string, unknown> {
  if (!components || typeof components !== 'object' || Array.isArray(components)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(components as Record<string, unknown>)) {
    if (/(^|_)ids?$/.test(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean'
      || (typeof value === 'string' && (/^-?[0-9]+(\.[0-9]+)?$/.test(value) || /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)))) {
      out[key] = value;
    }
  }
  return out;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const at = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] ?? null : null);

/**
 * `app.redact_health_breakdown`: the same dimensions, rules and sentences, with every subject,
 * record and snapshot id removed — what a reader of the overview alone is given.
 */
export function redactHealthBreakdown(breakdown: unknown): unknown[] {
  return arr(breakdown).map((d) => ({
    key: at(d, 'key'), score: at(d, 'score'), weight_config: at(d, 'weight_config'),
    weight_applied: at(d, 'weight_applied'), included: at(d, 'included'), exclusion_reason: at(d, 'exclusion_reason'),
    capped: at(d, 'capped'), cap_reason: at(d, 'cap_reason'),
    positives: at(d, 'positives') ?? [], negatives: at(d, 'negatives') ?? [],
    data_quality: { completeness: at(at(d, 'data_quality'), 'completeness'), warnings: at(at(d, 'data_quality'), 'warnings') ?? [] },
    rules: arr(at(d, 'rules')).map((r) => ({
      rule: at(r, 'rule'), result: at(r, 'result'), points: at(r, 'points'), value: at(r, 'value'),
      skipped_reason: at(r, 'skipped_reason'),
    })),
    metrics: arr(at(d, 'metrics')).map((m) => ({ metric_key: at(m, 'metric_key'), value: at(m, 'value'), snapshot_id: null })),
    conditions: arr(at(d, 'conditions')).map((c) => ({
      rule_key: at(c, 'rule_key'), subject_id: null, subject_key: null, snapshot_ids: [], record_ids: [],
    })),
    positives_structured: arr(at(d, 'positives_structured')).map((s) => ({
      template_id: at(s, 'template_id'), text: at(s, 'text'), values: at(s, 'values') ?? {}, snapshot_ids: [],
    })),
    negatives_structured: arr(at(d, 'negatives_structured')).map((s) => ({
      template_id: at(s, 'template_id'), text: at(s, 'text'), values: at(s, 'values') ?? {}, snapshot_ids: [],
    })),
  }));
}
