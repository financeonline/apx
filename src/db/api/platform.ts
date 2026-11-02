import 'server-only';
import type { DocumentData, Transaction } from 'firebase-admin/firestore';
import { callApi } from '@/core/db/api-rpc';
import { raise } from '../raise';
import { arg, type DbFunctions } from '../registry';
import {
  acrossOrgs, globalCollection, globalRow, newId, nowIso, orgCollection, orgRow, ORG_SINGLETON_ID, uniqueGuard,
} from '../schema';
import { runTx } from '../tx';
import { uidOf, type Db } from '../types';
import { isSuperAdmin, requireOrg, requirePermission, requireSuperAdmin } from '../app/access';
import { prepareAudit, type PreparedAudit } from '../app/audit';
import { jobRef, prepareEnqueue, releaseQueuedGuard } from '../app/jobs';
import { prepareNewOrganization } from '../app/org-create';
import { prepareRowAudit } from '../app/platform-row-audit';
import { deleteSecret, secretStatus, writeSecret } from '../app/secrets';
import { throttle } from '../app/throttle';

/**
 * `api.*` functions of the platform area — the super admin's console (TENANCY_MODEL.md §5,
 * RBAC_MATRIX.md §3, ADR-044, ADR-157, ADR-163–165), ported from PostgreSQL
 * (FIRESTORE_DATA_MODEL.md §8).
 *
 * Every function keeps its SQL guard in its SQL place: the throttle first, then
 * `app.require_super_admin(true)` — a super admin who signed in within ten minutes — for anything
 * that changes the platform, and `require_super_admin()` without the fresh sign-in for the reads a
 * page shows on every visit. Two exceptions are the SQL's own: `revoke_assignment` also admits the
 * organisation's owner, and `cancel_job` is a tenant function (`intelligence.recompute`).
 *
 * Triggers are done here (data model §4): the `audit_diff` trigger's `db.<table>.<op>` event for
 * every row written to an audited table (`prepareRowAudit`), `set_updated_at`, the
 * platform-user / membership exclusivity checks, `funding_enablement`, and releasing the
 * `invitation_pending_unique` and `jobs_idempotency_queued` guards when a row leaves that state.
 *
 * The AI keys lived in Supabase Vault; they live in `platform_secrets` now (`src/db/app/secrets.ts`),
 * under the same names and with the same `ending abcd` description. The model choice stays the
 * `platform_settings` row `ai_model`, which `api_server.ai_model` / `ai_model_for` read.
 */

const RPC = { bucket: 'rpc', limit: 120, seconds: 60 } as const;

async function throttleRpc(db: Db, bucket: string = RPC.bucket, limit: number = RPC.limit, seconds: number = RPC.seconds) {
  await throttle(db.fs, uidOf(db), bucket, limit, seconds);
}

/** A `timestamptz` argument: null, or an ISO instant; anything unparseable is refused. */
function timeArg(args: Record<string, unknown>, name: string): string | null {
  const v = arg.str(args, name);
  if (v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) raise.invalid(`${name} is not a valid time`);
  return d.toISOString();
}

/** `btrim(coalesce(x, ''))`: PostgreSQL's btrim strips spaces only. */
const btrim = (v: string | null): string => (v ?? '').replace(/^ +| +$/g, '');

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function writeAll(tx: Transaction, audits: readonly PreparedAudit[]): void {
  for (const a of audits) a.write(tx);
}

// ── Platform roles ───────────────────────────────────────────────────────────────────────────────

/** `api.grant_platform_role`: make someone staff (or, when there is none, the super admin). */
async function grant_platform_role(db: Db, args: Record<string, unknown>): Promise<string> {
  const user = arg.req(args, 'p_user');
  const role = arg.req(args, 'p_role');
  await throttleRpc(db);
  await requireSuperAdmin(db, true);
  if (role !== 'super_admin' && role !== 'employee') raise.invalid('the platform role is super_admin or employee');
  const actor = uidOf(db);

  return runTx(db, async (tx) => {
    const ref = globalRow(db.fs, 'platform_users', user);
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.get('platform_role') as string) : null;
    const activeSuper = await tx.get(globalCollection(db.fs, 'platform_users')
      .where('platform_role', '==', 'super_admin').where('status', '==', 'active').limit(1));

    if (role === 'super_admin' && current !== 'super_admin' && !activeSuper.empty) {
      raise.conflict('there is one super admin; add this person as staff');
    }
    if (current === 'super_admin' && role !== 'super_admin') {
      raise.conflict('the super admin cannot be changed to staff');
    }
    // The `membership_exclusivity` trigger: platform staff are never members of a customer.
    const member = await tx.get(acrossOrgs(db.fs, 'organization_memberships').where('user_id', '==', user).limit(1));
    if (!member.empty) raise.conflict('this user is a member of an organization and cannot hold a platform role');

    const now = nowIso();
    const before = snap.exists ? snap.data()! : null;
    const after = before
      ? { ...before, platform_role: role, status: 'active', updated_at: now }
      : { user_id: user, platform_role: role, status: 'active', granted_by: actor, notes: null, created_at: now, updated_at: now };
    const audits = [
      await prepareRowAudit(db, 'platform_users', before ? 'update' : 'insert', before, after, tx),
      await prepareAudit(db, {
        organizationId: null, action: 'platform.role_granted', targetTable: 'platform_users', targetId: user,
        after: { platform_role: role },
      }, tx),
    ];
    tx.set(ref, after);
    writeAll(tx, audits);
    return user;
  });
}

