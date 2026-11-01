import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import type { DocumentData, Transaction } from 'firebase-admin/firestore';
import { ROLE_MATRIX, type GrantedRole, type Permission } from '@/core/permissions';
import { arg, type DbFunction, type DbFunctions } from '../registry';
import { raise } from '../raise';
import { globalRow, newId, nowIso, orgCollection, orgRow, overrideId, uniqueGuard } from '../schema';
import { runTx } from '../tx';
import { readerOf, uidOf, type Db, type Reader } from '../types';
import {
  SWITCHABLE_PERMISSIONS, accessibleOrgRoles, actorTypeOf, effectivePermission, hasPermission, hasPermissionOf,
  isSuperAdmin, orgRoleOf, overridableRole, requireOrg, requirePermission, requireSuperAdmin,
} from '../app/access';
import { prepareAudit, type PreparedAudit } from '../app/audit';
import { prepareEnqueue, prepareRecalculation, releaseQueuedGuard } from '../app/jobs';
import { prepareNotify, slugify, writeStandardChart } from '../app/shared';
import { throttle } from '../app/throttle';
import {
  MEMBERSHIP_ROLES, ceilingAllows, checkDepartments, checkMemberLoginRole, guardLastOwner,
  guardNotPlatformUser, isSwitchable, membershipOf, membershipRef, newMembership, orgPeople, pendingInvitationGuard,
  pendingRequestGuard, pendingTransferGuard, prepareMemberPermission, prepareMembershipDelete, prepareRoleChange,
  prepareRowAudit, profilesById, requireTimezone, roleDefault, roleOrder, rowByIdAnyOrg, same, sortedSet,
  writeNewOrgPeriods, type PreparedSwitch,
} from '../app/tenancy-members';

/**
 * `api.*` functions of the tenancy area — organisations, membership, invitations, ownership,
 * per-person switches, access requests, departments, team logins, profiles and the company's tax
 * settings — ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8; TENANCY_MODEL.md, ADR-172, ADR-173).
 *
 * Each keeps its SQL name, `p_` arguments, result shape, checks and refusal sentences. What the
 * triggers on these tables did is done here, in the same transaction (§4): the last-owner guard,
 * the role-change carry-over, `clear_owner_departments`, `set_updated_at`, the `audit_diff` row
 * events, `enqueue_purge_on_deletion` and `funding_enablement`. Unique keys are guard documents:
 * `organizations_slug_key`, `invitations_token_hash_key` (global), `invitation_pending_unique`,
 * `access_requests_one_pending`, `ownership_transfer_pending_unique` (per organisation); one
 * membership per person per organisation and one switch per person per permission hold by the
 * document id itself.
 */

const RPC = (db: Db) => throttle(db.fs, uidOf(db), 'rpc', 120, 60);
const HOUR = 3600;
const DAY = 86_400;

function requireUser(db: Db): string {
  const uid = uidOf(db);
  if (!uid) raise.denied('sign in required');
  return uid;
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Writes every prepared piece in order (all reads have been made). */
function writeAll(tx: Transaction, pieces: ReadonlyArray<{ write(tx: Transaction): void } | null | undefined>): void {
  for (const p of pieces) p?.write(tx);
}

async function orgOf(db: Db, orgId: string, r: Reader): Promise<DocumentData> {
  const snap = await r.get(globalRow(db.fs, 'organizations', orgId));
  if (!snap.exists) raise.notFound();
  return snap.data()!;
}

/** The organisation a slug names (`o.slug = p_slug::citext`): slugs are stored lower-case. */
async function orgBySlug(db: Db, slug: string | null): Promise<DocumentData | null> {
  if (!slug) return null;
  const snap = await db.fs.collection('organizations').where('slug', '==', slug.toLowerCase()).limit(1).get();
  return snap.empty ? null : snap.docs[0]!.data();
}

const byPermission = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  String(a.permission).localeCompare(String(b.permission));

// ── Organisations ────────────────────────────────────────────────────────────────────────────────

/**
 * `api.create_organization`: self-serve creation; the caller becomes its owner, the standard chart
 * is seeded (ADR-004) and two years of months exist from day one.
 */
const create_organization: DbFunction = async (db, args) => {
  const actor = uidOf(db);
  await throttle(db.fs, actor, 'create_organization', 3, DAY);
  if (!actor) raise.denied('sign in required');
  const name = (arg.str(args, 'p_name') ?? '').trim();
  const country = arg.str(args, 'p_country_code') ?? 'GB';
  const currency = arg.str(args, 'p_base_currency') ?? 'GBP';
  const fyMonth = arg.num(args, 'p_fiscal_year_start_month') ?? 1;
  const timezone = arg.str(args, 'p_timezone') ?? 'Europe/London';

  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    if ((await r.get(globalRow(db.fs, 'platform_users', actor))).exists) {
      raise.denied('platform accounts cannot own customer organizations');
    }
    if (name === '') raise.invalid('a name is required');
    if (!Number.isInteger(fyMonth) || fyMonth < 1 || fyMonth > 12) raise.invalid('fiscal year start month must be 1-12');
    if (name.length > 200) raise.conflict('that name is too long (200 characters at most)');
    requireTimezone(timezone);

    // ADR-044.5: at most five owned organisations on the trial plan.
    const owned = await r.query(db.fs.collectionGroup('organization_memberships')
      .where('user_id', '==', actor).where('status', '==', 'active'));
    const ownedOrgIds = owned.docs.filter((d) => d.get('role') === 'owner').map((d) => String(d.get('organization_id')));
    const ownedOrgs = await Promise.all(ownedOrgIds.map((id) => r.get(globalRow(db.fs, 'organizations', id))));
    const trialOwned = ownedOrgs.filter((s) => s.exists && s.get('status') !== 'deleted' && s.get('plan') === 'trial').length;
    if (trialOwned >= 5) raise.quota('trial accounts may own at most five organizations');

    let base = slugify(name);
    if (base.length < 3) base = `${base}-org`;
    let slug = base;
    const slugClaim = async (candidate: string) => uniqueGuard(db.fs, 'global', 'organizations_slug_key', [candidate]).read(tx);
    let claim = await slugClaim(slug);
    for (let n = 1; ; n += 1) {
      const taken = claim.owner !== null
        || !(await r.query(db.fs.collection('organizations').where('slug', '==', slug).limit(1))).empty;
      if (!taken) break;
      slug = `${base.slice(0, 34)}-${n}`;
      claim = await slugClaim(slug);
    }

    const orgId = newId();
    const now = nowIso();
    const org = {
      id: orgId, slug, name, legal_name: null, country_code: country, base_currency: currency,
      fiscal_year_start_month: fyMonth, industry: null, kind: 'customer', status: 'active', plan: 'trial',
      features: {}, settings: {}, timezone, deletion_requested_at: null, created_by: actor, deleted_at: null,
      created_at: now, updated_at: now,
    };
    const membership = newMembership({ orgId, userId: actor, role: 'owner', invitedBy: null });
    const profile = await r.get(globalRow(db.fs, 'profiles', actor));
    // The creator is not yet a member, so these audits are the bootstrap kind (see app.audit).
    const audits = await Promise.all([
      prepareRowAudit(db, 'organizations', 'insert', null, org, tx, { bootstrap: true }),
      prepareRowAudit(db, 'organization_memberships', 'insert', null, membership, tx, { bootstrap: true }),
      prepareAudit(db, {
        organizationId: orgId, action: 'org.created', targetTable: 'organizations', targetId: orgId,
        after: { slug, name }, bootstrap: true,
      }, tx),
    ]);

    tx.set(globalRow(db.fs, 'organizations', orgId), org);
    claim.take(tx, orgId, 'that organization already exists');
    tx.set(membershipRef(db.fs, orgId, actor), membership);
    if (profile.exists) tx.update(profile.ref, { last_active_org_id: orgId, updated_at: now });
    writeStandardChart(tx, db.fs, orgId);
    writeNewOrgPeriods(tx, db.fs, orgId, fyMonth);
    writeAll(tx, audits);
    return orgId;
  });
};

const TENANT_KEYS = ['name', 'legal_name', 'fiscal_year_start_month', 'timezone', 'industry', 'settings'];
const PLATFORM_KEYS = ['plan', 'features', 'kind', 'industry', 'status'];
const PLANS = ['trial', 'starter', 'professional', 'enterprise'];
const KINDS = ['customer', 'adviser'];
const QUOTA_KEYS = ['ai_quota_daily', 'ai_token_ceiling_monthly', 'ai_extraction_pages_per_day', 'model_overrides'];

const funded = (features: unknown): boolean =>
  String((features as Record<string, unknown> | null)?.funding_readiness ?? '') === 'true';

