import 'server-only';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { raise } from '../raise';
import { globalCollection, globalRow, newId, nowIso, orgRow, uniqueGuard } from '../schema';
import type { Db } from '../types';
import { prepareAudit } from './audit';
import { prepareRowAudit } from './platform-row-audit';
import { fiscalPosition, periodId, slugify, writeStandardChart } from './shared';

/**
 * Creating an organisation — the part `api.create_organization` (a person signing up) and
 * `api.platform_create_organization` (the super admin, for a customer) share, so the two cannot
 * drift (TENANCY_MODEL.md §2; ADR-004 chart; ADR-044.5).
 *
 * Both SQL functions did the same five things in one transaction, and so does `prepareNewOrganization`:
 *
 *   1. pick a free slug — `app.slugify(name)`, padded to three characters with `-org`, then
 *      `-1`, `-2`, … on a collision (the old `while exists (… where slug = v_slug)` loop), held by
 *      the global `organizations_slug_key` guard;
 *   2. insert the `organizations` row with the table's defaults (the `organizations_timezone_valid`
 *      trigger's check included);
 *   3. seed the standard chart (`app.seed_standard_chart`);
 *   4. create twelve months back and twelve forward of fiscal periods (`app.ensure_periods`);
 *   5. audit `org.created`, after the `audit_diff` trigger's `db.organizations.insert`.
 *
 * What differs stays with each caller: the signing-up path adds the owner's membership and
 * `last_active_org_id`; the platform path invites the owner afterwards.
 *
 * The organisation does not exist when the reads run (Firestore wants every read before the first
 * write), so the audit events are prepared as the bootstrap flow, and the periods are written by
 * `writeNewOrgPeriods` — `preparePeriods` would read an organisation that is not there yet.
 */

export interface NewOrganizationInput {
  readonly name: string;
  readonly countryCode: string | null;
  readonly baseCurrency: string;
  readonly fiscalYearStartMonth: number;
  readonly timezone: string;
  readonly createdBy: string | null;
  /** Extra keys for the `org.created` event's `after` (the platform path adds `by: 'platform'`). */
  readonly auditExtra?: Record<string, unknown>;
}

export interface PreparedOrganization {
  readonly orgId: string;
  readonly slug: string;
  readonly row: Record<string, unknown>;
  write(tx: Transaction): void;
}

/** The `organizations_timezone_valid` trigger (`app.validate_timezone`). */
export function validateTimezone(timezone: string): void {
  let known = false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    known = timezone.length > 0;
  } catch {
    known = false;
  }
  if (!known) {
    raise.invalid(`${timezone} is not a timezone APX recognises (for example Europe/London)`);
  }
}

/** Is this slug taken? The guard, and — for rows written without one — the column itself. */
async function slugTaken(fs: Firestore, tx: Transaction, slug: string): Promise<boolean> {
  const claim = await uniqueGuard(fs, 'global', 'organizations_slug_key', [slug]).read(tx);
  if (claim.owner) return true;
  const rows = await tx.get(globalCollection(fs, 'organizations').where('slug', '==', slug).limit(1));
  return !rows.empty;
}

/** Steps 1–5 above: reads now, `write(tx)` later. */
export async function prepareNewOrganization(
  db: Db, tx: Transaction, input: NewOrganizationInput,
): Promise<PreparedOrganization> {
  const fs = db.fs;
  const name = input.name.trim();
  if (name.length > 200) raise.invalid('a name is at most 200 characters');
  validateTimezone(input.timezone);

  let base = slugify(name);
  if (base.length < 3) base = `${base}-org`;
  let slug = base;
  for (let n = 1; await slugTaken(fs, tx, slug); n += 1) {
    slug = `${base.slice(0, 34)}-${n}`;
  }

  const orgId = newId();
  const now = nowIso();
  const row: Record<string, unknown> = {
    id: orgId, slug, name, legal_name: null, country_code: input.countryCode,
    base_currency: input.baseCurrency, fiscal_year_start_month: input.fiscalYearStartMonth,
    industry: null, kind: 'customer', status: 'active', plan: 'trial', features: {}, settings: {},
    timezone: input.timezone, deletion_requested_at: null, created_by: input.createdBy,
    deleted_at: null, created_at: now, updated_at: now,
  };
  const slugClaim = await uniqueGuard(fs, 'global', 'organizations_slug_key', [slug]).read(tx);
  const inserted = await prepareRowAudit(db, 'organizations', 'insert', null, row, tx, { bootstrap: true });
  const created = await prepareAudit(db, {
    organizationId: orgId, action: 'org.created', targetTable: 'organizations', targetId: orgId,
    after: { slug, name, ...(input.auditExtra ?? {}) }, bootstrap: true,
  }, tx);

  const { from, to } = periodWindow();
  return {
    orgId,
    slug,
    row,
    write(t) {
      t.set(globalRow(fs, 'organizations', orgId), row);
      slugClaim.take(t, orgId, 'that organization already exists');
      inserted.write(t);
      writeStandardChart(t, fs, orgId);
      writeNewOrgPeriods(t, fs, orgId, input.fiscalYearStartMonth, from, to);
      created.write(t);
    },
  };
}

/** Twelve months back and eleven forward of this month (both SQL callers' `ensure_periods` window). */
export function periodWindow(at: Date = new Date()): { from: string; to: string } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(new Date(Date.UTC(y, m - 12, 1))), to: iso(new Date(Date.UTC(y, m + 11, 1))) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `app.ensure_periods` for an organisation created in this same transaction: every month from
 * `from` to `to` (first days, `YYYY-MM-01`), write-only. The rows are the ones `preparePeriods`
 * writes, with the same deterministic ids.
 */
export function writeNewOrgPeriods(
  tx: Transaction, fs: Firestore, orgId: string, fyMonth: number, from: string, to: string,
): number {
  const now = nowIso();
  let count = 0;
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endKey = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7));
  while (y * 12 + m <= endKey) {
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const pos = fiscalPosition(start, fyMonth);
    const id = periodId(orgId, start);
    tx.set(orgRow(fs, orgId, 'fiscal_periods', id), {
      id, organization_id: orgId, period_start: start,
      period_end: `${start.slice(0, 7)}-${String(last).padStart(2, '0')}`,
      fiscal_year: pos.fiscal_year, fiscal_quarter: pos.fiscal_quarter,
      label: `${MONTHS[m - 1]} ${y}`, is_complete: false, is_locked: false, created_at: now, updated_at: now,
    });
    count += 1;
    if (m === 12) { y += 1; m = 1; } else { m += 1; }
  }
  return count;
}