/** `api.revoke_platform_role`: staff leave; their assignments end with them. */
async function revoke_platform_role(db: Db, args: Record<string, unknown>): Promise<string> {
  const user = arg.req(args, 'p_user');
  await throttleRpc(db);
  await requireSuperAdmin(db, true);
  const actor = uidOf(db);

  return runTx(db, async (tx) => {
    const ref = globalRow(db.fs, 'platform_users', user);
    const snap = await tx.get(ref);
    if (snap.exists && snap.get('platform_role') === 'super_admin') raise.conflict('the super admin cannot be removed');

    const assignments = await tx.get(acrossOrgs(db.fs, 'organization_assignments')
      .where('employee_user_id', '==', user).where('status', '==', 'active'));
    const now = nowIso();
    const updates: Array<{ ref: FirebaseFirestore.DocumentReference; after: DocumentData }> = [];
    const audits: PreparedAudit[] = [];
    for (const a of assignments.docs) {
      const after = { ...a.data(), status: 'revoked', revoked_by: actor, updated_at: now };
      updates.push({ ref: a.ref, after });
      audits.push(await prepareRowAudit(db, 'organization_assignments', 'update', a.data(), after, tx));
    }
    if (snap.exists) audits.push(await prepareRowAudit(db, 'platform_users', 'delete', snap.data()!, null, tx));
    audits.push(await prepareAudit(db, {
      organizationId: null, action: 'platform.role_revoked', targetTable: 'platform_users', targetId: user,
    }, tx));

    for (const u of updates) tx.set(u.ref, u.after);
    if (snap.exists) tx.delete(ref);
    writeAll(tx, audits);
    // Session invalidation is performed by the caller through the Auth admin API.
    return user;
  });
}

/** `api.platform_users_list`: staff and the super admin, with their names. */
async function platform_users_list(db: Db): Promise<Array<Record<string, unknown>>> {
  await requireSuperAdmin(db);
  const users = await globalCollection(db.fs, 'platform_users').get();
  const profiles = users.empty ? [] : await db.fs.getAll(...users.docs.map((d) => globalRow(db.fs, 'profiles', d.id)));
  const byId = new Map(profiles.filter((p) => p.exists).map((p) => [p.id, p.data()!]));
  const ROLE_ORDER: Record<string, number> = { super_admin: 0, employee: 1 };
  return users.docs
    .map((d) => {
      const p = byId.get(d.id);
      return {
        user_id: d.id, email: (p?.email as string | undefined) ?? null, full_name: (p?.full_name as string | undefined) ?? null,
        platform_role: String(d.get('platform_role')), status: String(d.get('status')),
        created_at: (d.get('created_at') as string | undefined) ?? null,
      };
    })
    .sort((a, b) => (ROLE_ORDER[a.platform_role] ?? 9) - (ROLE_ORDER[b.platform_role] ?? 9)
      || cmpNullsLast(a.email, b.email));
}