/** `api.update_organization`: the tenant's settings, and the platform's fields for the super admin. */
const update_organization: DbFunction = async (db, args) => {
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  const patch = arg.obj(args, 'p_patch');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    await requireOrg(db, orgId, tx);
    let allowed = TENANT_KEYS;
    if (await isSuperAdmin(db.fs, uidOf(db), r)) {
      allowed = [...TENANT_KEYS, ...PLATFORM_KEYS];
    } else {
      await requirePermission(db, orgId, 'settings.manage', tx);
    }
    for (const key of Object.keys(patch)) {
      // slug, created_by, deletion_requested_at, id and the deletion statuses are never patchable
      // (ADR-044.6; R2-A-10).
      if (!allowed.includes(key)) raise.invalid(`${key} cannot be changed here`);
    }
    if ('status' in patch && !['active', 'suspended'].includes(String(patch.status))) {
      raise.invalid('status may only move between active and suspended; deletion goes through api.request_deletion');
    }
    const settingsPatch = patch.settings && typeof patch.settings === 'object' ? patch.settings as Record<string, unknown> : null;
    // ADR-133: the VAT status has its own audited path, which recalculates.
    if (settingsPatch && 'vat_registered' in settingsPatch) {
      raise.invalid('set the VAT status with api.set_vat_registration');
    }
    // Quota keys live in platform_org_settings and are not tenant-editable (ADR-038.5; F-A-09).
    if (settingsPatch && QUOTA_KEYS.some((k) => k in settingsPatch)) {
      raise.invalid('quota settings are platform-controlled');
    }

    const before = await orgOf(db, orgId, r);
    const pick = (key: string): unknown => (patch[key] === undefined || patch[key] === null ? undefined : patch[key]);
    const oldSettings = (before.settings as Record<string, unknown> | undefined) ?? {};
    const after: DocumentData = { ...before };
    if (pick('name') !== undefined) after.name = String(pick('name'));
    if (pick('legal_name') !== undefined) after.legal_name = String(pick('legal_name'));
    if (pick('fiscal_year_start_month') !== undefined) {
      const fy = Number(pick('fiscal_year_start_month'));
      if (!Number.isInteger(fy)) raise.invalid('fiscal year start month must be 1-12');
      after.fiscal_year_start_month = fy;
    }
    if (pick('timezone') !== undefined) after.timezone = String(pick('timezone'));
    if (pick('industry') !== undefined) after.industry = String(pick('industry'));
    if ('settings' in patch) {
      after.settings = {
        ...(settingsPatch ?? {}),
        ...('vat_registered' in oldSettings ? { vat_registered: oldSettings.vat_registered } : {}),
      };
    }
    if (pick('plan') !== undefined) {
      if (!PLANS.includes(String(pick('plan')))) raise.invalid(`${String(pick('plan'))} is not a plan`);
      after.plan = String(pick('plan'));
    }
    if (pick('features') !== undefined) after.features = pick('features');
    if (pick('kind') !== undefined) {
      if (!KINDS.includes(String(pick('kind')))) raise.invalid(`${String(pick('kind'))} is not a kind of organization`);
      after.kind = String(pick('kind'));
    }
    if (pick('status') !== undefined) after.status = String(pick('status'));

    // The table's CHECKs and the timezone trigger.
    if (String(after.name).length < 1 || String(after.name).length > 200) raise.conflict('a name is 1 to 200 characters');
    const fy = Number(after.fiscal_year_start_month);
    if (fy < 1 || fy > 12) raise.conflict('fiscal year start month must be 1-12');
    requireTimezone(String(after.timezone));
    after.updated_at = nowIso();

    const pieces: Array<{ write(tx: Transaction): void }> = [];
    pieces.push(await prepareRowAudit(db, 'organizations', 'update', before, after, tx));
    pieces.push(await prepareAudit(db, {
      organizationId: orgId, action: 'org.updated', targetTable: 'organizations', targetId: orgId,
      before, after: patch,
    }, tx));
    // funding_enablement: switching Funding Readiness on backfills an assessment.
    if (funded(after.features) && !funded(before.features)) {
      pieces.push(await prepareEnqueue(db.fs, {
        organizationId: orgId, jobType: 'funding.assess', payload: { trigger: 'enablement_backfill' },
        requestedBy: null, idempotencyKey: `funding.assess:${orgId}`,
      }, tx));
      pieces.push(await prepareAudit(db, {
        organizationId: orgId, action: 'funding.enabled', targetTable: 'organizations', targetId: orgId, after: {},
      }, tx));
    }
    // ADR-133: the fiscal year, the timezone and the settings all change figures.
    if (after.fiscal_year_start_month !== before.fiscal_year_start_month || after.timezone !== before.timezone
      || !same(after.settings, before.settings)) {
      pieces.push(await prepareRecalculation(db.fs, orgId, 'settings_changed', null, uidOf(db), tx));
    }
    tx.set(globalRow(db.fs, 'organizations', orgId), after);
    writeAll(tx, pieces);
    return orgId;
  });
};

/** Reads the organisation for a settings change, after `settings.manage` is confirmed. */
async function settingsOrg(db: Db, orgId: string, tx: Transaction): Promise<DocumentData> {
  await requireOrg(db, orgId, tx);
  await requirePermission(db, orgId, 'settings.manage', tx);
  return orgOf(db, orgId, readerOf(tx));
}

/** `api.set_vat_registration` (ADR-133): its own key only, and a change recalculates. */
const set_vat_registration: DbFunction = async (db, args) => {
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  const status = arg.str(args, 'p_status');
  return runTx(db, async (tx) => {
    const before = await settingsOrg(db, orgId, tx);
    if (!status || !['registered', 'not_registered', 'unknown'].includes(status)) {
      raise.invalid('VAT status is registered, not_registered or unknown');
    }
    const settings = { ...((before.settings as Record<string, unknown> | undefined) ?? {}) };
    const was = settings.vat_registered === true ? 'registered' : settings.vat_registered === false ? 'not_registered' : 'unknown';
    if (was === status) return status;
    if (status === 'unknown') delete settings.vat_registered;
    else settings.vat_registered = status === 'registered';
    const after = { ...before, settings, updated_at: nowIso() };
    const pieces = [
      await prepareRowAudit(db, 'organizations', 'update', before, after, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'org.vat_status_changed', targetTable: 'organizations', targetId: orgId,
        before: { vat_status: was }, after: { vat_status: status },
      }, tx),
      await prepareRecalculation(db.fs, orgId, 'settings_changed', null, uidOf(db), tx),
    ];
    tx.update(globalRow(db.fs, 'organizations', orgId), { settings, updated_at: after.updated_at });
    writeAll(tx, pieces);
    return status;
  });
};

/** `api.set_tax_settings` (ADR-156): read when a report is drawn, so nothing is recalculated. */
const set_tax_settings: DbFunction = async (db, args) => {
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  const month = arg.num(args, 'p_vat_quarter_end_month');
  const scheme = arg.str(args, 'p_vat_scheme');
  const associated = arg.num(args, 'p_ct_associated_companies');
  return runTx(db, async (tx) => {
    const before = await settingsOrg(db, orgId, tx);
    // The month the first VAT quarter of the calendar year ends in — the three UK stagger groups.
    if (month === null || ![1, 2, 3].includes(month)) raise.invalid('VAT quarters end in month 1, 2 or 3 of the year');
    if (!scheme || !['standard', 'cash_accounting', 'flat_rate'].includes(scheme)) {
      raise.invalid('VAT scheme is standard, cash_accounting or flat_rate');
    }
    if (associated === null || !Number.isInteger(associated) || associated < 0 || associated > 50) {
      raise.invalid('associated companies is a number from 0 to 50');
    }
    const old = (before.settings as Record<string, unknown> | undefined) ?? {};
    const was = {
      vat_quarter_end_month: old.vat_quarter_end_month ?? null,
      vat_scheme: old.vat_scheme ?? null,
      ct_associated_companies: old.ct_associated_companies ?? null,
    };
    const now = { vat_quarter_end_month: month, vat_scheme: scheme, ct_associated_companies: associated };
    const settings = { ...old, ...now };
    const after = { ...before, settings, updated_at: nowIso() };
    const pieces: Array<{ write(tx: Transaction): void }> = [
      await prepareRowAudit(db, 'organizations', 'update', before, after, tx),
    ];
    if (!same(was, now)) {
      pieces.push(await prepareAudit(db, {
        organizationId: orgId, action: 'org.tax_settings_changed', targetTable: 'organizations', targetId: orgId,
        before: was, after: now,
      }, tx));
    }
    tx.update(globalRow(db.fs, 'organizations', orgId), { settings, updated_at: after.updated_at });
    writeAll(tx, pieces);
    return now;
  });
};

const CURRENCIES = ['GBP', 'AED', 'EUR', 'USD', 'INR'];
const COUNTRIES = ['GB', 'AE', 'IE', 'IN'];
const FINANCIAL_TABLES = ['ledger_entries', 'period_balances', 'invoices', 'bank_transactions', 'bank_accounts'] as const;

/** `api.set_currency_and_country` (ADR-156): the currency only while no financial record exists. */
const set_currency_and_country: DbFunction = async (db, args) => {
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  const currency = arg.str(args, 'p_currency');
  const country = arg.str(args, 'p_country');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const before = await settingsOrg(db, orgId, tx);
    if (!currency || !CURRENCIES.includes(currency)) raise.invalid('currency is one of GBP, AED, EUR, USD or INR');
    if (!country || !COUNTRIES.includes(country)) raise.invalid('country is one of GB, AE, IE or IN');
    if (before.base_currency !== currency) {
      for (const table of FINANCIAL_TABLES) {
        if (!(await r.query(orgCollection(db.fs, orgId, table).limit(1))).empty) {
          raise.invalid('the currency cannot change once financial records exist — amounts are never converted, so every figure would be relabelled');
        }
      }
    }
    const result = { currency, country };
    if (before.base_currency === currency && before.country_code === country) return result;
    const after = { ...before, base_currency: currency, country_code: country, updated_at: nowIso() };
    const pieces = [
      await prepareRowAudit(db, 'organizations', 'update', before, after, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'org.currency_country_changed', targetTable: 'organizations', targetId: orgId,
        before: { currency: before.base_currency ?? null, country: before.country_code ?? null }, after: result,
      }, tx),
    ];
    tx.update(globalRow(db.fs, 'organizations', orgId), { base_currency: currency, country_code: country, updated_at: after.updated_at });
    writeAll(tx, pieces);
    return result;
  });
};

