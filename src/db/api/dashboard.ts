import 'server-only';
import type { DocumentData } from 'firebase-admin/firestore';
import { Decimal } from '@/core/money/decimal';
import { arg, type DbFunctions } from '../registry';
import { raise } from '../raise';
import { globalCollection, globalRow, newId, nowIso, orgRow } from '../schema';
import { runTx } from '../tx';
import { uidOf, type Db } from '../types';
import { requireOrg, requirePermission, requireSuperAdmin } from '../app/access';
import { prepareAudit } from '../app/audit';
import { charLength, rpcThrottle } from '../app/financials-helpers';
import { throttle } from '../app/throttle';
import { orgRowById } from '../rls';

/**
 * `api.*` functions of the department dashboard (docs/DEPARTMENT_DASHBOARD_PLAN.md, owner
 * 2026-11-01): the company's monthly targets and the "Give feedback" note that goes to APX staff.
 *
 * These are new functions, not ports, but they keep the ported functions' contract: `p_` arguments,
 * snake_case rows back, the caller re-checked with `requireOrg` / `requirePermission`, every check a
 * SQL table would have made as a CHECK constraint made here (the service validates first, for
 * friendlier messages, but this file is the authority), and every write audited in its transaction.
 */

// ── Monthly targets ──────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM`, 2020-01 to 2100-12 (the prototype's month picker range). */
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

function monthArg(args: Record<string, unknown>): string {
  const month = arg.req(args, 'p_month');
  const m = MONTH.exec(month);
  const year = m ? Number(m[1]) : 0;
  if (!m || year < 2020 || year > 2100) raise.invalid('a target month is YYYY-MM, from 2020-01 to 2100-12');
  return month;
}

/** A decimal string or a finite number, read exactly; null when it is not a plain decimal. */
function decimalOf(value: unknown): Decimal | null {
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  return new Decimal(text);
}

interface StoredTargets {
  readonly workflow: number;
  readonly sales: string;
  readonly marketing: string;
  readonly cost_ratio: string;
  readonly marketing_ratio: string;
}

/** The targets dialog's CHECKs: the prototype's input bounds, money to the penny, ratios to 0.1. */
function targetsArg(args: Record<string, unknown>): StoredTargets {
  const t = arg.obj(args, 'p_targets');

  const workflow = typeof t.workflow === 'number' ? t.workflow : decimalOf(t.workflow)?.toNumber() ?? NaN;
  if (!Number.isInteger(workflow) || workflow < 1 || workflow > 1_000_000) {
    raise.invalid('the workflow target is a whole number of completed tasks from 1 to 1,000,000');
  }

  const money = (value: unknown, label: string, min: 'positive' | 'zero'): string => {
    const d = decimalOf(value);
    if (d === null || d.decimalPlaces() > 2) raise.invalid(`the ${label} target is an amount to at most two decimal places`);
    if (min === 'positive' ? d.lte(0) : d.lt(0)) {
      raise.invalid(`the ${label} target must be ${min === 'positive' ? 'more than' : 'at least'} 0`);
    }
    if (d.gt(100_000_000)) raise.invalid(`the ${label} target is at most 100,000,000`);
    return d.toFixed(2);
  };

  const ratio = (value: unknown, label: string): string => {
    const d = decimalOf(value);
    if (d === null || d.decimalPlaces() > 1) raise.invalid(`the ${label} ceiling is a percentage to one decimal place`);
    if (d.lt(0) || d.gt(1000)) raise.invalid(`the ${label} ceiling is from 0% to 1000%`);
    return d.toFixed(1);
  };

  return {
    workflow,
    sales: money(t.sales, 'sales', 'positive'),
    marketing: money(t.marketing, 'marketing spend', 'zero'),
    cost_ratio: ratio(t.costRatio ?? t.cost_ratio, 'cost / revenue'),
    marketing_ratio: ratio(t.marketingRatio ?? t.marketing_ratio, 'marketing / revenue'),
  };
}

/** The stored row as the functions return it (the document, with `null` for a missing field). */
function targetsRow(d: DocumentData): Record<string, unknown> {
  return {
    id: d.id, organization_id: d.organization_id, month: d.month,
    workflow: d.workflow, sales: d.sales, marketing: d.marketing,
    cost_ratio: d.cost_ratio, marketing_ratio: d.marketing_ratio,
    revision: d.revision, updated_by: d.updated_by ?? null, updated_at: d.updated_at ?? null, created_at: d.created_at ?? null,
  };
}