function cmpNullsLast(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

// ── The audit log ────────────────────────────────────────────────────────────────────────────────

/**
 * `api.platform_audit_events`: the whole platform's audit log, newest first, filtered and paged.
 *
 * The equality filters and the time range are the query; the action-prefix filter is applied to
 * the rows as they stream past (Firestore cannot range-filter one field and order by another
 * without an index on both), page after page until the requested page is full.
 */
async function platform_audit_events(db: Db, args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  await requireSuperAdmin(db, true);
  const org = arg.str(args, 'p_org');
  const action = arg.str(args, 'p_action');
  const actor = arg.str(args, 'p_actor');
  const from = timeArg(args, 'p_from');
  const to = timeArg(args, 'p_to');
  const limit = Math.max(Math.min(arg.num(args, 'p_limit') ?? 100, 500), 1);
  const offset = Math.max(arg.num(args, 'p_offset') ?? 0, 0);

  let q: FirebaseFirestore.Query = globalCollection(db.fs, 'audit_events');
  if (org) q = q.where('organization_id', '==', org);
  if (actor) q = q.where('actor_user_id', '==', actor);
  if (from) q = q.where('created_at', '>=', from);
  if (to) q = q.where('created_at', '<', to);
  // Ties fall back to the document id (= `id`), in the same descending direction.
  q = q.orderBy('created_at', 'desc');

  const PAGE = 500;
  const wanted = offset + limit;
  const matched: DocumentData[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    const snap: FirebaseFirestore.QuerySnapshot = await (cursor ? q.startAfter(cursor) : q).limit(action ? PAGE : wanted).get();
    for (const d of snap.docs) {
      const row = d.data();
      if (!action || String(row.action).startsWith(action)) matched.push(row);
    }
    if (!action || matched.length >= wanted || snap.size < PAGE) break;
    cursor = snap.docs[snap.docs.length - 1]!;
  }
  const page = matched.slice(offset, wanted);

  const orgIds = [...new Set(page.map((r) => r.organization_id).filter((v): v is string => typeof v === 'string'))];
  const actorIds = [...new Set(page.map((r) => r.actor_user_id).filter((v): v is string => typeof v === 'string'))];
  const [orgs, people] = await Promise.all([
    orgIds.length ? db.fs.getAll(...orgIds.map((id) => globalRow(db.fs, 'organizations', id))) : [],
    actorIds.length ? db.fs.getAll(...actorIds.map((id) => globalRow(db.fs, 'profiles', id))) : [],
  ]);
  const orgName = new Map(orgs.filter((s) => s.exists).map((s) => [s.id, s.get('name') as string]));
  const person = new Map(people.filter((s) => s.exists).map((s) => [s.id, s.data()!]));

  return page.map((r) => {
    const p = typeof r.actor_user_id === 'string' ? person.get(r.actor_user_id) : undefined;
    return {
      id: r.id, organization_id: r.organization_id ?? null,
      organization_name: typeof r.organization_id === 'string' ? (orgName.get(r.organization_id) ?? null) : null,
      action: r.action, actor_type: r.actor_type,
      // The actor's own name, resolved here because `profiles` is own-row-only (ADR-044).
      actor_name: (p?.full_name as string | null | undefined) ?? (p?.email as string | null | undefined)
        ?? (r.actor_user_id == null ? 'system' : null),
      target_table: r.target_table ?? null, target_id: r.target_id ?? null,
      metadata: r.metadata ?? {}, created_at: r.created_at,
    };
  });
}

// ── Companies ────────────────────────────────────────────────────────────────────────────────────

/** `api.platform_company_owners`: each listed company's active owners, with their logins. */
async function platform_company_owners(db: Db, args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  await requireSuperAdmin(db);
  const orgs = [...new Set((arg.arr<string>(args, 'p_orgs') ?? []).filter(Boolean))];
  const perOrg = await Promise.all(orgs.map((org) => orgCollection(db.fs, org, 'organization_memberships')
    .where('role', '==', 'owner').where('status', '==', 'active').get()));
  const members = perOrg.flatMap((s) => s.docs.map((d) => d.data()));
  const profiles = members.length
    ? await db.fs.getAll(...members.map((m) => globalRow(db.fs, 'profiles', String(m.user_id))))
    : [];
  const byId = new Map(profiles.filter((p) => p.exists).map((p) => [p.id, p.data()!]));
  return members
    .filter((m) => byId.has(String(m.user_id)))
    .map((m) => {
      const p = byId.get(String(m.user_id))!;
      return { organization_id: m.organization_id, user_id: m.user_id, email: String(p.email), full_name: p.full_name ?? null };
    })
    .sort((a, b) => (a.organization_id < b.organization_id ? -1 : a.organization_id > b.organization_id ? 1
      : a.email.toLowerCase() < b.email.toLowerCase() ? -1 : a.email.toLowerCase() > b.email.toLowerCase() ? 1 : 0));
}

const COUNTRIES = new Set(['GB', 'AE', 'IE', 'IN']);
const CURRENCIES = new Set(['GBP', 'AED', 'EUR', 'USD', 'INR']);
const DEFAULT_TZ: Record<string, string> = { AE: 'Asia/Dubai', IN: 'Asia/Kolkata', IE: 'Europe/Dublin' };

/**
 * `api.platform_create_organization`: the super admin creates a company for a customer and invites
 * its owner — platform staff are never members (RBAC_MATRIX.md §3.5).
 *
 * The organisation is created in one transaction (`prepareNewOrganization`, shared with
 * `api.create_organization`), and the owner is then invited through `api.invite_member_with_token`
 * exactly as the SQL called it. On PostgreSQL the two were one transaction; here the invitation is
 * a second one, so the one refusal it could plausibly raise for a brand-new company — the address
 * belongs to a platform account — is checked BEFORE the company is created.
 */
async function platform_create_organization(db: Db, args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const actor = uidOf(db);
  await throttle(db.fs, actor, 'platform_create_organization', 30, 3600);
  await requireSuperAdmin(db, true);

  const name = (arg.str(args, 'p_name') ?? '').trim();
  const country = arg.str(args, 'p_country_code');
  const currency = arg.str(args, 'p_base_currency');
  const fyMonth = arg.num(args, 'p_fiscal_year_start_month');
  const ownerEmail = (arg.str(args, 'p_owner_email') ?? '').trim();
  if (name === '') raise.invalid('a name is required');
  if (!country || !COUNTRIES.has(country)) raise.invalid('country is one of GB, AE, IE or IN');
  if (!currency || !CURRENCIES.has(currency)) raise.invalid('currency is one of GBP, AED, EUR, USD or INR');
  if (fyMonth === null || !Number.isInteger(fyMonth) || fyMonth < 1 || fyMonth > 12) {
    raise.invalid('fiscal year start month must be 1-12');
  }
  if (!EMAIL.test(ownerEmail)) raise.invalid('the owner\'s email address is needed');
  const timezone = (arg.str(args, 'p_timezone') ?? '').trim() || DEFAULT_TZ[country] || 'Europe/London';

  // invite_member_with_token's platform-account refusal, asked before anything is created.
  const sameEmail = await globalCollection(db.fs, 'profiles').where('email', '==', ownerEmail.toLowerCase()).get();
  for (const p of sameEmail.docs) {
    if ((await globalRow(db.fs, 'platform_users', p.id).get()).exists) {
      raise.conflict('that address belongs to an APX platform account');
    }
  }

  const created = await runTx(db, async (tx) => {
    const org = await prepareNewOrganization(db, tx, {
      name, countryCode: country, baseCurrency: currency, fiscalYearStartMonth: fyMonth,
      timezone, createdBy: actor, auditExtra: { by: 'platform' },
    });
    org.write(tx);
    return { orgId: org.orgId, slug: org.slug };
  });

  // The owner is invited, never made a member by the super admin.
  const invited = await callApi<unknown>(db, 'invite_member_with_token', {
    p_org: created.orgId, p_email: ownerEmail, p_role: 'owner',
  });
  const first = (Array.isArray(invited) ? invited[0] : invited) as { token?: string } | undefined;
  return [{ organization_id: created.orgId, slug: created.slug, invitation_token: first?.token ?? null }];
}

/**
 * `api.platform_owner_login_change`: checks and audits a change to a company's single owner's
 * login. The change itself is made by the caller through the Auth admin API.
 */
async function platform_owner_login_change(db: Db, args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const org = arg.req(args, 'p_org');
  const password = arg.bool(args, 'p_password') ?? false;
  const requested: string | null = (arg.str(args, 'p_new_email') ?? '').trim().toLowerCase() || null;
  await throttle(db.fs, uidOf(db), 'platform_owner_login', 20, 3600);
  await requireSuperAdmin(db, true);

  return runTx(db, async (tx) => {
    const owners = await tx.get(orgCollection(db.fs, org, 'organization_memberships')
      .where('role', '==', 'owner').where('status', '==', 'active'));
    if (owners.size === 0) {
      raise.conflict('this company has no owner login yet; set a password when it is created, or send the invitation');
    }
    if (owners.size > 1) raise.conflict('this company has more than one owner, so their login is not changed from here');
    const userId = String(owners.docs[0]!.get('user_id'));
    const profile = await tx.get(globalRow(db.fs, 'profiles', userId));
    if (!profile.exists) raise.conflict('this company has no owner login yet; set a password when it is created, or send the invitation');
    const email = String(profile.get('email'));

    const wanted = requested === email.toLowerCase() ? null : requested;
    if (wanted !== null) {
      if (!EMAIL.test(wanted)) raise.invalid('enter a valid email address');
      const taken = await tx.get(globalCollection(db.fs, 'profiles').where('email', '==', wanted));
      if (taken.docs.some((d) => d.id !== userId)) raise.conflict('another login already uses that email');
    }
    if (wanted === null && !password) raise.invalid('nothing to change');

    const audit = await prepareAudit(db, {
      organizationId: org, action: 'platform.owner_login_changed', targetTable: 'profiles', targetId: userId,
      before: { email }, after: { email: wanted ?? email, password_changed: password },
    }, tx);
    audit.write(tx);
    return [{ user_id: userId, email: wanted ?? email }];
  });
}

/**
 * `api.platform_purge_now`: the super admin decides a company's thirty days have passed — the purge
 * itself (`org.purge`) still re-verifies everything.
 */
async function platform_purge_now(db: Db, args: Record<string, unknown>): Promise<string> {
  const org = arg.req(args, 'p_org');
  await throttle(db.fs, uidOf(db), 'platform_purge_now', 20, 3600);
  await requireSuperAdmin(db, true);

  return runTx(db, async (tx) => {
    const ref = globalRow(db.fs, 'organizations', org);
    const snap = await tx.get(ref);
    if (!snap.exists) raise.notFound();
    if (snap.get('status') !== 'pending_deletion') {
      raise.conflict('delete the company first; only a company whose deletion is requested can be deleted for good');
    }
    const decided = await prepareAudit(db, {
      organizationId: org, action: 'platform.org_purge_now', targetTable: 'organizations', targetId: org,
    }, tx);

    const now = new Date();
    const after = {
      ...snap.data()!, deletion_requested_at: new Date(now.getTime() - (30 * 86_400 + 60) * 1000).toISOString(),
      updated_at: now.toISOString(),
    };
    const rowAudit = await prepareRowAudit(db, 'organizations', 'update', snap.data()!, after, tx);

    const queued = await tx.get(globalCollection(db.fs, 'jobs').where('organization_id', '==', org)
      .where('job_type', '==', 'org.purge').where('status', '==', 'queued'));
    const enqueue = queued.empty
      ? await prepareEnqueue(db.fs, {
        organizationId: org, jobType: 'org.purge', payload: {}, requestedBy: null,
        idempotencyKey: `org.purge:now:${org}:${Math.floor(now.getTime() / 1000)}`, runAfter: now.toISOString(),
      }, tx)
      : null;

    decided.write(tx);
    tx.set(ref, after);
    rowAudit.write(tx);
    for (const j of queued.docs) tx.update(j.ref, { run_after: now.toISOString(), updated_at: now.toISOString() });
    if (enqueue) enqueue.write(tx);
    return enqueue ? enqueue.id : queued.docs[0]!.id;
  });
}

/**
 * `api.platform_set_company_owner`: an existing login becomes the owner of a company that has none
 * (the super admin created it with a password rather than an invitation). The pending owner
 * invitation for that address, if any, is marked accepted.
 */
async function platform_set_company_owner(db: Db, args: Record<string, unknown>): Promise<string> {
  const org = arg.req(args, 'p_org');
  const user = arg.req(args, 'p_user');
  await throttleRpc(db);
  await requireSuperAdmin(db, true);
  const actor = uidOf(db);

  return runTx(db, async (tx) => {
    const orgSnap = await tx.get(globalRow(db.fs, 'organizations', org));
    if (!orgSnap.exists) raise.notFound();
    const owners = await tx.get(orgCollection(db.fs, org, 'organization_memberships')
      .where('role', '==', 'owner').where('status', '==', 'active').limit(1));
    if (!owners.empty) raise.conflict('this company already has an owner');
    const profileRef = globalRow(db.fs, 'profiles', user);
    const profile = await tx.get(profileRef);
    if (!profile.exists) raise.notFound();
    const email = String(profile.get('email'));

    // The `platform_user_exclusivity` trigger, then `organization_memberships_org_user_unique`.
    if ((await tx.get(globalRow(db.fs, 'platform_users', user))).exists) {
      raise.conflict('a platform user cannot hold an organization membership');
    }
    const memberRef = orgRow(db.fs, org, 'organization_memberships', user);
    if ((await tx.get(memberRef)).exists) raise.conflict('that login is already a member of this company');

    const pending = await tx.get(orgCollection(db.fs, org, 'invitations')
      .where('status', '==', 'pending').where('role', '==', 'owner'));
    const accepted = pending.docs.filter((d) => String(d.get('email')).toLowerCase() === email.toLowerCase());
    const guards = await Promise.all(accepted.map((d) => uniqueGuard(db.fs, { orgId: org }, 'invitation_pending_unique',
      [d.get('email') as string]).read(tx)));

    const now = nowIso();
    const membership = {
      id: newId(), organization_id: org, user_id: user, role: 'owner', status: 'active', invited_by: actor,
      joined_at: now, created_at: now, updated_at: now, departments: null, departments_set_by_owner: false,
    };
    const audits: PreparedAudit[] = [await prepareRowAudit(db, 'organization_memberships', 'insert', null, membership, tx)];
    const invitationAfter = accepted.map((d) => ({
      ref: d.ref, after: { ...d.data(), status: 'accepted', accepted_at: now, accepted_user_id: user, updated_at: now },
    }));
    for (let i = 0; i < accepted.length; i += 1) {
      audits.push(await prepareRowAudit(db, 'invitations', 'update', accepted[i]!.data(), invitationAfter[i]!.after, tx));
    }
    audits.push(await prepareAudit(db, {
      organizationId: org, action: 'member.joined', targetTable: 'organization_memberships', targetId: user,
      after: { role: 'owner', by: 'platform' },
    }, tx));

    tx.set(memberRef, membership);
    for (const inv of invitationAfter) tx.set(inv.ref, inv.after);
    for (const g of guards) g.release(tx);
    if (profile.get('last_active_org_id') == null) tx.update(profileRef, { last_active_org_id: org, updated_at: now });
    writeAll(tx, audits);
    return org;
  });
}

// ── Adviser assignments ──────────────────────────────────────────────────────────────────────────

/** `api.create_assignment`: a platform employee advises one organisation, for a year by default. */
async function create_assignment(db: Db, args: Record<string, unknown>): Promise<string> {
  const org = arg.req(args, 'p_org');
  const employee = arg.req(args, 'p_employee');
  const endsAt = timeArg(args, 'p_ends_at');
  await throttleRpc(db);
  await requireSuperAdmin(db, true); // re-auth (ADR-044.3)
  const actor = uidOf(db);

  return runTx(db, async (tx) => {
    const staff = await tx.get(globalRow(db.fs, 'platform_users', employee));
    if (!staff.exists || staff.get('platform_role') !== 'employee' || staff.get('status') !== 'active') {
      raise.invalid('assignments are only for active platform employees');
    }
    const orgSnap = await tx.get(globalRow(db.fs, 'organizations', org));
    if (!orgSnap.exists || orgSnap.get('status') === 'deleted') raise.notFound();
    // `organization_assignments_org_employee_unique`: the document id IS the employee.
    const ref = orgRow(db.fs, org, 'organization_assignments', employee);
    // A revoked or lapsed assignment keeps its document (it is the record of that access), so only a
    // CURRENT one blocks: the same analyst can be given the company again (ADR-182).
    const existing = await tx.get(ref);
    const lapsed = (end: unknown) => typeof end === 'string' && new Date(end).getTime() <= Date.now();
    if (existing.exists && existing.get('status') === 'active' && !lapsed(existing.get('ends_at'))) {
      raise.conflict('that employee is already assigned to this organization');
    }

    const now = new Date();
    const yearOn = new Date(now);
    yearOn.setUTCMonth(yearOn.getUTCMonth() + 12);
    const id = newId();
    const row = {
      id, organization_id: org, employee_user_id: employee, assigned_by: actor, grantor_organization_id: null,
      status: 'active', starts_at: null, ends_at: endsAt ?? yearOn.toISOString(), revoked_by: null,
      revoked_reason: null, created_at: now.toISOString(), updated_at: now.toISOString(),
    };
    const audits = [
      existing.exists
        ? await prepareRowAudit(db, 'organization_assignments', 'update', existing.data()!, row, tx)
        : await prepareRowAudit(db, 'organization_assignments', 'insert', null, row, tx),
      await prepareAudit(db, {
        organizationId: org, action: 'assignment.created', targetTable: 'organization_assignments', targetId: id,
        after: { employee_user_id: employee },
      }, tx),
      await prepareAudit(db, {
        organizationId: null, action: 'assignment.created', targetTable: 'organization_assignments', targetId: id,
        after: { organization_id: org, employee_user_id: employee },
      }, tx),
    ];
    tx.set(ref, row);
    writeAll(tx, audits);
    return id;
  });
}

/**
 * `api.revoke_assignment`: the super admin, or an OWNER of that organisation — the tenant can always
 * revoke adviser access (TENANCY_MODEL.md §5.4). The employee's open conversations about the
 * organisation are archived with it (SECURITY_MODEL.md §4).
 */
async function revoke_assignment(db: Db, args: Record<string, unknown>): Promise<string> {
  const assignmentId = arg.req(args, 'p_assignment');
  const reason = arg.str(args, 'p_reason');
  await throttleRpc(db);
  const actor = uidOf(db);

  const found = await acrossOrgs(db.fs, 'organization_assignments').where('id', '==', assignmentId).limit(1).get();
  if (found.empty) raise.notFound();
  const org = String(found.docs[0]!.get('organization_id'));
  const employee = String(found.docs[0]!.get('employee_user_id'));
  if (!(await isSuperAdmin(db.fs, actor))) {
    const role = await requireOrg(db, org);
    if (role !== 'owner') raise.denied('only an owner or a super admin can revoke adviser access');
  }

  return runTx(db, async (tx) => {
    const ref = orgRow(db.fs, org, 'organization_assignments', employee);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('id') !== assignmentId || snap.get('status') !== 'active') {
      raise.conflict('that assignment is not active');
    }
    const conversations = await tx.get(orgCollection(db.fs, org, 'ai_conversations')
      .where('user_id', '==', employee).where('status', '==', 'active'));

    const now = nowIso();
    const after = { ...snap.data()!, status: 'revoked', revoked_by: actor, revoked_reason: reason, updated_at: now };
    const audits = [
      await prepareRowAudit(db, 'organization_assignments', 'update', snap.data()!, after, tx),
      await prepareAudit(db, {
        organizationId: org, action: 'assignment.revoked', targetTable: 'organization_assignments', targetId: assignmentId,
        after: { reason, conversations_archived: conversations.size },
      }, tx),
      await prepareAudit(db, {
        organizationId: null, action: 'assignment.revoked', targetTable: 'organization_assignments', targetId: assignmentId,
        after: { organization_id: org },
      }, tx),
    ];
    tx.set(ref, after);
    for (const c of conversations.docs) tx.update(c.ref, { status: 'archived', updated_at: now });
    writeAll(tx, audits);
    return assignmentId;
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

/** An integer field of a patch (`(p_patch ->> key)::integer`): absent or null is null. */
function patchInt(patch: Record<string, unknown>, key: string): number | null {
  const v = patch[key];
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n)) raise.invalid(`${key} must be a whole number`);
  return n;
}

/** `api.update_platform_org_settings`: one organisation's AI quotas, model overrides and notes. */
async function update_platform_org_settings(db: Db, args: Record<string, unknown>): Promise<string> {
  const org = arg.req(args, 'p_org');
  const patch = arg.obj(args, 'p_patch');
  await throttleRpc(db);
  await requireSuperAdmin(db, true);
  const quota = patchInt(patch, 'ai_quota_daily');
  const ceiling = patchInt(patch, 'ai_token_ceiling_monthly');
  const pages = patchInt(patch, 'ai_extraction_pages_per_day');
  const overrides = patch.model_overrides && typeof patch.model_overrides === 'object' ? patch.model_overrides : {};
  const notes = patch.notes === undefined || patch.notes === null ? null : String(patch.notes);
  const actor = uidOf(db);

  return runTx(db, async (tx) => {
    if (!(await tx.get(globalRow(db.fs, 'organizations', org))).exists) raise.notFound();
    const ref = orgRow(db.fs, org, 'platform_org_settings', ORG_SINGLETON_ID);
    const snap = await tx.get(ref);
    const now = nowIso();
    const before = snap.exists ? snap.data()! : null;
    const after = before
      ? {
        ...before,
        ai_quota_daily: quota ?? before.ai_quota_daily ?? null,
        ai_token_ceiling_monthly: ceiling ?? before.ai_token_ceiling_monthly ?? null,
        ai_extraction_pages_per_day: pages ?? before.ai_extraction_pages_per_day ?? null,
        model_overrides: overrides, notes: notes ?? before.notes ?? null, updated_by: actor, updated_at: now,
      }
      : {
        organization_id: org, ai_quota_daily: quota, ai_token_ceiling_monthly: ceiling,
        ai_extraction_pages_per_day: pages, model_overrides: overrides, notes, updated_by: actor,
        created_at: now, updated_at: now,
      };
    const audits = [
      await prepareRowAudit(db, 'platform_org_settings', before ? 'update' : 'insert', before, after, tx),
      await prepareAudit(db, {
        organizationId: org, action: 'platform.org_settings_changed', targetTable: 'platform_org_settings',
        targetId: org, after: patch,
      }, tx),
    ];
    tx.set(ref, after);
    writeAll(tx, audits);
    return org;
  });
}

/** Reads a `platform_settings` row and prepares its upsert (with the `audit_diff` event). */
async function prepareSettingUpsert(db: Db, tx: Transaction, key: string, value: unknown) {
  const ref = globalRow(db.fs, 'platform_settings', key);
  const snap = await tx.get(ref);
  const now = nowIso();
  const before = snap.exists ? snap.data()! : null;
  const after = before
    ? { ...before, value, updated_by: uidOf(db), updated_at: now }
    : { key, value, updated_by: uidOf(db), created_at: now, updated_at: now };
  const audit = await prepareRowAudit(db, 'platform_settings', before ? 'update' : 'insert', before, after, tx);
  return {
    before: (before?.value ?? null) as Record<string, unknown> | null,
    write(t: Transaction) { t.set(ref, after); audit.write(t); },
  };
}

/** `api.update_platform_settings`: one platform-wide setting. */
async function update_platform_settings(db: Db, args: Record<string, unknown>): Promise<string> {
  const key = arg.req(args, 'p_key');
  const value = args.p_value;
  await throttleRpc(db);
  await requireSuperAdmin(db, true);
  if (key.includes('/')) raise.invalid('a setting key cannot contain /');
  if (value === undefined || value === null) raise.invalid('a value is required');

  return runTx(db, async (tx) => {
    const upsert = await prepareSettingUpsert(db, tx, key, value);
    const audit = await prepareAudit(db, {
      organizationId: null, action: 'platform.settings_changed', targetTable: 'platform_settings', after: { key },
    }, tx);
    upsert.write(tx);
    audit.write(tx);
    return key;
  });
}

const SWITCHABLE_MODULES = new Set([
  'module_banking', 'module_customers', 'module_actions', 'module_reports', 'module_analyst',
  'module_planning', 'module_tax', 'funding_readiness', 'ai_pdf_extraction', 'module_marketing',
  'module_investment',
]);

/**
 * `api.set_org_module`: switch one of a company's systems on or off. Switching Funding Readiness on
 * queues its first assessment (the `funding_enablement` trigger, ADR-145).
 */
async function set_org_module(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const org = arg.req(args, 'p_org');
  const key = arg.str(args, 'p_feature_key');
  const on = arg.bool(args, 'p_on');
  await throttleRpc(db);
  // No recent-sign-in check (owner, 2026-10-29: the super admin switches systems directly). Still the
  // super admin only, and audited; nothing is deleted by a switch.
  await requireSuperAdmin(db);
  if (key === null || !SWITCHABLE_MODULES.has(key)) raise.invalid('that is not a system APX can switch');
  if (on === null) raise.invalid('on or off is required');

  return runTx(db, async (tx) => {
    const ref = globalRow(db.fs, 'organizations', org);
    const snap = await tx.get(ref);
    if (!snap.exists) raise.notFound();
    const beforeRow = snap.data()!;
    const before = (beforeRow.features as Record<string, unknown> | undefined) ?? {};
    const features = { ...before, [key]: on };
    const now = nowIso();
    const afterRow = { ...beforeRow, features, updated_at: now };
    const audits: PreparedAudit[] = [await prepareRowAudit(db, 'organizations', 'update', beforeRow, afterRow, tx)];

    // `app.funding_enablement`: `on conflict do nothing` — a queued assessment is left as it is.
    let funding: Awaited<ReturnType<typeof prepareEnqueue>> | null = null;
    if (String(features.funding_readiness ?? '') === 'true' && String(before.funding_readiness ?? '') !== 'true') {
      const idempotencyKey = `funding.assess:${org}`;
      const claim = await uniqueGuard(db.fs, 'global', 'jobs_idempotency_queued', ['funding.assess', idempotencyKey]).read(tx);
      const holder = claim.owner ? await tx.get(jobRef(db.fs, claim.owner)) : null;
      if (!(holder?.exists && holder.get('status') === 'queued')) {
        funding = await prepareEnqueue(db.fs, {
          organizationId: org, jobType: 'funding.assess', payload: { trigger: 'enablement_backfill' },
          requestedBy: null, idempotencyKey,
        }, tx);
      }
      audits.push(await prepareAudit(db, {
        organizationId: org, action: 'funding.enabled', targetTable: 'organizations', targetId: org, after: {},
      }, tx));
    }
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(on)) {
      audits.push(await prepareAudit(db, {
        organizationId: org, action: 'platform.org_module_changed', targetTable: 'organizations', targetId: org,
        before: { [key]: before[key] ?? null }, after: { [key]: on },
      }, tx));
    }

    tx.set(ref, afterRow);
    if (funding) funding.write(tx);
    writeAll(tx, audits);
    return features;
  });
}