/** `api.request_deletion`: thirty days' grace, then `org.purge` (trigger `enqueue_purge_on_deletion`). */
const request_deletion: DbFunction = async (db, args) => {
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  return runTx(db, async (tx) => {
    await requirePermission(db, orgId, 'org.delete', tx);
    const before = await orgOf(db, orgId, readerOf(tx));
    if (before.status !== 'active') raise.conflict('only an active organization can be scheduled for deletion');
    const now = nowIso();
    const after = { ...before, status: 'pending_deletion', deletion_requested_at: now, updated_at: now };
    const pieces = [
      await prepareEnqueue(db.fs, {
        organizationId: orgId, jobType: 'org.purge', payload: {}, requestedBy: null,
        idempotencyKey: `org.purge:${orgId}`, runAfter: new Date(Date.now() + 30 * DAY * 1000).toISOString(),
      }, tx),
      await prepareRowAudit(db, 'organizations', 'update', before, after, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'org.deletion_requested', targetTable: 'organizations', targetId: orgId,
      }, tx),
    ];
    tx.update(globalRow(db.fs, 'organizations', orgId), { status: 'pending_deletion', deletion_requested_at: now, updated_at: now });
    writeAll(tx, pieces);
    return orgId;
  });
};

/** `api.cancel_deletion`: back to active, and the queued purge is cancelled. */
const cancel_deletion: DbFunction = async (db, args) => {
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    await requirePermission(db, orgId, 'org.delete', tx);
    const before = await orgOf(db, orgId, r);
    if (before.status !== 'pending_deletion') raise.conflict('this organization is not scheduled for deletion');
    const purges = await r.query(db.fs.collection('jobs').where('organization_id', '==', orgId)
      .where('job_type', '==', 'org.purge').where('status', '==', 'queued'));
    const now = nowIso();
    const after = { ...before, status: 'active', deletion_requested_at: null, updated_at: now };
    const pieces = [
      await prepareRowAudit(db, 'organizations', 'update', before, after, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'org.deletion_cancelled', targetTable: 'organizations', targetId: orgId,
      }, tx),
    ];
    tx.update(globalRow(db.fs, 'organizations', orgId), { status: 'active', deletion_requested_at: null, updated_at: now });
    for (const job of purges.docs) {
      tx.update(job.ref, { status: 'cancelled', finished_at: now, updated_at: now });
      releaseQueuedGuard(db.fs, tx, { job_type: 'org.purge', idempotency_key: (job.get('idempotency_key') as string | null) ?? null });
    }
    writeAll(tx, pieces);
    return orgId;
  });
};

// ── The caller's own view ────────────────────────────────────────────────────────────────────────

/** `api.my_context(slug)`: the organisation the slug names, as the caller reaches it. */
const my_context: DbFunction = async (db, args) => {
  const uid = uidOf(db);
  const org = await orgBySlug(db, arg.str(args, 'p_slug'));
  if (!org || !uid) return [];
  const role = await orgRoleOf(db.fs, uid, String(org.id));
  if (!role) return [];
  return [{
    organization_id: org.id, slug: org.slug, name: org.name, status: org.status, role,
    actor_type: await actorTypeOf(db.fs, uid),
  }];
};

/**
 * `api.my_access(slug)` (ADR-172): `my_context` plus the systems, the caller's per-person switches,
 * the effective permissions computed from them and the departments — one call per request.
 */
const my_access: DbFunction = async (db, args) => {
  const uid = uidOf(db);
  const org = await orgBySlug(db, arg.str(args, 'p_slug'));
  if (!org || !uid) return [];
  const orgId = String(org.id);
  const role = await orgRoleOf(db.fs, uid, orgId);
  if (!role) return [];
  const takes = overridableRole(role);
  const [actorType, overrideSnap, membership] = await Promise.all([
    actorTypeOf(db.fs, uid),
    takes ? orgCollection(db.fs, orgId, 'member_permission_overrides').where('user_id', '==', uid).get() : null,
    takes ? membershipOf(db.fs, orgId, uid, readerOf()) : null,
  ]);
  const overrides = (overrideSnap?.docs ?? [])
    .map((d) => ({ permission: String(d.get('permission')), granted: d.get('granted') === true }))
    .sort(byPermission);
  const candidates = sortedSet([...(ROLE_MATRIX[role as GrantedRole] ?? []), ...SWITCHABLE_PERMISSIONS]);
  const permissions: string[] = [];
  for (const p of candidates) {
    if (await effectivePermission(db.fs, uid, orgId, role, p as Permission)) permissions.push(p);
  }
  const departments = membership && membership.status === 'active' && Array.isArray(membership.departments)
    ? (membership.departments as string[]) : null;
  return [{
    organization_id: orgId, slug: org.slug, name: org.name, status: org.status, role, actor_type: actorType,
    features: (org.features as Record<string, unknown> | undefined) ?? {}, overrides, permissions, departments,
  }];
};

/** `api.my_organizations()`: every organisation the caller reaches, by name. */
const my_organizations: DbFunction = async (db) => {
  const roles = await accessibleOrgRoles(db.fs, uidOf(db));
  if (roles.length === 0) return [];
  const snaps = await db.fs.getAll(...roles.map((r) => globalRow(db.fs, 'organizations', r.organization_id)));
  const byId = new Map(snaps.filter((s) => s.exists).map((s) => [s.id, s.data()!]));
  return roles
    .filter((r) => byId.has(r.organization_id))
    .map((r) => {
      const o = byId.get(r.organization_id)!;
      return { organization_id: r.organization_id, slug: o.slug, name: o.name, status: o.status, role: r.role };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.organization_id.localeCompare(b.organization_id));
};

/** `api.my_platform_role()`. */
const my_platform_role: DbFunction = async (db) => {
  const uid = uidOf(db);
  if (!uid) return [];
  const snap = await globalRow(db.fs, 'platform_users', uid).get();
  return snap.exists ? [{ platform_role: snap.get('platform_role'), status: snap.get('status') }] : [];
};

/** `api.my_profile()`: a stale or foreign last organisation is never resolved (ROUTE_ARCHITECTURE.md §8.6). */
const my_profile: DbFunction = async (db) => {
  const uid = uidOf(db);
  if (!uid) return [];
  const snap = await globalRow(db.fs, 'profiles', uid).get();
  if (!snap.exists) return [];
  const p = snap.data()!;
  const last = (p.last_active_org_id as string | null) ?? null;
  const reachable = last ? Boolean(await orgRoleOf(db.fs, uid, last)) : false;
  return [{
    user_id: uid, email: p.email, full_name: p.full_name ?? null, avatar_url: p.avatar_url ?? null,
    timezone: p.timezone, last_active_org_id: reachable ? last : null,
    onboarding_state: p.onboarding_state ?? {}, disabled: p.disabled_at !== null && p.disabled_at !== undefined,
  }];
};

/**
 * `api.my_previous_sign_in()` (department dashboard, ADR-180): when the caller signed in BEFORE the
 * sign-in that opened this session — the prototype's "Last login". Only the caller's own
 * `auth.sign_in` audit rows are read (index: actor_user_id, action, created_at desc), and only their
 * time leaves; never the IP or the user agent stored beside it.
 */
const my_previous_sign_in: DbFunction = async (db) => {
  const uid = uidOf(db);
  if (!uid) return [];
  const snap = await db.fs.collection('audit_events')
    .where('actor_user_id', '==', uid).where('action', '==', 'auth.sign_in')
    .orderBy('created_at', 'desc').limit(2).select('created_at').get();
  const previous = snap.docs[1];
  return previous === undefined ? [] : [{ created_at: String(previous.get('created_at')) }];
};

/** `api.set_last_active_org`. */
const set_last_active_org: DbFunction = async (db, args) => {
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  await requireOrg(db, orgId);
  const uid = requireUser(db);
  const ref = globalRow(db.fs, 'profiles', uid);
  await runTx(db, async (tx) => {
    if ((await tx.get(ref)).exists) tx.update(ref, { last_active_org_id: orgId, updated_at: nowIso() });
  });
  return orgId;
};

const PROFILE_KEYS = ['full_name', 'avatar_url', 'timezone', 'onboarding_state', 'last_active_org_id'];

/** `api.update_profile`: email is the account's, disabled_at the super admin's (ADR-038.3; F-A-07). */
const update_profile: DbFunction = async (db, args) => {
  const actor = uidOf(db);
  await throttle(db.fs, actor, 'rpc', 120, 60);
  if (!actor) raise.denied('sign in required');
  const patch = arg.obj(args, 'p_patch');
  for (const key of Object.keys(patch)) {
    if (!PROFILE_KEYS.includes(key)) raise.invalid(`${key} cannot be changed here`);
  }
  const last = 'last_active_org_id' in patch ? (patch.last_active_org_id as string | null) ?? null : undefined;
  if (last) {
    if (!(await orgRoleOf(db.fs, actor, last))) raise.notFound();
  }
  await runTx(db, async (tx) => {
    const ref = globalRow(db.fs, 'profiles', actor);
    const snap = await tx.get(ref);
    const prepared = await prepareAudit(db, {
      organizationId: null, action: 'profile.updated', targetTable: 'profiles', targetId: actor, after: patch,
    }, tx);
    if (snap.exists) {
      const update: Record<string, unknown> = { updated_at: nowIso() };
      for (const key of ['full_name', 'avatar_url', 'timezone', 'onboarding_state']) {
        if (patch[key] !== undefined && patch[key] !== null) update[key] = patch[key];
      }
      if (last !== undefined) update.last_active_org_id = last;
      tx.update(ref, update);
    }
    prepared.write(tx);
  });
  return actor;
};

// ── Lists for the team page ──────────────────────────────────────────────────────────────────────

const nullsLast = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return String(a).localeCompare(String(b));
};

