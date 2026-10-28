import 'server-only';
import { ORG_SINGLETON_ID } from '@/db/schema';
import type { Db } from '@/db/types';
import { readOrganization, readRowById, readRows } from '@/db/app/caller-reads';
import { EMPTY_PROFILE, type CompanyProfile, type SocialLink } from '@/modules/marketing';
import { INVESTMENT_REPORT_VERSION, type InvestmentReport } from '../domain/types';

/**
 * Reads for Investment (ADR-171), Marketing's in shape (ADR-170). Two callers, one set of queries: a
 * page reads with the person's own client under RLS; the `investment.generate` job reads with its
 * scoped service client (`modules/reporting/data/read.ts` reads for either). Every query names the
 * organisation either way. Nothing here writes —
 * `api.request_investment_report` and the job's `api_server.*` functions do.
 *
 * The company's FIGURES are not read here: `loadInvestmentBase` (services/figures.ts) works out the
 * base year from them.
 */

interface ProfileRow {
  website: string | null;
  social_links: unknown;
  products_services: string | null;
  description: string | null;
}

/**
 * The stored links, defensively: anything that is not a {label, url} pair is not a link. The same
 * reading Marketing's repository makes of the same column — the profile is one table, read the same
 * way by both departments.
 */
function linksOf(value: unknown): SocialLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object') return [];
    const { label, url } = item as { label?: unknown; url?: unknown };
    return typeof label === 'string' && typeof url === 'string' ? [{ label, url }] : [];
  });
}

function profileOf(row: ProfileRow | null, industry: string | null): CompanyProfile {
  if (row === null) return { ...EMPTY_PROFILE, industry };
  return {
    website: row.website,
    socialLinks: linksOf(row.social_links),
    productsServices: row.products_services,
    industry,
    description: row.description,
  };
}

export interface InvestmentSubject {
  readonly name: string;
  /** `organizations.slug`. */
  readonly slug: string;
  /** `organizations.base_currency` — the currency the figures, and so the pack, are in. */
  readonly currency: string;
  /** `organizations.country_code` (ISO 3166-1 alpha-2): the writer suggests the country's regulators. */
  readonly countryCode: string;
  readonly timeZone: string;
  /** The company profile (`organization_profiles`); its industry is `organizations.industry`. */
  readonly profile: CompanyProfile;
}

/**
 * The organisation as a pack is written about it: its name, slug, currency, country and time zone,
 * and its profile. Null when the organisation is not readable.
 */
export async function loadInvestmentSubject(db: Db, orgId: string, _requestId?: string): Promise<InvestmentSubject | null> {
  const [org, profile] = await Promise.all([
    readOrganization(db, orgId),
    // One profile per organisation: the singleton document (FIRESTORE_DATA_MODEL.md §3).
    readRowById<ProfileRow>(db, orgId, 'organization_profiles', ORG_SINGLETON_ID),
  ]);
  if (org === null) return null;
  const o = org as unknown as {
    name: string; slug: string; base_currency: string; country_code: string; timezone: string; industry: string | null;
  };
  return {
    name: o.name,
    slug: String(o.slug),
    currency: o.base_currency.trim(),
    countryCode: o.country_code.trim().toUpperCase(),
    timeZone: o.timezone,
    profile: profileOf(profile, o.industry),
  };
}

export type AttemptStatus = 'queued' | 'running' | 'ready' | 'failed';

export interface InvestmentAttempt {
  readonly id: string;
  readonly status: AttemptStatus;
  readonly failure: string | null;
  /** The amount the analyst entered for this attempt (a decimal string), or null for the base year's net profit. */
  readonly surplus: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** `assumptions.surplus` as stored: a decimal string (the table's check), else not given. */
function surplusOf(assumptions: unknown): string | null {
  if (assumptions === null || typeof assumptions !== 'object' || Array.isArray(assumptions)) return null;
  const surplus = (assumptions as { surplus?: unknown }).surplus;
  return typeof surplus === 'string' && surplus.length > 0 ? surplus : null;
}

interface AttemptRow {
  id: string;
  status: AttemptStatus;
  failure: string | null;
  assumptions: unknown;
  created_at: string;
  finished_at: string | null;
}

function attemptOf(r: AttemptRow): InvestmentAttempt {
  return {
    id: r.id, status: r.status, failure: r.failure, surplus: surplusOf(r.assumptions),
    createdAt: r.created_at, finishedAt: r.finished_at,
  };
}

/** `order by <field> desc, id desc`, done in TypeScript so no composite index is needed. */
const newest = (field: 'created_at' | 'finished_at') => (
  a: { id: string; created_at?: string | null; finished_at?: string | null },
  b: { id: string; created_at?: string | null; finished_at?: string | null },
): number => {
  const x = String(a[field] ?? ''); const y = String(b[field] ?? '');
  if (x !== y) return x < y ? 1 : -1;
  return String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0;
};

/** The newest attempt at the pack, whatever became of it. */
export async function loadLatestAttempt(db: Db, orgId: string, _requestId?: string): Promise<InvestmentAttempt | null> {
  const [latest] = await readRows<{ id: string; created_at: string }>(db, orgId, 'investment_reports', (q) => q
    .orderBy('created_at', 'desc').limit(1).select('id', 'created_at'));
  if (latest === undefined) return null;
  // Every attempt made in that same instant, so the id breaks the tie as the SQL order did.
  const tied = (await readRows<AttemptRow>(db, orgId, 'investment_reports', (q) => q
    .where('created_at', '==', latest.created_at))).sort(newest('created_at'));
  return tied[0] === undefined ? null : attemptOf(tied[0]);
}

/** One attempt by its id — the job reads the assumptions it was asked to build the pack on. */
export async function loadAttempt(db: Db, orgId: string, reportId: string, _requestId?: string): Promise<InvestmentAttempt | null> {
  const row = await readRowById<AttemptRow>(db, orgId, 'investment_reports', reportId);
  return row === null ? null : attemptOf(row);
}

/**
 * The newest READY pack, as it was stored. A stored document of another version is not one this build
 * can render, and is passed over rather than shown half-read.
 */
export async function loadLatestReadyReport(db: Db, orgId: string, _requestId?: string): Promise<{ readonly id: string; readonly report: InvestmentReport } | null> {
  // Equality filters in Firestore (no composite index) without the documents themselves, the
  // newest chosen here; then that one pack read whole.
  const ready = (await readRows<{ id: string; finished_at: string | null }>(db, orgId, 'investment_reports', (q) => q
    .where('status', '==', 'ready').where('report_version', '==', INVESTMENT_REPORT_VERSION)
    .select('id', 'finished_at')))
    .sort(newest('finished_at'));
  if (ready[0] === undefined) return null;
  const r = await readRowById<{ id: string; report: InvestmentReport | null }>(db, orgId, 'investment_reports', ready[0].id);
  if (r === null) return null;
  return r.report === null ? null : { id: r.id, report: r.report };
}

/** The attempt queued or running for the organisation, if any — at most one (a unique index). */
export async function findInFlightReport(db: Db, orgId: string): Promise<string | null> {
  const rows = await readRows<{ id: string }>(db, orgId, 'investment_reports', (q) => q
    .where('status', 'in', ['queued', 'running']).limit(1).select('id'));
  return rows[0]?.id ?? null;
}
