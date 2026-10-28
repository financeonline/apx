import 'server-only';
import type { DocumentData, Firestore, Transaction } from 'firebase-admin/firestore';
import { ROLE_MATRIX, type GrantedRole, type Permission } from '@/core/permissions';
import { raise } from '../raise';
import { globalRow, newId, nowIso, orgCollection, orgRow, overrideId, uniqueGuard } from '../schema';
import { readerOf, uidOf, type Db, type Reader } from '../types';
import { prepareAudit, type PreparedAudit } from './audit';
import { SWITCHABLE_PERMISSIONS, effectivePermission, overridableRole } from './access';
import { fiscalPosition, periodId } from './shared';

/**
 * The tenancy area's own helpers (TENANCY_MODEL.md, ADR-172, ADR-173), ported from the `app` schema
 * and from the triggers on `organization_memberships` that no longer exist
 * (FIRESTORE_DATA_MODEL.md §4): the ceiling, the last-owner guard, the role-change carry-over
 * (`member_role_changed`), the one function every per-person switch goes through
 * (`app.apply_member_permission`), the departments check and the row-change audit (`audit_diff`).
 *
 * Every helper follows the transaction rule (§7): it READS and returns a `write(tx)` that only writes,
 * so a function can gather all its reads first and then write.
 */

export type Prepared = { write(tx: Transaction): void };
export const NOTHING: Prepared = { write() {} };

/** `membership_role_enum`, in its declared order — `order by m.role` sorts by this, not by name. */
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'client', 'accountant', 'third_party'] as const;
export const roleOrder = (role: string): number => {
  const i = (MEMBERSHIP_ROLES as readonly string[]).indexOf(role);
  return i < 0 ? MEMBERSHIP_ROLES.length : i;
};

/** `app.department_keys()`. */
export const DEPARTMENT_KEYS = [
  'banking', 'customers', 'actions', 'reports', 'analyst', 'planning', 'tax', 'funding', 'marketing', 'investment',
] as const;

/** `app.role_rank` / `app.ceiling_allows`: who may act on (or grant) which role. */
export function roleRank(role: string | null | undefined): number {
  switch (role) {
    case 'super_admin': return 4;
    case 'owner': return 3;
    case 'admin': return 2;
    case 'accountant': case 'client': case 'third_party': return 1;
    default: return 0;
  }
}

export function ceilingAllows(actorRole: string | null, subjectRole: string | null): boolean {
  const rank = roleRank(subjectRole);
  if (actorRole === 'super_admin') return true;
  if (actorRole === 'owner') return rank >= 1 && rank <= 3;
  if (actorRole === 'admin') return rank >= 1 && rank <= 2;
  return false;
}

/** `app.check_member_login_role`: only the company's owner creates logins, never an owner's. */
export function checkMemberLoginRole(actorRole: string | null, role: string | null): void {
  if (actorRole !== 'owner') raise.denied("only the company's owner can create team members");
  if (!role || !['admin', 'accountant', 'client', 'third_party'].includes(role)) {
    raise.invalid('a login can be created for a team member, an accountant or a 3rd party');
  }
  if (!ceilingAllows(actorRole, role)) raise.denied('you cannot create a login with that access');
}

export const isSwitchable = (p: unknown): p is Permission =>
  typeof p === 'string' && (SWITCHABLE_PERMISSIONS as readonly string[]).includes(p);

/** The role's default for one permission (`exists (select … from role_permissions …)`). */
export function roleDefault(role: string, perm: string): boolean {
  return ROLE_MATRIX[role as GrantedRole]?.has(perm as Permission) ?? false;
}

/** A sorted, de-duplicated copy (`array(select distinct … order by 1)`). */
export const sortedSet = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** `is not distinct from` for the jsonb / array values these functions compare. */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** `app.validate_timezone`: the IANA names the runtime knows (PostgreSQL's pg_timezone_names). */
export function validTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function requireTimezone(tz: string): void {
  if (!validTimezone(tz)) raise.invalid(`${tz} is not a timezone APX recognises (for example Europe/London)`);
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────

export function membershipRef(fs: Firestore, orgId: string, userId: string) {
  return orgRow(fs, orgId, 'organization_memberships', userId);
}

export async function membershipOf(fs: Firestore, orgId: string, userId: string, r: Reader): Promise<DocumentData | null> {
  const snap = await r.get(membershipRef(fs, orgId, userId));
  return snap.exists ? snap.data()! : null;
}

/** Profiles by id, for the joins the list functions made (`join public.profiles pr on pr.id = …`). */
export async function profilesById(fs: Firestore, ids: Iterable<string>, r: Reader = readerOf()): Promise<Map<string, DocumentData>> {
  const unique = [...new Set([...ids].filter(Boolean))];
  const snaps = await Promise.all(unique.map((id) => r.get(globalRow(fs, 'profiles', id))));
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, s.data()!]));
}