async function membersWithProfiles(db: Db, orgId: string) {
  const members = (await orgCollection(db.fs, orgId, 'organization_memberships').get()).docs.map((d) => d.data());
  const profiles = await profilesById(db.fs, members.map((m) => String(m.user_id)));
  return members.filter((m) => profiles.has(String(m.user_id))).map((m) => ({ m, p: profiles.get(String(m.user_id))! }));
}

/** `api.org_members`. */
const org_members: DbFunction = async (db, args) => {
  const orgId = arg.req(args, 'p_org');
  await requirePermission(db, orgId, 'users.view');
  return (await membersWithProfiles(db, orgId))
    .sort((a, b) => roleOrder(a.m.role) - roleOrder(b.m.role) || nullsLast(a.p.full_name, b.p.full_name))
    .map(({ m, p }) => ({
      user_id: m.user_id, full_name: p.full_name ?? null, email: p.email, role: m.role, status: m.status, joined_at: m.joined_at,
    }));
};

/** `api.org_member_permissions` (ADR-172): everyone's switches, for the team page. */
const org_member_permissions: DbFunction = async (db, args) => {
  const orgId = arg.req(args, 'p_org');
  await requirePermission(db, orgId, 'users.view');
  const [rows, overrides] = await Promise.all([
    membersWithProfiles(db, orgId),
    orgCollection(db.fs, orgId, 'member_permission_overrides').get(),
  ]);
  const byUser = new Map<string, Array<Record<string, unknown>>>();
  for (const d of overrides.docs) {
    const list = byUser.get(String(d.get('user_id'))) ?? [];
    list.push({
      permission: d.get('permission'), granted: d.get('granted'), set_by_owner: d.get('set_by_owner') === true,
      ceiling_withhold: d.get('ceiling_withhold') === true,
    });
    byUser.set(String(d.get('user_id')), list);
  }
  return rows
    .sort((a, b) => roleOrder(a.m.role) - roleOrder(b.m.role) || nullsLast(a.p.full_name, b.p.full_name)
      || String(a.p.email).localeCompare(String(b.p.email)))
    .map(({ m, p }) => ({
      user_id: m.user_id, full_name: p.full_name ?? null, email: p.email, role: m.role, status: m.status,
      overrides: (byUser.get(String(m.user_id)) ?? []).sort(byPermission),
    }));
};

/** `api.org_member_departments` (ADR-173). */
const org_member_departments: DbFunction = async (db, args) => {
  const orgId = arg.req(args, 'p_org');
  await requirePermission(db, orgId, 'users.view');
  const members = await orgCollection(db.fs, orgId, 'organization_memberships').get();
  return members.docs.map((d) => d.data()).filter((m) => overridableRole(String(m.role))).map((m) => ({
    user_id: m.user_id, departments: (m.departments as string[] | null) ?? null, set_by_owner: m.departments_set_by_owner === true,
  }));
};

/** `api.org_invitations`: the pending ones, newest first. */
const org_invitations: DbFunction = async (db, args) => {
  const orgId = arg.req(args, 'p_org');
  await requirePermission(db, orgId, 'users.view');
  const snap = await orgCollection(db.fs, orgId, 'invitations').where('status', '==', 'pending').get();
  return snap.docs.map((d) => d.data())
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((i) => ({ invitation_id: i.id, email: i.email, role: i.role, status: i.status, expires_at: i.expires_at }));
};

/** `api.org_advisers`: the platform staff currently assigned. */
const org_advisers: DbFunction = async (db, args) => {
  const orgId = arg.req(args, 'p_org');
  await requirePermission(db, orgId, 'assignments.view');
  const snap = await orgCollection(db.fs, orgId, 'organization_assignments').where('status', '==', 'active').get();
  const rows = snap.docs.map((d) => d.data());
  const profiles = await profilesById(db.fs, rows.map((a) => String(a.employee_user_id)));
  return rows
    .filter((a) => profiles.has(String(a.employee_user_id)))
    .map((a) => ({
      assignment_id: a.id, employee_id: a.employee_user_id, full_name: profiles.get(String(a.employee_user_id))!.full_name ?? null,
      assigned_at: a.created_at, ends_at: a.ends_at ?? null, status: a.status,
    }))
    .sort((a, b) => nullsLast(a.full_name, b.full_name));
};

/** `api.org_audit_events`: the organisation's log, newest first (index: organization_id, created_at desc). */
const org_audit_events: DbFunction = async (db, args) => {
  const orgId = arg.req(args, 'p_org');
  await requirePermission(db, orgId, 'audit.view');
  const limit = Math.max(0, Math.min(arg.num(args, 'p_limit') ?? 100, 500));
  const offset = Math.max(arg.num(args, 'p_offset') ?? 0, 0);
  if (limit === 0) return [];
  const snap = await db.fs.collection('audit_events').where('organization_id', '==', orgId)
    .orderBy('created_at', 'desc').offset(offset).limit(limit).get();
  const rows = snap.docs.map((d) => d.data());
  const profiles = await profilesById(db.fs, rows.map((e) => String(e.actor_user_id ?? '')));
  return rows.map((e) => ({
    id: e.id, action: e.action, actor_type: e.actor_type,
    actor_name: e.actor_user_id ? profiles.get(String(e.actor_user_id))?.full_name ?? null : null,
    target_table: e.target_table ?? null, target_id: e.target_id ?? null, metadata: e.metadata ?? {}, created_at: e.created_at,
  }));
};

// ── Invitations ──────────────────────────────────────────────────────────────────────────────────

/** `api.invite_member_with_token`: the raw token is returned once and only its SHA-256 is stored. */
const invite_member_with_token: DbFunction = async (db, args) => {
  await throttle(db.fs, uidOf(db), 'invite_member', 20, HOUR);
  const orgId = arg.req(args, 'p_org');
  const email = (arg.str(args, 'p_email') ?? '').trim().toLowerCase();
  const role = arg.str(args, 'p_role');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const actorRole = await requirePermission(db, orgId, 'users.invite', tx);
    if (!role || !(MEMBERSHIP_ROLES as readonly string[]).includes(role)) raise.invalid(`${role} is not a role`);
    if (!ceilingAllows(actorRole, role)) raise.denied(`you cannot invite someone as ${role}`);
    if (!email.includes('@')) raise.invalid('a valid email address is required');

    const holders = await r.query(db.fs.collection('profiles').where('email', '==', email).limit(5));
    for (const p of holders.docs) {
      if ((await r.get(membershipRef(db.fs, orgId, p.id))).exists) raise.conflict('that person is already a member');
    }
    for (const p of holders.docs) {
      if ((await r.get(globalRow(db.fs, 'platform_users', p.id))).exists) {
        raise.conflict('that address belongs to an APX platform account');
      }
    }

    // Never beyond the inviter's own rights (2026-10-14, review HIGH 2 "C").
    const withheld: string[] = [];
    if (overridableRole(role)) {
      for (const p of SWITCHABLE_PERMISSIONS) {
        if (roleDefault(role, p) && !(await hasPermission(db, orgId, p, tx))) withheld.push(p);
      }
      withheld.sort();
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(token);
    const pendingClaim = await pendingInvitationGuard(db.fs, orgId, email).read(tx);
    const pendingLegacy = await r.query(orgCollection(db.fs, orgId, 'invitations')
      .where('email', '==', email).where('status', '==', 'pending').limit(1));
    const tokenClaim = await uniqueGuard(db.fs, 'global', 'invitations_token_hash_key', [tokenHash]).read(tx);

    const id = newId();
    const now = new Date();
    const row = {
      id, organization_id: orgId, email, role, token_hash: tokenHash, invited_by: uidOf(db),
      expires_at: new Date(now.getTime() + 7 * DAY * 1000).toISOString(), accepted_at: null, accepted_user_id: null,
      status: 'pending', created_at: nowIso(now), updated_at: nowIso(now), withheld_permissions: withheld,
    };
    const pieces = [
      await prepareRowAudit(db, 'invitations', 'insert', null, row, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'member.invited', targetTable: 'invitations', targetId: id,
        after: { role, withheld }, metadata: { invitation_id: id },
      }, tx),
    ];
    const pendingMessage = 'an invitation for that address is already pending';
    if (!pendingLegacy.empty) raise.conflict(pendingMessage);
    pendingClaim.take(tx, id, pendingMessage);
    tokenClaim.take(tx, id, pendingMessage);
    tx.set(orgRow(db.fs, orgId, 'invitations', id), row);
    writeAll(tx, pieces);
    return [{ invitation_id: id, token }];
  });
};