// ── The AI provider, model and keys (ADR-157, ADR-163–165) ───────────────────────────────────────

const ANTHROPIC_SECRET = 'anthropic_api_key';
const OPENAI_SECRET = 'openai_api_key';
type Provider = 'anthropic' | 'openai';

function providerArg(args: Record<string, unknown>, name: string, fallback?: Provider): Provider {
  const p = arg.str(args, name) ?? (name in args ? null : fallback ?? null);
  if (p !== 'anthropic' && p !== 'openai') raise.invalid('the provider is anthropic or openai');
  return p;
}

/** `api.set_ai_active_provider`: which provider answers. OpenAI needs its key and a model first. */
async function set_ai_active_provider(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  await throttleRpc(db);
  await requireSuperAdmin(db, true);
  const provider = providerArg(args, 'p_provider');

  return runTx(db, async (tx) => {
    const key = await secretStatus(db.fs, OPENAI_SECRET, tx);
    const current = await tx.get(globalRow(db.fs, 'platform_settings', 'ai_model'));
    const before = current.exists ? (current.get('value') as Record<string, unknown>) : null;
    if (provider === 'openai') {
      if (!key.configured) raise.invalid('store an OpenAI key first');
      const openai = before?.openai as { model?: unknown } | null | undefined;
      if (openai?.model == null) raise.invalid('choose an OpenAI model first');
    }
    const after = { ...(before ?? { anthropic: null, openai: null }), active: provider };
    const upsert = await prepareSettingUpsert(db, tx, 'ai_model', after);
    const audit = await prepareAudit(db, {
      organizationId: null, action: 'platform.ai_provider_activated', targetTable: 'platform_settings',
      before: { active: (before?.active as string | undefined) ?? null }, after: { active: provider },
    }, tx);
    upsert.write(tx);
    audit.write(tx);
    return after;
  });
}