/**
 * Finds one row of an organisation table by its uuid when the caller does not name the organisation
 * (`select … from public.invitations where id = p_invitation`). Needs the collection-group index on
 * `id`; the row's `organization_id` then scopes everything that follows.
 */
export async function rowByIdAnyOrg(
  fs: Firestore, table: 'invitations' | 'ownership_transfers' | 'access_requests' | 'member_login_claims', id: string | null,
  r: Reader,
): Promise<DocumentData | null> {
  if (!id) return null;
  const snap = await r.query(fs.collectionGroup(table).where('id', '==', id).limit(1));
  return snap.empty ? null : snap.docs[0]!.data();
}

/** `app.actor_departments(org)`: the caller's own departments, or null (all). */
export async function actorDepartments(db: Db, orgId: string, r: Reader): Promise<string[] | null> {
  const uid = uidOf(db);
  if (!uid) return null;
  const m = await membershipOf(db.fs, orgId, uid, r);
  if (!m || m.status !== 'active' || !overridableRole(String(m.role))) return null;
  return Array.isArray(m.departments) ? (m.departments as string[]) : null;
}

/** `app.check_departments(org, departments)`: never more than the caller has; sorted, distinct. */
export async function checkDepartments(db: Db, orgId: string, departments: unknown, r: Reader): Promise<string[] | null> {
  const mine = await actorDepartments(db, orgId, r);
  if (departments === null || departments === undefined) {
    if (mine !== null) raise.denied('you can only give the departments you have yourself');
    return null;
  }
  const list = Array.isArray(departments) ? departments.map(String) : [];
  if (!list.every((d) => (DEPARTMENT_KEYS as readonly string[]).includes(d))) raise.invalid('unknown department');
  if (mine !== null && !list.every((d) => mine.includes(d))) {
    raise.denied('you can only give the departments you have yourself');
  }
  return sortedSet(list);
}

/** `app.org_people(org)`: the active members and the in-window active advisers. */
export async function orgPeople(fs: Firestore, orgId: string, r: Reader, now = new Date()): Promise<string[]> {
  const [members, advisers] = await Promise.all([
    r.query(orgCollection(fs, orgId, 'organization_memberships').where('status', '==', 'active')),
    r.query(orgCollection(fs, orgId, 'organization_assignments').where('status', '==', 'active')),
  ]);
  const t = now.getTime();
  const out = new Set<string>(members.docs.map((d) => String(d.get('user_id'))));
  for (const a of advisers.docs) {
    const starts = a.get('starts_at') as string | null;
    const ends = a.get('ends_at') as string | null;
    if (starts && new Date(starts).getTime() > t) continue;
    if (ends && new Date(ends).getTime() <= t) continue;
    out.add(String(a.get('employee_user_id')));
  }
  return [...out];
}

// ── The last-owner guard (trigger `last_owner_guard`) ────────────────────────────────────────────

/**
 * Refuses a change that leaves a living organisation without an active owner. `after` is the row
 * as it will be (null for a delete). `otherOwnersBecoming` counts members the SAME transaction makes
 * owners (an ownership transfer promotes the nominee before it demotes the initiator).
 */
export async function guardLastOwner(
  fs: Firestore, orgId: string, before: DocumentData, after: DocumentData | null, r: Reader,
  otherOwnersBecoming = 0,
): Promise<void> {
  const wasActiveOwner = before.role === 'owner' && before.status === 'active';
  if (!wasActiveOwner) return;
  if (after && after.role === 'owner' && after.status === 'active') return;
  const owners = await r.query(
    orgCollection(fs, orgId, 'organization_memberships').where('role', '==', 'owner'),
  );
  const remaining = owners.docs.filter((d) => d.get('status') === 'active' && d.get('user_id') !== before.user_id).length;
  if (remaining + otherOwnersBecoming === 0) raise.conflict('an organization must keep at least one active owner');
}