/** `api.invite_member`: the same, for callers that do not send the email themselves. */
const invite_member: DbFunction = async (db, args) => {
  const rows = (await invite_member_with_token(db, args)) as Array<{ invitation_id: string }>;
  return rows[0]?.invitation_id ?? null;
};

/** `api.revoke_invitation`. */
const revoke_invitation: DbFunction = async (db, args) => {
  await RPC(db);
  const id = arg.req(args, 'p_invitation');
  return runTx(db, async (tx) => {
    const inv = await rowByIdAnyOrg(db.fs, 'invitations', id, readerOf(tx));
    if (!inv) raise.notFound();
    const orgId = String(inv.organization_id);
    await requirePermission(db, orgId, 'users.invite', tx);
    if (inv.status !== 'pending') raise.conflict('that invitation is no longer pending');
    const after = { ...inv, status: 'revoked', updated_at: nowIso() };
    const pieces = [
      await prepareRowAudit(db, 'invitations', 'update', inv, after, tx),
      await prepareAudit(db, { organizationId: orgId, action: 'member.invitation_revoked', targetTable: 'invitations', targetId: id }, tx),
    ];
    tx.update(orgRow(db.fs, orgId, 'invitations', id), { status: 'revoked', updated_at: after.updated_at });
    tx.delete(pendingInvitationGuard(db.fs, orgId, String(inv.email)).ref);
    writeAll(tx, pieces);
    return id;
  });
};

/**
 * `api.accept_invitation`: bound to the signed-in account's email, which must be confirmed
 * (ADR-038.3); the inviter must STILL be able to grant the role (F-A-02); and never beyond the
 * inviter's rights — what they lacked when they invited and what they lack now are switched off.
 */
const accept_invitation: DbFunction = async (db, args) => {
  const actor = uidOf(db);
  await throttle(db.fs, actor, 'accept_invitation', 10, HOUR);
  if (!actor) raise.denied('sign in required');
  const hash = sha256Hex(arg.str(args, 'p_token') ?? '');
  const jwtEmail = db.actor.kind === 'user' ? db.actor.email : null;

  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const found = await r.query(db.fs.collectionGroup('invitations').where('token_hash', '==', hash).limit(5));
    const inv = found.docs.map((d) => d.data())
      .find((i) => i.status === 'pending' && new Date(String(i.expires_at)).getTime() > Date.now());
    if (!inv) raise.notFound();
    const orgId = String(inv.organization_id);

    if (!jwtEmail || jwtEmail.toLowerCase() !== String(inv.email).toLowerCase()) {
      raise.denied('this invitation was sent to a different address');
    }
    const profile = await r.get(globalRow(db.fs, 'profiles', actor));
    if (!profile.exists || !profile.get('email_confirmed_at')) raise.denied('confirm your email address first');
    if ((await r.get(globalRow(db.fs, 'platform_users', actor))).exists) {
      raise.conflict('platform accounts cannot join customer organizations');
    }

    const invitedBy = (inv.invited_by as string | null) ?? null;
    let inviter: string | null = null;
    if (invitedBy) {
      const m = await membershipOf(db.fs, orgId, invitedBy, r);
      if (m && m.status === 'active') inviter = String(m.role);
      // ADR-160: a company the super admin created has no members yet; its owner's invitation came
      // from the super admin, who counts while still the active super admin.
      if (!inviter && await isSuperAdmin(db.fs, invitedBy, r)) inviter = 'owner';
    }
    if (!inviter || !ceilingAllows(inviter, String(inv.role))) {
      raise.denied('the person who invited you can no longer grant this role');
    }
    if ((await r.get(membershipRef(db.fs, orgId, actor))).exists) {
      raise.conflict('you are already a member of that organization');
    }

    const role = String(inv.role);
    let withheld: string[] = [];
    if (overridableRole(role)) {
      const lacking: string[] = [];
      for (const p of SWITCHABLE_PERMISSIONS) {
        if (roleDefault(role, p) && !(await hasPermissionOf(db.fs, invitedBy, orgId, p, r))) lacking.push(p);
      }
      withheld = sortedSet([...((inv.withheld_permissions as string[] | undefined) ?? []), ...lacking]).filter(isSwitchable);
    }

    const now = nowIso();
    const membership = newMembership({ orgId, userId: actor, role, invitedBy });
    const accepted = { ...inv, status: 'accepted', accepted_at: now, accepted_user_id: actor, updated_at: now };
    const pieces = [
      await prepareRowAudit(db, 'organization_memberships', 'insert', null, membership, tx, { bootstrap: true }),
      await prepareRowAudit(db, 'invitations', 'update', inv, accepted, tx, { bootstrap: true }),
      await prepareAudit(db, {
        organizationId: orgId, action: 'member.joined', targetTable: 'organization_memberships', targetId: actor,
        after: { role, withheld }, bootstrap: true,
      }, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'member.invitation_accepted', targetTable: 'invitations', targetId: String(inv.id),
        bootstrap: true,
      }, tx),
    ];

    tx.set(membershipRef(db.fs, orgId, actor), membership);
    for (const p of withheld) {
      tx.set(orgRow(db.fs, orgId, 'member_permission_overrides', overrideId(actor, p)), {
        organization_id: orgId, user_id: actor, permission: p, granted: false, set_by: invitedBy, set_at: now,
        set_by_owner: false, ceiling_withhold: true,
      });
    }
    tx.update(orgRow(db.fs, orgId, 'invitations', String(inv.id)), {
      status: 'accepted', accepted_at: now, accepted_user_id: actor, updated_at: now,
    });
    tx.delete(pendingInvitationGuard(db.fs, orgId, String(inv.email)).ref);
    tx.update(profile.ref, { last_active_org_id: orgId, updated_at: now });
    writeAll(tx, pieces);
    return orgId;
  });
};

// ── Membership ───────────────────────────────────────────────────────────────────────────────────

/** `api.leave_organization`: the last-owner guard still holds. */
const leave_organization: DbFunction = async (db, args) => {
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    await requireOrg(db, orgId, tx);
    const uid = requireUser(db);
    const m = await membershipOf(db.fs, orgId, uid, r);
    if (!m) raise.notFound();
    await guardLastOwner(db.fs, orgId, m, null, r);
    const del = await prepareMembershipDelete(db.fs, orgId, uid, r);
    const pieces = [
      await prepareRowAudit(db, 'organization_memberships', 'delete', m, null, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'member.left', targetTable: 'organization_memberships', targetId: uid,
        before: { role: m.role },
      }, tx),
    ];
    del.write(tx);
    writeAll(tx, pieces);
    return orgId;
  });
};

/**
 * `api.remove_member`. Access ends on the next request regardless; `tenancy.removeMember` also ends
 * the removed member's sessions when the remover is an owner (SECURITY_MODEL.md §4; ADR-075).
 */
const remove_member: DbFunction = async (db, args) => {
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  const userId = arg.req(args, 'p_user');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const role = await requirePermission(db, orgId, 'users.manage', tx);
    const m = await membershipOf(db.fs, orgId, userId, r);
    if (!m) raise.notFound();
    if (!ceilingAllows(role, String(m.role))) raise.denied(`you cannot remove a ${String(m.role)}`);
    await guardLastOwner(db.fs, orgId, m, null, r);
    const del = await prepareMembershipDelete(db.fs, orgId, userId, r);
    const pieces = [
      await prepareRowAudit(db, 'organization_memberships', 'delete', m, null, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'member.removed', targetTable: 'organization_memberships', targetId: userId,
        before: { role: m.role },
      }, tx),
    ];
    del.write(tx);
    writeAll(tx, pieces);
    return userId;
  });
};

/** `api.set_member_status`: switch a person's access off or on. */
const set_member_status: DbFunction = async (db, args) => {
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  const userId = arg.req(args, 'p_user');
  const status = arg.str(args, 'p_status');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const role = await requirePermission(db, orgId, 'users.manage', tx);
    if (status !== 'active' && status !== 'suspended') raise.invalid(`${status} is not a membership status`);
    const m = await membershipOf(db.fs, orgId, userId, r);
    if (!m) raise.notFound();
    if (!ceilingAllows(role, String(m.role))) raise.denied(`you cannot act on a ${String(m.role)}`);
    const after = { ...m, status, updated_at: nowIso() };
    await guardLastOwner(db.fs, orgId, m, after, r);
    await guardNotPlatformUser(db.fs, userId, r);
    const pieces = [
      await prepareRowAudit(db, 'organization_memberships', 'update', m, after, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'member.status_changed', targetTable: 'organization_memberships', targetId: userId,
        after: { status },
      }, tx),
    ];
    tx.update(membershipRef(db.fs, orgId, userId), { status, updated_at: after.updated_at });
    writeAll(tx, pieces);
    return userId;
  });
};