/**
 * `api.get_monthly_targets(p_org, p_month)` → the month's row, or null when none was saved.
 * The read goes through the table's read policy (`monthly_targets`: `dashboard.view`).
 */
async function get_monthly_targets(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  await rpcThrottle(db);
  const org = arg.req(args, 'p_org');
  const month = monthArg(args);
  await requireOrg(db, org);
  await requirePermission(db, org, 'dashboard.view');
  const row = await orgRowById(db, org, 'monthly_targets', month);
  return row ? targetsRow(row) : null;
}

/**
 * `api.set_monthly_targets(p_org, p_month, p_targets, p_expected_revision)` → the saved row.
 *
 * Optimistic concurrency, as the prototype's `expectedRevision`: the caller sends the revision it
 * last read (0 for a month with no saved targets); a different stored revision is CONFLICT, so a save
 * from a stale dialog never silently overwrites another session's. Each save adds one to the revision.
 *
 * Who may save: `financials.view` (the targets are judged against the company's figures) AND
 * `financials.edit` — owner, admin, super admin, the APX Financial Analyst and the company's
 * accountant (owner, 2026-11-01: analysts and accountants set targets too); never a client or a
 * third party.
 */
async function set_monthly_targets(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  await rpcThrottle(db);
  const org = arg.req(args, 'p_org');
  const month = monthArg(args);
  const targets = targetsArg(args);
  const expected = arg.num(args, 'p_expected_revision');
  if (expected === null || !Number.isInteger(expected) || expected < 0) {
    raise.invalid('the expected revision is a whole number (0 when no targets were saved for the month)');
  }
  const actor = uidOf(db);

  return runTx(db, async (tx) => {
    await requireOrg(db, org, tx);
    await requirePermission(db, org, 'financials.view', tx);
    await requirePermission(db, org, 'financials.edit', tx);
    const ref = orgRow(db.fs, org, 'monthly_targets', month);
    const snap = await tx.get(ref);
    const before = snap.exists ? snap.data()! : null;
    const current = before ? Number(before.revision) : 0;
    if (expected !== current) {
      raise.conflict('These targets were changed in another session. Reload them and review the latest settings before saving.', {
        month, revision: current,
      });
    }

    const now = nowIso();
    const row = {
      id: month, organization_id: org, month,
      ...targets,
      revision: current + 1,
      updated_by: actor,
      updated_at: now,
      created_at: (before?.created_at as string | undefined) ?? now,
    };
    const audit = await prepareAudit(db, {
      organizationId: org, action: 'targets.set', targetTable: 'monthly_targets', targetId: month,
      before: before ? { ...pickTargets(before), revision: current } : null,
      after: { ...targets, revision: row.revision },
    }, tx);
    tx.set(ref, row);
    audit.write(tx);
    return targetsRow(row);
  });
}

function pickTargets(d: DocumentData): StoredTargets {
  return {
    workflow: d.workflow, sales: d.sales, marketing: d.marketing,
    cost_ratio: d.cost_ratio, marketing_ratio: d.marketing_ratio,
  };
}

// ── Dashboard feedback ───────────────────────────────────────────────────────────────────────────

/**
 * The prototype's 17 feedback sections (its `#feedback-section` select). `src/modules/feedback`
 * holds the same keys with their labels; a unit test keeps the two lists equal.
 */
export const FEEDBACK_SECTIONS = [
  'branding', 'departments', 'metrics', 'performance', 'composition', 'perspective', 'priorities',
  'workspace', 'report-summary', 'growth', 'clients', 'industry', 'systems', 'apax', 'targets',
  'marketing', 'templates',
] as const;

/** The dashboard's five departments (`?dept=`). */
export const FEEDBACK_DEPARTMENTS = ['analysis', 'banking', 'capture', 'workflow', 'clients'] as const;

const NOTES_MAX = 4000;
const CONTEXT_KEYS = ['period', 'view', 'months', 'scenario'] as const;
const CONTEXT_VALUE_MAX = 200;

