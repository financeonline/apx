import 'server-only';
import Decimal from 'decimal.js';
import type { DocumentData, DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { raise } from '../raise';
import { orgCollection, orgRow, type OrgTable } from '../schema';
import { readerOf, uidOf, type Db, type Reader } from '../types';
import { hasPermission, hasPermissionOf } from './access';

/**
 * Helpers of the Actions, Alerts and Reporting area (Team R), ported from the `app` schema
 * (FIRESTORE_DATA_MODEL.md §6): who may own an action, the cross-organisation lookup the
 * `p_action` / `p_alert` functions start with, the `same_org_ref` trigger's check, and the value
 * readers that stand in for SQL's casts.
 */

// ── Locating a row by id alone ───────────────────────────────────────────────────────────────────

export interface LocatedRow {
  readonly orgId: string;
  readonly ref: DocumentReference;
  readonly data: DocumentData;
}

/**
 * `select a.organization_id … from public.actions a where a.id = p_action`: the functions that are
 * handed a bare id (`api.assign_action(p_action)`, `api.set_alert_status(p_alert)`) find the row's
 * organisation first, then check the caller can reach it — `requireOrg` turns "not reachable" into
 * the same NotFound as "does not exist" (SECURITY_MODEL.md §14).
 *
 * A collection-group equality on `id` (single-field collection-group index on `{table}.id`). The
 * organisation is taken from the document's PATH, never from its `organization_id` field, so a
 * mislabelled document cannot claim another tenant.
 */
export async function locateOrgRow(fs: Firestore, table: OrgTable, id: string | null): Promise<LocatedRow | null> {
  if (!id) return null;
  const snap = await fs.collectionGroup(table).where('id', '==', id).limit(5).get();
  for (const doc of snap.docs) {
    const org = doc.ref.parent.parent;
    if (!org || org.parent.id !== 'organizations') continue;
    return { orgId: org.id, ref: doc.ref, data: doc.data() };
  }
  return null;
}

// ── Who may own an action ────────────────────────────────────────────────────────────────────────

function inWindow(a: DocumentData, now: Date): boolean {
  const t = now.getTime();
  if (a.starts_at && new Date(String(a.starts_at)).getTime() > t) return false;
  if (a.ends_at && new Date(String(a.ends_at)).getTime() <= t) return false;
  return true;
}

/**
 * `app.org_people(org)`: the active members, and the platform employees with an active, in-window
 * assignment. Exactly the SQL union — it does not look at the employee's platform status.
 */
export async function orgPeople(fs: Firestore, orgId: string, r: Reader = readerOf(), now = new Date()): Promise<string[]> {
  const [members, assignments] = await Promise.all([
    r.query(orgCollection(fs, orgId, 'organization_memberships').where('status', '==', 'active')),
    r.query(orgCollection(fs, orgId, 'organization_assignments').where('status', '==', 'active')),
  ]);
  const out = new Set<string>();
  for (const m of members.docs) out.add(String(m.get('user_id')));
  for (const a of assignments.docs) if (inWindow(a.data(), now)) out.add(String(a.get('employee_user_id')));
  return [...out];
}

/** `exists (select 1 from app.org_people(org) where id = person)`, by two document reads. */
export async function isOrgPerson(fs: Firestore, orgId: string, userId: string, r: Reader = readerOf(), now = new Date()): Promise<boolean> {
  const [m, a] = await Promise.all([
    r.get(orgRow(fs, orgId, 'organization_memberships', userId)),
    r.get(orgRow(fs, orgId, 'organization_assignments', userId)),
  ]);
  if (m.exists && m.get('status') === 'active') return true;
  return a.exists && a.get('status') === 'active' && inWindow(a.data()!, now);
}

/**
 * `app.check_action_owner(org, owner)` (20261018000035, ADR-172): an action goes only to somebody
 * who can open it — a person of the organisation holding `actions.view` — and naming anybody but
 * yourself is assigning, which needs `actions.assign`.
 */
export async function checkActionOwner(db: Db, orgId: string, owner: string | null, tx?: Transaction): Promise<void> {
  if (!owner) return;
  const r = readerOf(tx);
  if (!(await isOrgPerson(db.fs, orgId, owner, r))) {
    raise.invalid('that person has no access to this organization');
  }
  if (!(await hasPermissionOf(db.fs, owner, orgId, 'actions.view', r))) {
    raise.invalid('that person cannot see the Action Centre, so an action cannot be given to them');
  }
  if (owner !== uidOf(db) && !(await hasPermission(db, orgId, 'actions.assign', tx))) {
    raise.denied('actions.assign is required to give an action to somebody else');
  }
}

// ── same_org_ref ─────────────────────────────────────────────────────────────────────────────────

/**
 * The `app.same_org_ref(id_col, disc_col, value, table, …)` trigger, called by the writer: the
 * discriminator names the referenced table (`'-'` = names no table, so the id must be null), and a
 * non-null id must name a row of THIS organisation. A sub-collection cannot reach another tenant, so
 * "references another organization" now reads as "does not exist", which is what it is from here.
 *
 * Returns the reference to read; `null` when nothing needs checking. Reads are the caller's, so a
 * transaction can gather them before its first write.
 */
export function sameOrgRefTarget(
  fs: Firestore, orgId: string,
  where: { table: string; idCol: string; discCol: string },
  mapping: Readonly<Record<string, string>>,
  disc: string | null, id: string | null,
): DocumentReference | null {
  if (disc === null) {
    if (id !== null) raise.invalid(`${where.table}.${where.idCol} is set although ${where.table}.${where.discCol} is null`);
    return null;
  }
  const target = mapping[disc];
  if (target === undefined) {
    raise.invalid(`${where.table}.${where.discCol} = ${disc} has no table mapping on ${where.table}; add it to the same_org_ref trigger ('-' if it names no table)`);
  }
  if (target === '-') {
    if (id !== null) raise.invalid(`${where.table}.${where.idCol} is set although ${where.table}.${where.discCol} = ${disc} names no table`);
    return null;
  }
  if (id === null) return null;
  return orgRow(fs, orgId, target as OrgTable, id);
}

/** Reads a `sameOrgRefTarget` and refuses a reference to a row that does not exist. */
export async function checkSameOrgRef(
  r: Reader, ref: DocumentReference | null, where: { table: string; idCol: string },
): Promise<void> {
  if (!ref) return;
  const snap = await r.get(ref);
  if (!snap.exists) raise.invalid(`${where.table}.${where.idCol} references a row that does not exist`);
}

// ── Value readers (the SQL casts) ────────────────────────────────────────────────────────────────

/** `x::some_enum`: an unknown label was `22P02`; here it is a VALIDATION with the label named. */
export function enumValue<T extends string>(values: readonly T[], value: unknown, what: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    raise.invalid(`invalid input value for enum ${what}: "${String(value)}"`);
  }
  return value as T;
}