/**
 * `api.change_member_role`: never one's OWN role (2026-10-14, review HIGH 2 "A"); the ceiling on the
 * current and the target role (F-A-02); and the trigger's carry-over (`prepareRoleChange`).
 */
const change_member_role: DbFunction = async (db, args) => {
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  const userId = arg.req(args, 'p_user');
  const newRole = arg.str(args, 'p_role');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const role = await requirePermission(db, orgId, 'users.manage', tx);
    if (!newRole || !(MEMBERSHIP_ROLES as readonly string[]).includes(newRole)) raise.invalid(`${newRole} is not a role`);
    if (userId === uidOf(db)) raise.denied('you cannot change your own role');
    const m = await membershipOf(db.fs, orgId, userId, r);
    if (!m) raise.notFound();
    const current = String(m.role);
    if (!ceilingAllows(role, current)) raise.denied(`you cannot act on a ${current} `);
    if (!ceilingAllows(role, newRole)) raise.denied(`you cannot grant the role ${newRole}`);
    await guardNotPlatformUser(db.fs, userId, r);
    const change = await prepareRoleChange(db, tx, { orgId, membership: m, newRole, actorRole: role });
    await guardLastOwner(db.fs, orgId, m, change.row, r);
    const pieces = [
      await prepareRowAudit(db, 'organization_memberships', 'update', m, change.row, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'member.role_changed', targetTable: 'organization_memberships', targetId: userId,
        before: { role: current }, after: { role: newRole },
      }, tx),
    ];
    change.write(tx);
    writeAll(tx, pieces);
    return userId;
  });
};

// ── Ownership transfer ───────────────────────────────────────────────────────────────────────────

/** `api.initiate_ownership_transfer`: an owner offers ownership to an active admin. */
const initiate_ownership_transfer: DbFunction = async (db, args) => {
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  const nominee = arg.req(args, 'p_nominee');
  const demoteArg = arg.bool(args, 'p_demote');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const role = await requirePermission(db, orgId, 'users.manage', tx);
    if (role !== 'owner' && role !== 'super_admin') raise.denied('only an owner can transfer ownership');
    const m = await membershipOf(db.fs, orgId, nominee, r);
    if (!m || m.status !== 'active') raise.notFound();
    if (m.role !== 'admin') raise.invalid('ownership can only be transferred to an active admin');
    const initiator = requireUser(db);
    if (initiator === nominee) raise.conflict('you cannot transfer ownership to yourself');

    const message = 'a transfer is already pending for this organization';
    const claim = await pendingTransferGuard(db.fs, orgId).read(tx);
    const legacy = await r.query(orgCollection(db.fs, orgId, 'ownership_transfers').where('status', '==', 'pending').limit(1));
    if (!legacy.empty && legacy.docs[0]!.id !== claim.owner) raise.conflict(message);

    const id = newId();
    const now = new Date();
    const row = {
      id, organization_id: orgId, initiator_user_id: initiator, nominee_user_id: nominee,
      demote_initiator: demoteArg ?? false, status: 'pending',
      expires_at: new Date(now.getTime() + 7 * DAY * 1000).toISOString(), accepted_at: null, cancelled_by: null,
      created_at: nowIso(now), updated_at: nowIso(now),
    };
    const pieces = [
      await prepareRowAudit(db, 'ownership_transfers', 'insert', null, row, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'ownership.transfer_initiated', targetTable: 'ownership_transfers', targetId: id,
        after: { nominee, demote_initiator: demoteArg },
      }, tx),
    ];
    claim.take(tx, id, message);
    tx.set(orgRow(db.fs, orgId, 'ownership_transfers', id), row);
    writeAll(tx, pieces);
    return id;
  });
};

/** `api.accept_ownership_transfer`: both parties re-checked at ACCEPTANCE time (R2-A-11). */
const accept_ownership_transfer: DbFunction = async (db, args) => {
  await RPC(db);
  const id = arg.req(args, 'p_transfer');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const t = await rowByIdAnyOrg(db.fs, 'ownership_transfers', id, r);
    if (!t) raise.notFound();
    if (t.nominee_user_id !== uidOf(db)) raise.notFound();
    if (t.status !== 'pending') raise.conflict('this transfer is no longer pending');
    // PostgreSQL marked it expired and then raised, which rolled the mark back: nothing is written.
    if (new Date(String(t.expires_at)).getTime() <= Date.now()) raise.conflict('this transfer has expired');
    const orgId = String(t.organization_id);
    const [nominee, initiator] = await Promise.all([
      membershipOf(db.fs, orgId, String(t.nominee_user_id), r),
      membershipOf(db.fs, orgId, String(t.initiator_user_id), r),
    ]);
    if (!nominee || nominee.status !== 'active' || nominee.role !== 'admin') {
      raise.conflict('you are no longer an admin of this organization');
    }
    if (!initiator || initiator.status !== 'active' || initiator.role !== 'owner') {
      raise.conflict('the person who offered the transfer is no longer an owner');
    }

    const promote = await prepareRoleChange(db, tx, { orgId, membership: nominee, newRole: 'owner', actorRole: 'admin' });
    const pieces: Array<{ write(tx: Transaction): void }> = [
      promote,
      await prepareRowAudit(db, 'organization_memberships', 'update', nominee, promote.row, tx),
    ];
    if (t.demote_initiator === true) {
      // The nominee is the owner by the time the initiator is demoted.
      const demote = await prepareRoleChange(db, tx, { orgId, membership: initiator, newRole: 'admin', actorRole: 'owner' });
      await guardLastOwner(db.fs, orgId, initiator, demote.row, r, 1);
      pieces.push(demote, await prepareRowAudit(db, 'organization_memberships', 'update', initiator, demote.row, tx));
    }
    const now = nowIso();
    const after = { ...t, status: 'accepted', accepted_at: now, updated_at: now };
    pieces.push(
      await prepareRowAudit(db, 'ownership_transfers', 'update', t, after, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'ownership.transferred', targetTable: 'ownership_transfers', targetId: id,
        before: { initiator: t.initiator_user_id },
        after: { nominee: t.nominee_user_id, initiator_demoted: t.demote_initiator },
      }, tx),
    );
    writeAll(tx, pieces);
    tx.update(orgRow(db.fs, orgId, 'ownership_transfers', id), { status: 'accepted', accepted_at: now, updated_at: now });
    tx.delete(pendingTransferGuard(db.fs, orgId).ref);
    return orgId;
  });
};

/** `api.cancel_ownership_transfer`: the initiator, or an owner. */
const cancel_ownership_transfer: DbFunction = async (db, args) => {
  await RPC(db);
  const id = arg.req(args, 'p_transfer');
  return runTx(db, async (tx) => {
    const t = await rowByIdAnyOrg(db.fs, 'ownership_transfers', id, readerOf(tx));
    if (!t) raise.notFound();
    const orgId = String(t.organization_id);
    const role = await requireOrg(db, orgId, tx);
    if (t.initiator_user_id !== uidOf(db) && role !== 'owner' && role !== 'super_admin') {
      raise.denied('only the initiator or an owner can cancel');
    }
    if (t.status !== 'pending') raise.conflict('this transfer is no longer pending');
    const now = nowIso();
    const after = { ...t, status: 'cancelled', cancelled_by: uidOf(db), updated_at: now };
    const pieces = [
      await prepareRowAudit(db, 'ownership_transfers', 'update', t, after, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'ownership.transfer_cancelled', targetTable: 'ownership_transfers', targetId: id,
      }, tx),
    ];
    tx.update(orgRow(db.fs, orgId, 'ownership_transfers', id), { status: 'cancelled', cancelled_by: uidOf(db), updated_at: now });
    tx.delete(pendingTransferGuard(db.fs, orgId).ref);
    writeAll(tx, pieces);
    return id;
  });
};

// ── Per-person switches, access requests and departments (ADR-172, ADR-173) ─────────────────────

/** `api.set_member_permission`: one switch (null = back to the role's default). */
const set_member_permission: DbFunction = async (db, args) => {
  await RPC(db);
  // "Reset all" walks every switch of one person; 300 an hour is far above any honest page.
  await throttle(db.fs, uidOf(db), 'member_permission', 300, HOUR);
  const orgId = arg.req(args, 'p_org');
  const userId = arg.str(args, 'p_user');
  return runTx(db, async (tx) => {
    const role = await requirePermission(db, orgId, 'users.manage', tx);
    const change = await prepareMemberPermission(db, tx, {
      orgId, userId, permission: arg.str(args, 'p_permission'), granted: arg.bool(args, 'p_granted'),
      actorRole: role, metadata: { source: 'switch' },
    });
    change.write(tx);
    return userId;
  });
};