const ANTHROPIC_MODEL = /^claude-[a-z0-9][a-z0-9.-]{2,80}$/;
const OPENAI_MODEL = /^[a-z0-9][a-z0-9.:_-]{1,80}$/;
const EFFORTS: Record<Provider, ReadonlySet<string>> = {
  anthropic: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  openai: new Set(['low', 'medium', 'high']),
};

/** `api.set_ai_model`: one provider's model and effort; a null model clears that provider's choice. */
async function set_ai_model(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  await throttleRpc(db);
  await requireSuperAdmin(db, true);
  const provider = providerArg(args, 'p_provider', 'anthropic');
  const model = arg.str(args, 'p_model');
  const effort = arg.str(args, 'p_effort');
  if (model !== null && !(provider === 'anthropic' ? ANTHROPIC_MODEL : OPENAI_MODEL).test(model)) {
    raise.invalid('that is not a model id for that provider');
  }
  if (effort !== null && !EFFORTS[provider].has(effort)) raise.invalid('that effort is not one this provider accepts');
  if (model === null && effort !== null) raise.invalid('choose a model to set its effort');

  return runTx(db, async (tx) => {
    const current = await tx.get(globalRow(db.fs, 'platform_settings', 'ai_model'));
    const before = current.exists ? (current.get('value') as Record<string, unknown>) : null;
    if (model === null && provider === 'openai' && before?.active === 'openai') {
      raise.conflict('OpenAI is active; make Anthropic active before clearing its model');
    }
    const after = {
      ...(before ?? { active: 'anthropic', anthropic: null, openai: null }),
      [provider]: model === null ? null : { model, effort },
    };
    const upsert = await prepareSettingUpsert(db, tx, 'ai_model', after);
    const audit = await prepareAudit(db, {
      organizationId: null, action: 'platform.ai_model_changed', targetTable: 'platform_settings',
      before: { ai_model: before }, after: { ai_model: after },
    }, tx);
    upsert.write(tx);
    audit.write(tx);
    return after;
  });
}