/**
 * `x::numeric` as stored (FIRESTORE_DATA_MODEL.md §3: a decimal string). PostgreSQL keeps the scale
 * it was given (`12.50` stays `12.50`) and drops leading zeros; so does this. Not a number → VALIDATION.
 */
export function numericString(value: unknown): string {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  let d: Decimal;
  try {
    d = new Decimal(text);
  } catch {
    raise.invalid(`invalid input syntax for type numeric: "${text}"`);
  }
  if (!d.isFinite()) raise.invalid(`invalid input syntax for type numeric: "${text}"`);
  const m = /\.(\d+)$/.exec(text);
  return d.toFixed(m && !/e/i.test(text) ? m[1]!.length : Math.max(d.decimalPlaces(), 0));
}

/** `x::date`: `YYYY-MM-DD` (an ISO timestamp is cut to its date, as the cast did); null stays null. */
export function dateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    raise.invalid(`invalid input syntax for type date: "${text}"`);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** A jsonb `->>` read: SQL text or null (a JSON number or boolean reads as its text). */
export function textOf(obj: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = obj?.[key];
  if (v === undefined || v === null) return null;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** `nullif(x, '')::uuid` and friends: empty is null. */
export function nonEmpty(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

/** bytea arrives as hex, sometimes with PostgREST's `\x`; it is stored as lowercase hex without it. */
export function hexValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/^\\x/i, '').toLowerCase();
  if (!/^([0-9a-f]{2})*$/.test(text)) raise.invalid('invalid hexadecimal data');
  return text;
}

/** The PostgreSQL sentence for a CHECK constraint the row would break (`23514` → CONFLICT). */
export function checkViolation(table: string, constraint: string): never {
  return raise.conflict(`new row for relation "${table}" violates check constraint "${constraint}"`);
}

export const ACTION_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export const ACTION_STATUSES = ['open', 'in_progress', 'completed', 'dismissed'] as const;
export const ACTION_SOURCES = ['ai', 'alert', 'health_score', 'user', 'report'] as const;
export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;
export const ALERT_REASONS = [
  'user', 'condition_cleared', 'record_removed', 'rule_retired', 'severity_increased', 'condition_returned',
] as const;
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const ALERT_SUBJECTS = ['none', 'account', 'counterparty', 'bank_transaction', 'recurring_group', 'standard_category'] as const;
export const ALERT_KEY_KINDS = ['state', 'event'] as const;
export const REPORT_KINDS = [
  'monthly_management', 'daily_brief', 'weekly_intelligence', 'adviser', 'custom_ai', 'funding_readiness',
] as const;