/** `api.request_access`: a member asks for more; everyone who manages people is told. */
const request_access: DbFunction = async (db, args) => {
  const actor = uidOf(db);
  await throttle(db.fs, actor, 'rpc', 120, 60);
  const orgId = arg.req(args, 'p_org');
  const role = await requireOrg(db, orgId);
  if (!overridableRole(role)) raise.denied('asking for more access is for company members other than owners');
  const asked = (arg.arr<unknown>(args, 'p_permissions') ?? []);
  const message = (arg.str(args, 'p_message') ?? '').trim() || null;

  if (message !== null && message.length > 1000) raise.invalid('keep the message to 1,000 characters');
  if (asked.length > SWITCHABLE_PERMISSIONS.length * 2 || asked.some((p) => !isSwitchable(p))) {
    raise.invalid('one of those permissions cannot be asked for');
  }
  // Counted after the argument checks: on PostgreSQL a refused request rolled its count back, and
  // the counter here is not part of the transaction, so a malformed request must not spend one.
  await throttle(db.fs, actor, 'access_request', 5, DAY);
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const perms: string[] = [];
    for (const p of sortedSet(asked as string[])) {
      if (!(await hasPermission(db, orgId, p as Permission, tx))) perms.push(p);
    }
    if (perms.length === 0 && message === null) {
      if (asked.length > 0) raise.invalid('you already have the access you asked for');
      raise.invalid('choose what you need, or say what you need in a message');
    }
    const uid = requireUser(db);
    const conflict = 'you already have a request waiting; withdraw it or wait for an answer';
    const claim = await pendingRequestGuard(db.fs, orgId, uid).read(tx);

    const [org, profile, people] = await Promise.all([
      orgOf(db, orgId, r), r.get(globalRow(db.fs, 'profiles', uid)), orgPeople(db.fs, orgId, r),
    ]);
    const who = (String(profile.get('full_name') ?? '').trim() || (profile.get('email') as string | undefined)) || 'A member';
    const body = perms.length === 0
      ? 'They left a message.'
      : `They asked for ${perms.length} permission${perms.length === 1 ? '' : 's'}${message === null ? '.' : ', with a message.'}`;

    const id = newId();
    const now = nowIso();
    const pieces: Array<{ write(tx: Transaction): void }> = [
      await prepareAudit(db, {
        organizationId: orgId, action: 'member.access_requested', targetTable: 'access_requests', targetId: id,
        after: { permissions: perms, has_message: message !== null }, metadata: { role },
      }, tx),
    ];
    for (const person of people) {
      pieces.push(await prepareNotify(db.fs, {
        orgId, userId: person, actorId: uid, permission: 'users.manage' as Permission, kind: 'access_request',
        title: `${who} asked for more access`, body, href: `/app/${String(org.slug)}/settings/team#requests`,
      }, r));
    }
    claim.take(tx, id, conflict);
    tx.set(orgRow(db.fs, orgId, 'access_requests', id), {
      id, organization_id: orgId, requester_id: uid, permissions: perms, message, status: 'pending',
      decided_by: null, decided_at: null, granted: [], note: null, created_at: now, updated_at: now,
    });
    writeAll(tx, pieces);
    return id;
  });
};

const REQUEST_STATUSES = ['pending', 'approved', 'declined', 'withdrawn', 'all'];

/** `api.access_requests_list`: everyone's for a people manager; one's own otherwise. */
const access_requests_list: DbFunction = async (db, args) => {
  const orgId = arg.req(args, 'p_org');
  await requireOrg(db, orgId);
  const status = args.p_status === undefined ? 'pending' : arg.str(args, 'p_status');
  if (!status || !REQUEST_STATUSES.includes(status)) raise.invalid('unknown request status');
  const all = await hasPermission(db, orgId, 'users.manage' as Permission);
  let q = orgCollection(db.fs, orgId, 'access_requests') as FirebaseFirestore.Query;
  if (!all) q = q.where('requester_id', '==', uidOf(db));
  if (status !== 'all') q = q.where('status', '==', status);
  const rows = (await q.get()).docs.map((d) => d.data());
  const ids = rows.map((x) => String(x.requester_id));
  const [profiles, members] = await Promise.all([
    profilesById(db.fs, ids),
    Promise.all([...new Set(ids)].map((u) => membershipOf(db.fs, orgId, u, readerOf()))),
  ]);
  const roleOf = new Map(members.filter((m): m is DocumentData => Boolean(m)).map((m) => [String(m.user_id), String(m.role)]));
  return rows
    .filter((x) => profiles.has(String(x.requester_id)) && roleOf.has(String(x.requester_id)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 200)
    .map((x) => {
      const p = profiles.get(String(x.requester_id))!;
      return {
        id: x.id, requester_id: x.requester_id, requester_name: p.full_name ?? null, requester_email: p.email,
        requester_role: roleOf.get(String(x.requester_id)), permissions: x.permissions ?? [], message: x.message ?? null,
        status: x.status, created_at: x.created_at, decided_by: x.decided_by ?? null, decided_at: x.decided_at ?? null,
        granted: x.granted ?? [], note: x.note ?? null,
      };
    });
};

/** `api.decide_access_request`: approve (some or all of what was asked) or decline, with a note. */
const decide_access_request: DbFunction = async (db, args) => {
  await RPC(db);
  const id = arg.req(args, 'p_id');
  const approve = arg.bool(args, 'p_approve');
  if (approve === null) raise.invalid('choose approve or decline');
  const note = (arg.str(args, 'p_note') ?? '').trim() || null;
  const chosen = arg.arr<unknown>(args, 'p_permissions');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const actor = uidOf(db);
    const req = await rowByIdAnyOrg(db.fs, 'access_requests', id, r);
    if (!req || !(await orgRoleOf(db.fs, actor, String(req.organization_id), r))) raise.notFound();
    const orgId = String(req.organization_id);
    const role = await requirePermission(db, orgId, 'users.manage', tx);
    if (req.status !== 'pending') raise.conflict('that request has already been answered');
    if (req.requester_id === actor) raise.denied('you cannot answer your own request');
    const target = await membershipOf(db.fs, orgId, String(req.requester_id), r);
    if (!target || target.status !== 'active') raise.conflict("that person's access is switched off");
    if (!ceilingAllows(role, String(target.role))) raise.denied(`you cannot act on a ${String(target.role)}`);
    if (note !== null && note.length > 1000) raise.invalid('keep the note to 1,000 characters');

    const asked = (req.permissions as string[] | undefined) ?? [];
    const pieces: Array<{ write(tx: Transaction): void }> = [];
    let grant: string[] = [];
    if (approve) {
      const wanted = chosen ?? asked;
      if (wanted.some((p) => p === null || !asked.includes(String(p)))) {
        raise.invalid('you can only switch on what was asked for');
      }
      grant = sortedSet(wanted.map(String));
      for (const p of grant) {
        pieces.push(await prepareMemberPermission(db, tx, {
          orgId, userId: String(req.requester_id), permission: p, granted: true, actorRole: role,
          metadata: { source: 'access_request', access_request_id: id },
        }) as PreparedSwitch);
      }
    }
    const decided = approve ? 'approved' : 'declined';
    const org = await orgOf(db, orgId, r);
    pieces.push(await prepareAudit(db, {
      organizationId: orgId, action: 'member.access_request_decided', targetTable: 'access_requests', targetId: id,
      before: { status: 'pending', permissions: asked },
      after: { status: decided, granted: grant, has_note: note !== null },
      metadata: { requester_id: req.requester_id },
    }, tx));

    const now = nowIso();
    writeAll(tx, pieces);
    tx.update(orgRow(db.fs, orgId, 'access_requests', id), {
      status: decided, decided_by: actor, decided_at: now, granted: grant, note, updated_at: now,
    });
    tx.delete(pendingRequestGuard(db.fs, orgId, String(req.requester_id)).ref);
    const notification = newId();
    tx.set(orgRow(db.fs, orgId, 'notifications', notification), {
      id: notification, organization_id: orgId, user_id: req.requester_id, kind: 'access_decision',
      title: approve ? 'Your request for more access was approved' : 'Your request for more access was declined',
      body: note ? note.slice(0, 1000) : null, href: `/app/${String(org.slug)}/home`, read_at: null, created_at: now,
    });
    return id;
  });
};

/** `api.withdraw_access_request`: the requester takes their own waiting request back. */
const withdraw_access_request: DbFunction = async (db, args) => {
  await RPC(db);
  const id = arg.req(args, 'p_id');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const actor = uidOf(db);
    const req = await rowByIdAnyOrg(db.fs, 'access_requests', id, r);
    if (!req || req.requester_id !== actor || !(await orgRoleOf(db.fs, actor, String(req.organization_id), r))) {
      raise.notFound();
    }
    const orgId = String(req.organization_id);
    if (req.status !== 'pending') raise.conflict('that request has already been answered');
    const prepared = await prepareAudit(db, {
      organizationId: orgId, action: 'member.access_request_withdrawn', targetTable: 'access_requests', targetId: id,
      before: { status: 'pending' }, after: { status: 'withdrawn' },
    }, tx);
    const now = nowIso();
    tx.update(orgRow(db.fs, orgId, 'access_requests', id), { status: 'withdrawn', decided_by: actor, decided_at: now, updated_at: now });
    tx.delete(pendingRequestGuard(db.fs, orgId, String(actor)).ref);
    prepared.write(tx);
    return id;
  });
};