/** `platform_user_exclusivity`: a platform account never holds a membership. */
export async function guardNotPlatformUser(fs: Firestore, userId: string, r: Reader): Promise<void> {
  if ((await r.get(globalRow(fs, 'platform_users', userId))).exists) {
    raise.conflict('a platform user cannot hold an organization membership');
  }
}

/**
 * Deleting a membership cascades to the person's switches and access requests
 * (`member_permission_overrides_membership_fk`, `access_requests_membership_fk`, ON DELETE CASCADE).
 */
export async function prepareMembershipDelete(fs: Firestore, orgId: string, userId: string, r: Reader): Promise<Prepared> {
  const [overrides, requests] = await Promise.all([
    r.query(orgCollection(fs, orgId, 'member_permission_overrides').where('user_id', '==', userId)),
    r.query(orgCollection(fs, orgId, 'access_requests').where('requester_id', '==', userId)),
  ]);
  return {
    write(tx) {
      tx.delete(membershipRef(fs, orgId, userId));
      for (const d of overrides.docs) tx.delete(d.ref);
      for (const d of requests.docs) {
        if (d.get('status') === 'pending') tx.delete(pendingRequestGuard(fs, orgId, userId).ref);
        tx.delete(d.ref);
      }
    },
  };
}

export const pendingRequestGuard = (fs: Firestore, orgId: string, requesterId: string) =>
  uniqueGuard(fs, { orgId }, 'access_requests_one_pending', [requesterId]);
export const pendingInvitationGuard = (fs: Firestore, orgId: string, email: string) =>
  uniqueGuard(fs, { orgId }, 'invitation_pending_unique', [email]);
export const pendingTransferGuard = (fs: Firestore, orgId: string) =>
  uniqueGuard(fs, { orgId }, 'ownership_transfer_pending_unique', []);

// ── Row-change audit (trigger `audit_diff`) ──────────────────────────────────────────────────────

/**
 * `app.audit_diff`: the `db.<table>.<op>` event every write to an audited table produced, with the
 * whole row before and after. The tenancy tables that had it: organizations, organization_memberships,
 * invitations, ownership_transfers.
 */
export async function prepareRowAudit(
  db: Db,
  table: 'organizations' | 'organization_memberships' | 'invitations' | 'ownership_transfers',
  op: 'insert' | 'update' | 'delete',
  before: DocumentData | null,
  after: DocumentData | null,
  tx: Transaction,
  options: { bootstrap?: boolean; actorId?: string | null } = {},
): Promise<PreparedAudit> {
  const row = after ?? before ?? {};
  const orgId = table === 'organizations' ? String(row.id) : (row.organization_id as string | null) ?? null;
  const target = (row.id as string | undefined) ?? (row.user_id as string | undefined) ?? orgId;
  return prepareAudit(db, {
    organizationId: orgId,
    action: `db.${table}.${op}`,
    targetTable: table,
    targetId: target ?? null,
    before,
    after,
    metadata: { source: 'trigger' },
    bootstrap: options.bootstrap,
    actorId: options.actorId,
  }, tx);
}

// ── The per-person switch (`app.apply_member_permission`) ────────────────────────────────────────

export interface PreparedSwitch extends Prepared {
  /** False when the switch already said that (nothing to write). */
  readonly changed: boolean;
}

/**
 * One switch, for one person: validates exactly as the SQL did and returns the write. `target` is
 * passed when the membership is created in the same transaction (a login made just now), because
 * it cannot be read before it is written.
 */