/** Stores one provider's key, encrypted; returns its last four characters. */
async function setKey(
  db: Db, raw: string | null, secret: string, valid: (key: string) => boolean, refusal: string, action: string,
): Promise<string> {
  await throttle(db.fs, uidOf(db), 'rpc', 30, 60);
  await requireSuperAdmin(db, true);
  const key = btrim(raw);
  if (!valid(key)) raise.invalid(refusal);
  const last = key.slice(-4);
  const audit = await prepareAudit(db, {
    organizationId: null, action, targetTable: 'platform_settings', after: { ending: last },
  });
  await runTx(db, async (tx) => {
    writeSecret(tx, db.fs, secret, key, `ending ${last}`);
    audit.write(tx);
  });
  return last;
}

/** `api.set_ai_api_key`. */
async function set_ai_api_key(db: Db, args: Record<string, unknown>): Promise<string> {
  return setKey(db, arg.str(args, 'p_key'), ANTHROPIC_SECRET, (k) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k),
    'that does not look like an Anthropic API key (it starts sk-ant-)', 'platform.ai_key_set');
}

/** `api.set_openai_api_key`. */
async function set_openai_api_key(db: Db, args: Record<string, unknown>): Promise<string> {
  return setKey(db, arg.str(args, 'p_key'), OPENAI_SECRET,
    (k) => /^sk-[A-Za-z0-9_-]{20,}$/.test(k) && !k.startsWith('sk-ant-'),
    'that does not look like an OpenAI API key (it starts sk-)', 'platform.openai_key_set');
}