/** `api.set_member_departments` (ADR-173): what a person sees of the company's systems. */
const set_member_departments: DbFunction = async (db, args) => {
  const actor = uidOf(db);
  await RPC(db);
  const orgId = arg.req(args, 'p_org');
  const userId = arg.str(args, 'p_user');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const role = await requirePermission(db, orgId, 'users.manage', tx);
    const ownerActor = role === 'owner' || role === 'super_admin';
    if (!userId) raise.notFound();
    if (userId === actor) raise.denied('you cannot change your own access');
    const m = await membershipOf(db.fs, orgId, userId, r);
    if (!m) raise.notFound();
    const target = String(m.role);
    if (!overridableRole(target)) raise.denied('an owner sees every department');
    if (!ceilingAllows(role, target)) raise.denied(`you cannot act on a ${target}`);
    if (m.departments_set_by_owner === true && !ownerActor) {
      raise.denied("the owner chose this person's departments; only an owner can change them");
    }
    const departments = await checkDepartments(db, orgId, args.p_departments ?? null, r);
    const before = (m.departments as string[] | null) ?? null;
    if (same(departments, before)) return userId;
    const after = { ...m, departments, departments_set_by_owner: ownerActor, updated_at: nowIso() };
    const pieces = [
      await prepareRowAudit(db, 'organization_memberships', 'update', m, after, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'member.departments_changed', targetTable: 'organization_memberships', targetId: userId,
        before: { departments: before }, after: { departments }, metadata: { role: target, set_by_owner: ownerActor },
      }, tx),
    ];
    tx.update(membershipRef(db.fs, orgId, userId), { departments, departments_set_by_owner: ownerActor, updated_at: after.updated_at });
    writeAll(tx, pieces);
    return userId;
  });
};

// ── Team logins (ADR-173, ADR-174) ───────────────────────────────────────────────────────────────

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CLAIM_SECONDS = 600;

/**
 * `api.begin_member_login`: step one of the owner creating a team member's login — checks the
 * creator's rights and records a claim the server's Auth step and `finish_member_login` redeem.
 */
const begin_member_login: DbFunction = async (db, args) => {
  const actor = uidOf(db);
  await throttle(db.fs, actor, 'rpc', 120, 60);
  await throttle(db.fs, actor, 'member_login', 30, HOUR);
  const orgId = arg.req(args, 'p_org');
  const email = (arg.str(args, 'p_email') ?? '').trim().toLowerCase();
  const loginRole = arg.str(args, 'p_role');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const role = await requirePermission(db, orgId, 'users.invite', tx);
    checkMemberLoginRole(role, loginRole);
    if (!EMAIL.test(email)) raise.invalid('enter a valid email address');
    if (!(await r.query(db.fs.collection('profiles').where('email', '==', email).limit(1))).empty) {
      raise.conflict('that email already has an APX login; use a different email');
    }
    const perms = sortedSet((arg.arr<unknown>(args, 'p_permissions') ?? []).map(String));
    if (!perms.every(isSwitchable)) raise.invalid('one of those permissions cannot be given to one person');
    // Never beyond the creator's own rights (ADR-172); each switch is re-checked when it is applied.
    for (const p of perms) {
      if (!(await hasPermission(db, orgId, p as Permission, tx))) raise.denied('you can only give what you hold yourself');
    }
    const departments = await checkDepartments(db, orgId, args.p_departments ?? null, r);
    const id = newId();
    tx.set(orgRow(db.fs, orgId, 'member_login_claims', id), {
      id, organization_id: orgId, email, role: loginRole, permissions: perms, departments, created_by: actor,
      created_at: nowIso(), used_at: null, used_user_id: null,
    });
    return id;
  });
};

/**
 * `api.finish_member_login`: makes the login just created a member — only a login made after the
 * claim, for the claim's email, that belongs to nobody yet — with exactly the switches ticked.
 */
const finish_member_login: DbFunction = async (db, args) => {
  const actor = uidOf(db);
  await throttle(db.fs, actor, 'rpc', 120, 60);
  const claimId = arg.req(args, 'p_claim');
  const userId = arg.req(args, 'p_user');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    const claim = await rowByIdAnyOrg(db.fs, 'member_login_claims', claimId, r);
    if (!claim || claim.created_by !== actor || claim.used_at
      || new Date(String(claim.created_at)).getTime() < Date.now() - CLAIM_SECONDS * 1000) {
      raise.notFound();
    }
    const orgId = String(claim.organization_id);
    // The creator must STILL hold the right, and the ceiling still cover the role.
    const role = await requirePermission(db, orgId, 'users.invite', tx);
    checkMemberLoginRole(role, String(claim.role));

    const justNow = 'only a login made just now can be added this way';
    const profile = await r.get(globalRow(db.fs, 'profiles', userId));
    if (!profile.exists || String(profile.get('email')).toLowerCase() !== String(claim.email).toLowerCase()
      || String(profile.get('created_at')) < String(claim.created_at)) {
      raise.denied(justNow);
    }
    const anywhere = await r.query(db.fs.collectionGroup('organization_memberships').where('user_id', '==', userId).limit(1));
    if (!anywhere.empty || (await r.get(globalRow(db.fs, 'platform_users', userId))).exists) raise.denied(justNow);

    const loginRole = String(claim.role);
    const departments = (claim.departments as string[] | null) ?? null;
    const membership = newMembership({
      orgId, userId, role: loginRole, invitedBy: actor, departments,
      departmentsSetByOwner: role === 'owner' || role === 'super_admin',
    });
    const ticked = new Set((claim.permissions as string[] | undefined) ?? []);
    const pieces: Array<{ write(tx: Transaction): void }> = [];
    // Exactly what was ticked: every switchable permission whose choice differs from the default.
    for (const p of SWITCHABLE_PERMISSIONS) {
      const want = ticked.has(p);
      if (want === roleDefault(loginRole, p)) continue;
      pieces.push(await prepareMemberPermission(db, tx, {
        orgId, userId, permission: p, granted: want, actorRole: role, metadata: { source: 'create' },
        target: { role: loginRole, status: 'active' },
      }));
    }
    pieces.push(
      await prepareRowAudit(db, 'organization_memberships', 'insert', null, membership, tx),
      await prepareAudit(db, {
        organizationId: orgId, action: 'member.created', targetTable: 'organization_memberships', targetId: userId,
        after: { role: loginRole, departments, permissions: claim.permissions ?? [] }, metadata: { by: 'login_created' },
      }, tx),
    );
    const now = nowIso();
    tx.set(membershipRef(db.fs, orgId, userId), membership);
    writeAll(tx, pieces);
    tx.update(orgRow(db.fs, orgId, 'member_login_claims', claimId), { used_at: now, used_user_id: userId });
    if (!profile.get('last_active_org_id')) tx.update(profile.ref, { last_active_org_id: orgId, updated_at: now });
    return userId;
  });
};

// ── Accounts (super admin) ───────────────────────────────────────────────────────────────────────

/** `api.disable_user` (ADR-038.12 / F-D-14): never leaves an organisation without an owner. */
const disable_user: DbFunction = async (db, args) => {
  await RPC(db);
  const userId = arg.req(args, 'p_user');
  return runTx(db, async (tx) => {
    const r = readerOf(tx);
    await requireSuperAdmin(db, true, tx);
    const owned = (await r.query(db.fs.collectionGroup('organization_memberships').where('user_id', '==', userId)))
      .docs.map((d) => d.data()).filter((m) => m.role === 'owner' && m.status === 'active');
    let orphaned = 0;
    for (const m of owned) {
      const owners = await r.query(orgCollection(db.fs, String(m.organization_id), 'organization_memberships').where('role', '==', 'owner'));
      if (!owners.docs.some((d) => d.get('user_id') !== userId && d.get('status') === 'active')) orphaned += 1;
    }
    if (orphaned > 0) {
      raise.conflict(`this user is the only owner of ${orphaned} organization(s); transfer ownership first`);
    }
    const profile = await r.get(globalRow(db.fs, 'profiles', userId));
    const prepared = await prepareAudit(db, { organizationId: null, action: 'user.disabled', targetTable: 'profiles', targetId: userId }, tx);
    const now = nowIso();
    if (profile.exists) tx.update(profile.ref, { disabled_at: now, updated_at: now });
    prepared.write(tx);
    return userId;
  });
};

/** `api.enable_user`. */
const enable_user: DbFunction = async (db, args) => {
  await RPC(db);
  const userId = arg.req(args, 'p_user');
  return runTx(db, async (tx) => {
    await requireSuperAdmin(db, true, tx);
    const profile = await tx.get(globalRow(db.fs, 'profiles', userId));
    const prepared: PreparedAudit = await prepareAudit(db, { organizationId: null, action: 'user.enabled', targetTable: 'profiles', targetId: userId }, tx);
    if (profile.exists) tx.update(profile.ref, { disabled_at: null, updated_at: nowIso() });
    prepared.write(tx);
    return userId;
  });
};

export const functions: DbFunctions = {
  accept_invitation, accept_ownership_transfer, access_requests_list, begin_member_login, cancel_deletion,
  cancel_ownership_transfer, change_member_role, create_organization, decide_access_request, disable_user,
  enable_user, finish_member_login, initiate_ownership_transfer, invite_member, invite_member_with_token,
  leave_organization, my_access, my_context, my_organizations, my_platform_role, my_previous_sign_in, my_profile, org_advisers,
  org_audit_events, org_invitations, org_member_departments, org_member_permissions, org_members, remove_member,
  request_access, request_deletion, revoke_invitation, set_last_active_org, set_member_departments,
  set_member_permission, set_member_status, set_tax_settings, set_vat_registration, set_currency_and_country,
  update_organization, update_profile, withdraw_access_request,
};