export async function prepareMemberPermission(
  db: Db, tx: Transaction,
  input: {
    orgId: string; userId: string | null; permission: string | null; granted: boolean | null;
    actorRole: string | null; metadata?: Record<string, unknown>;
    target?: { role: string; status: string };
  },
): Promise<PreparedSwitch> {
  const r = readerOf(tx);
  const actor = uidOf(db);
  const ownerActor = input.actorRole === 'owner' || input.actorRole === 'super_admin';
  const perm = input.permission;
  if (!perm || !isSwitchable(perm)) raise.invalid(`${perm ?? 'that permission'} cannot be switched for one person`);
  if (!input.userId) raise.notFound();
  if (input.userId === actor) raise.denied('you cannot change your own access');

  const m = input.target ?? await membershipOf(db.fs, input.orgId, input.userId, r);
  if (!m) raise.notFound();
  const target = String(m.role);
  if (m.status !== 'active') raise.conflict("that person's access is switched off; switch it back on first");
  if (!overridableRole(target)) raise.denied("an owner's access cannot be switched; an owner holds everything");
  if (!ceilingAllows(input.actorRole, target)) raise.denied(`you cannot act on a ${target}`);

  const ref = orgRow(db.fs, input.orgId, 'member_permission_overrides', overrideId(input.userId, perm));
  const existing = input.target ? null : await r.get(ref);
  const before = existing?.exists ? (existing.get('granted') as boolean) : null;
  const beforeByOwner = existing?.exists ? existing.get('set_by_owner') === true : false;

  if (beforeByOwner && !ownerActor) raise.denied('the owner set this switch; only an owner can change it');

  const def = roleDefault(target, perm);
  const effBefore = before ?? def;
  const effAfter = input.granted ?? def;
  if ((input.granted === true || (effAfter && !effBefore))
    && !(await effectivePermission(db.fs, actor, input.orgId, input.actorRole, perm, r))) {
    raise.denied(`you can only switch on what you hold yourself (${perm})`);
  }
  if (input.granted === before) return { changed: false, write() {} };

  const audit = await prepareAudit(db, {
    organizationId: input.orgId,
    action: 'member.permission_changed',
    targetTable: 'organization_memberships',
    targetId: input.userId,
    before: { permission: perm, override: before, effective: effBefore },
    after: { permission: perm, override: input.granted, effective: effAfter },
    metadata: { role: target, set_by_owner: ownerActor, ...(input.metadata ?? {}) },
  }, tx);
  const userId = input.userId;
  return {
    changed: true,
    write(t) {
      if (input.granted === null) {
        t.delete(ref);
      } else {
        // Whoever writes the switch now owns it: no longer a ceiling withhold but a decision.
        t.set(ref, {
          organization_id: input.orgId, user_id: userId, permission: perm, granted: input.granted,
          set_by: actor, set_at: nowIso(), set_by_owner: ownerActor, ceiling_withhold: false,
        });
      }
      audit.write(t);
    },
  };
}

// ── A role change (trigger `member_role_changed` + `clear_owner_departments`) ────────────────────

/**
 * What changing a member's role does besides the role itself (§4 of migration 20261018000032):
 *
 *  1. the owner's switches are carried, every other switch is cleared (all of them, for an owner);
 *  2. what the new role holds by default but the ACTOR does not is switched off (a ceiling withhold);
 *  3. a waiting access request, asked of the old role, is closed.
 *
 * `actorRole` is the role the actor holds WHEN the change applies — in an ownership transfer the
 * nominee is already the owner when the initiator is demoted, though the reads here see the state
 * before either write.
 */