/** `{period?, view?, months?, scenario?}` — short strings describing what was on screen. */
function contextArg(args: Record<string, unknown>): Record<string, string> {
  const raw = args.p_context;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) raise.invalid('the feedback context is an object of short strings');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(CONTEXT_KEYS as readonly string[]).includes(key)) raise.invalid(`${key} is not part of the feedback context`);
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' || charLength(value) > CONTEXT_VALUE_MAX) {
      raise.invalid(`the feedback context's ${key} is text of at most ${CONTEXT_VALUE_MAX} characters`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * `api.submit_dashboard_feedback(p_org, p_section, p_department, p_notes, p_context)` → `{id,
 * created_at, status}`. Any member who sees the dashboard (`dashboard.view`) may send a note; it is
 * stored platform-wide (`dashboard_feedback`) for APX staff, never shown to the company's other
 * members. Twenty notes an hour per person, on the shared counter.
 */
async function submit_dashboard_feedback(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  await rpcThrottle(db, 60);
  const org = arg.req(args, 'p_org');
  const section = arg.str(args, 'p_section');
  if (!section || !(FEEDBACK_SECTIONS as readonly string[]).includes(section)) raise.invalid('choose the section the feedback is about');
  const department = arg.str(args, 'p_department');
  if (department !== null && !(FEEDBACK_DEPARTMENTS as readonly string[]).includes(department)) {
    raise.invalid(`${department} is not a department of the dashboard`);
  }
  const notes = (arg.str(args, 'p_notes') ?? '').trim();
  if (notes.length === 0) raise.invalid('describe the change you would like');
  if (charLength(notes) > NOTES_MAX) raise.invalid(`keep the note under ${NOTES_MAX} characters`);
  const context = contextArg(args);

  await requireOrg(db, org);
  await requirePermission(db, org, 'dashboard.view');
  const author = uidOf(db);
  if (!author) raise.denied('sign in required');
  await throttle(db.fs, author, 'dashboard_feedback', 20, 3600);

  return runTx(db, async (tx) => {
    const id = newId();
    const now = nowIso();
    const audit = await prepareAudit(db, {
      organizationId: org, action: 'dashboard.feedback_submitted', targetTable: 'dashboard_feedback', targetId: id,
      // The note itself stays in its own row: the audit log records that it was sent, and where.
      after: { section, department },
    }, tx);
    tx.set(globalRow(db.fs, 'dashboard_feedback', id), {
      id, organization_id: org, author_user_id: author, section, department, notes, context,
      status: 'new', read_at: null, read_by: null, created_at: now,
    });
    audit.write(tx);
    return { id, created_at: now, status: 'new' };
  });
}

/**
 * `api.platform_dashboard_feedback(p_limit)` → the latest notes, newest first, with the company's
 * name and the author's email resolved here (`profiles` is own-row-only). The super admin only — the
 * Platform area's reader; a read shown on every visit, so no fresh sign-in is asked for.
 */
async function platform_dashboard_feedback(db: Db, args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  await rpcThrottle(db);
  await requireSuperAdmin(db);
  const limit = Math.max(Math.min(arg.num(args, 'p_limit') ?? 200, 500), 1);

  const snap = await globalCollection(db.fs, 'dashboard_feedback').orderBy('created_at', 'desc').limit(limit).get();
  const rows = snap.docs.map((d) => d.data());

  const orgIds = [...new Set(rows.map((r) => r.organization_id).filter((v): v is string => typeof v === 'string' && v !== ''))];
  const authorIds = [...new Set(rows.map((r) => r.author_user_id).filter((v): v is string => typeof v === 'string' && v !== ''))];
  const [orgs, people] = await Promise.all([
    orgIds.length ? db.fs.getAll(...orgIds.map((id) => globalRow(db.fs, 'organizations', id))) : [],
    authorIds.length ? db.fs.getAll(...authorIds.map((id) => globalRow(db.fs, 'profiles', id))) : [],
  ]);
  const orgName = new Map(orgs.filter((s) => s.exists).map((s) => [s.id, s.get('name') as string]));
  const person = new Map(people.filter((s) => s.exists).map((s) => [s.id, s.data()!]));

  return rows.map((r) => {
    const p = typeof r.author_user_id === 'string' ? person.get(r.author_user_id) : undefined;
    return {
      id: r.id,
      organization_id: r.organization_id ?? null,
      organization_name: typeof r.organization_id === 'string' ? (orgName.get(r.organization_id) ?? null) : null,
      author_user_id: r.author_user_id ?? null,
      author_email: (p?.email as string | null | undefined) ?? null,
      author_name: (p?.full_name as string | null | undefined) ?? null,
      section: r.section, department: r.department ?? null, notes: r.notes,
      context: r.context ?? {}, status: r.status, created_at: r.created_at,
    };
  });
}

export const functions: DbFunctions = {
  get_monthly_targets,
  set_monthly_targets,
  submit_dashboard_feedback,
  platform_dashboard_feedback,
};