/** `api.clear_ai_api_key`: false when there was no key. */
async function clear_ai_api_key(db: Db): Promise<boolean> {
  await throttle(db.fs, uidOf(db), 'rpc', 30, 60);
  await requireSuperAdmin(db, true);
  return runTx(db, async (tx) => {
    const status = await secretStatus(db.fs, ANTHROPIC_SECRET, tx);
    if (!status.configured) return false;
    const audit = await prepareAudit(db, {
      organizationId: null, action: 'platform.ai_key_removed', targetTable: 'platform_settings',
      before: { key: status.description },
    }, tx);
    deleteSecret(tx, db.fs, ANTHROPIC_SECRET);
    audit.write(tx);
    return true;
  });
}

/** `api.clear_openai_api_key`: and Anthropic becomes active again if OpenAI was (ADR-165). */
async function clear_openai_api_key(db: Db): Promise<boolean> {
  await throttle(db.fs, uidOf(db), 'rpc', 30, 60);
  await requireSuperAdmin(db, true);
  return runTx(db, async (tx) => {
    const status = await secretStatus(db.fs, OPENAI_SECRET, tx);
    if (!status.configured) return false;
    const current = await tx.get(globalRow(db.fs, 'platform_settings', 'ai_model'));
    const value = current.exists ? (current.get('value') as Record<string, unknown>) : null;
    const fallback = value?.active === 'openai'
      ? await prepareSettingUpsert(db, tx, 'ai_model', { ...value, active: 'anthropic' })
      : null;
    const audit = await prepareAudit(db, {
      organizationId: null, action: 'platform.openai_key_removed', targetTable: 'platform_settings',
      before: { key: status.description },
    }, tx);
    deleteSecret(tx, db.fs, OPENAI_SECRET);
    if (fallback) fallback.write(tx);
    audit.write(tx);
    return true;
  });
}