export async function prepareRoleChange(
  db: Db, tx: Transaction,
  input: { orgId: string; membership: DocumentData; newRole: string; actorRole: string | null },
): Promise<{ row: DocumentData; write(tx: Transaction): void }> {
  const r = readerOf(tx);
  const fs = db.fs;
  const { orgId, membership: m, newRole } = input;
  const userId = String(m.user_id);
  const now = nowIso();
  const row: DocumentData = { ...m, role: newRole, updated_at: now };
  if (newRole === 'owner') {
    row.departments = null;
    row.departments_set_by_owner = false;
  }
  if (newRole === m.role) {
    return { row, write: (t) => { t.set(membershipRef(fs, orgId, userId), row); } };
  }

  const actor = uidOf(db);
  const takes = overridableRole(newRole);
  const [overrides, pending] = await Promise.all([
    r.query(orgCollection(fs, orgId, 'member_permission_overrides').where('user_id', '==', userId)),
    r.query(orgCollection(fs, orgId, 'access_requests').where('requester_id', '==', userId)),
  ]);
  const all = overrides.docs.map((d) => d.data()).sort((a, b) => String(a.permission).localeCompare(String(b.permission)));
  const cleared = all.filter((o) => !takes || o.set_by_owner !== true);
  const carried = all.filter((o) => takes && o.set_by_owner === true);
  const carriedPerms = new Set(carried.map((o) => String(o.permission)));

  const withheld: string[] = [];
  if (takes && actor && actor !== userId) {
    for (const perm of SWITCHABLE_PERMISSIONS) {
      if (!roleDefault(newRole, perm) || carriedPerms.has(perm)) continue;
      if (!(await effectivePermission(fs, actor, orgId, input.actorRole, perm, r))) withheld.push(perm);
    }
    withheld.sort();
  }
  const closing = pending.docs.filter((d) => d.get('status') === 'pending');

  const afterOverrides = [
    ...carried.map((o) => ({ permission: o.permission, granted: o.granted, set_by_owner: o.set_by_owner, ceiling_withhold: o.ceiling_withhold })),
    ...withheld.map((p) => ({ permission: p, granted: false, set_by_owner: false, ceiling_withhold: true })),
  ].sort((a, b) => String(a.permission).localeCompare(String(b.permission)));

  let audit: PreparedAudit | null = null;
  if (all.length > 0 || withheld.length > 0 || closing.length > 0) {
    audit = await prepareAudit(db, {
      organizationId: orgId,
      action: 'member.permissions_reset',
      targetTable: 'organization_memberships',
      targetId: userId,
      before: { role: m.role, overrides: all.map((o) => ({ permission: o.permission, granted: o.granted, set_by_owner: o.set_by_owner })) },
      after: { role: newRole, overrides: afterOverrides },
      metadata: {
        reason: 'role_changed', requests_closed: closing.length,
        carried: carried.map((o) => ({ permission: o.permission, granted: o.granted })),
        cleared: cleared.map((o) => ({ permission: o.permission, granted: o.granted })),
        withheld,
      },
    }, tx);
  }

  return {
    row,
    write(t) {
      t.set(membershipRef(fs, orgId, userId), row);
      for (const o of cleared) {
        t.delete(orgRow(fs, orgId, 'member_permission_overrides', overrideId(userId, String(o.permission))));
      }
      for (const perm of withheld) {
        t.set(orgRow(fs, orgId, 'member_permission_overrides', overrideId(userId, perm)), {
          organization_id: orgId, user_id: userId, permission: perm, granted: false, set_by: actor,
          set_at: now, set_by_owner: false, ceiling_withhold: true,
        });
      }
      for (const d of closing) {
        t.update(d.ref, {
          status: 'declined', decided_at: now, decided_by: actor, updated_at: now,
          note: 'Closed because your role changed. Ask again if you still need more access.',
        });
        t.delete(pendingRequestGuard(fs, orgId, userId).ref);
      }
      audit?.write(t);
    },
  };
}

/** A new membership row in the shape every reader expects (the table's defaults made explicit). */
export function newMembership(input: {
  orgId: string; userId: string; role: string; invitedBy: string | null;
  departments?: string[] | null; departmentsSetByOwner?: boolean;
}): DocumentData {
  const now = nowIso();
  const owner = input.role === 'owner';
  return {
    id: newId(), organization_id: input.orgId, user_id: input.userId, role: input.role, status: 'active',
    invited_by: input.invitedBy, joined_at: now, created_at: now, updated_at: now,
    departments: owner ? null : (input.departments ?? null),
    departments_set_by_owner: owner ? false : (input.departmentsSetByOwner ?? false),
  };
}

// ── The first two years of a new organisation's calendar ─────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `app.ensure_periods(org, now - 12 months, now + 11 months)` for an organisation created in this
 * same transaction. `preparePeriods` reads the organisation document, which does not exist until the
 * transaction commits, so a new organisation's months are written directly — there is nothing to
 * read, every month is missing.
 */
export function writeNewOrgPeriods(tx: Transaction, fs: Firestore, orgId: string, fyStartMonth: number, at = new Date()): number {
  const now = nowIso(at);
  let y = at.getUTCFullYear();
  let m = at.getUTCMonth() + 1 - 12;
  while (m < 1) { m += 12; y -= 1; }
  for (let i = 0; i < 24; i += 1) {
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const pos = fiscalPosition(start, fyStartMonth);
    const id = periodId(orgId, start);
    tx.set(orgRow(fs, orgId, 'fiscal_periods', id), {
      id, organization_id: orgId, period_start: start, period_end: `${start.slice(0, 7)}-${String(last).padStart(2, '0')}`,
      fiscal_year: pos.fiscal_year, fiscal_quarter: pos.fiscal_quarter, label: `${MONTHS[m - 1]} ${y}`,
      is_complete: false, is_locked: false, created_at: now, updated_at: now,
    });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return 24;
}