/** The status row a settings page shows: never the key, only its last four characters. */
async function keyStatus(db: Db, secret: string): Promise<Array<Record<string, unknown>>> {
  // Reading the status needs a super admin, not a fresh sign-in: the page shows it on every visit.
  await requireSuperAdmin(db);
  const s = await secretStatus(db.fs, secret);
  return s.configured
    ? [{ configured: true, ending: (s.description ?? '').slice(-4), updated_at: s.updated_at }]
    : [{ configured: false, ending: null, updated_at: null }];
}

// ── Jobs ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * `api.requeue_job`: the super admin puts a job back in the queue from /platform/jobs. A cancelled
 * purge is never revived unless the organisation is genuinely pending deletion (ADR-044.6).
 */
async function requeue_job(db: Db, args: Record<string, unknown>): Promise<string> {
  const jobId = arg.req(args, 'p_job');
  await throttleRpc(db);
  await requireSuperAdmin(db, false);

  return runTx(db, async (tx) => {
    const ref = jobRef(db.fs, jobId);
    const snap = await tx.get(ref);
    if (!snap.exists) raise.notFound();
    const job = snap.data()!;
    const org = (job.organization_id as string | null) ?? null;
    if (job.job_type === 'org.purge') {
      const o = org ? await tx.get(globalRow(db.fs, 'organizations', org)) : null;
      if (!o?.exists || o.get('status') !== 'pending_deletion' || o.get('deletion_requested_at') == null) {
        raise.conflict('this organization is not scheduled for deletion');
      }
    }
    // `jobs_idempotency_queued_unique`: a requeued job claims its key back, unless another job
    // already holds it queued.
    const key = (job.idempotency_key as string | null) ?? null;
    const claim = key
      ? await uniqueGuard(db.fs, 'global', 'jobs_idempotency_queued', [String(job.job_type), key]).read(tx)
      : null;
    if (claim?.owner && claim.owner !== jobId) {
      const holder = await tx.get(jobRef(db.fs, claim.owner));
      if (holder.exists && holder.get('status') === 'queued') raise.conflict('That already exists.');
    }
    const audit = await prepareAudit(db, {
      organizationId: org, action: 'job.requeued', targetTable: 'jobs', targetId: jobId,
      after: { job_type: job.job_type },
    }, tx);

    const now = nowIso();
    tx.update(ref, {
      status: 'queued', attempts: 0, locked_at: null, locked_by: null, finished_at: null, run_after: now, updated_at: now,
    });
    if (key) tx.set(uniqueGuard(db.fs, 'global', 'jobs_idempotency_queued', [String(job.job_type), key]).ref, {
      owner_id: jobId, constraint: 'jobs_idempotency_queued', created_at: now,
    });
    audit.write(tx);
    return jobId;
  });
}

/**
 * `api.cancel_job`: a person cancels a queued job they started — only the two kinds `api.enqueue_job`
 * lets a user create. Everything else is the platform's to manage from /platform/jobs.
 */
async function cancel_job(db: Db, args: Record<string, unknown>): Promise<string> {
  const jobId = arg.req(args, 'p_job');
  await throttleRpc(db);

  return runTx(db, async (tx) => {
    const ref = jobRef(db.fs, jobId);
    const snap = await tx.get(ref);
    const org = snap.exists ? ((snap.get('organization_id') as string | null) ?? null) : null;
    if (!org) raise.notFound();
    await requirePermission(db, org, 'intelligence.recompute', tx);
    const type = String(snap.get('job_type'));
    if (type !== 'calculation.run' && type !== 'report.render') raise.denied(`${type} is not a job you can cancel`);
    if (snap.get('requested_by') !== uidOf(db)) raise.denied('only the person who started a job can cancel it');
    if (snap.get('status') !== 'queued') raise.conflict('only a queued job can be cancelled');
    const audit = await prepareAudit(db, {
      organizationId: org, action: 'job.cancelled', targetTable: 'jobs', targetId: jobId,
    }, tx);

    const now = nowIso();
    tx.update(ref, { status: 'cancelled', finished_at: now, updated_at: now });
    releaseQueuedGuard(db.fs, tx, { job_type: type, idempotency_key: (snap.get('idempotency_key') as string | null) ?? null });
    audit.write(tx);
    return jobId;
  });
}

/** `api.*` functions of this area, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8). */
export const functions: DbFunctions = {
  grant_platform_role,
  revoke_platform_role,
  platform_audit_events,
  platform_company_owners,
  platform_create_organization,
  platform_owner_login_change,
  platform_purge_now,
  platform_set_company_owner,
  platform_users_list: (db) => platform_users_list(db),
  create_assignment,
  revoke_assignment,
  update_platform_org_settings,
  update_platform_settings,
  set_org_module,
  set_ai_active_provider,
  set_ai_api_key,
  set_ai_model,
  set_openai_api_key,
  clear_ai_api_key: (db) => clear_ai_api_key(db),
  clear_openai_api_key: (db) => clear_openai_api_key(db),
  ai_api_key_status: (db) => keyStatus(db, ANTHROPIC_SECRET),
  openai_api_key_status: (db) => keyStatus(db, OPENAI_SECRET),
  requeue_job,
  cancel_job,
};
