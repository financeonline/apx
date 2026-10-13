import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { EMPTY_PROFILE, type CompanyProfile, type SocialLink } from '@/modules/marketing';
import { INVESTMENT_REPORT_VERSION, type InvestmentReport } from '../domain/types';

/**
 * Reads for Investment (ADR-171), Marketing's in shape (ADR-170). Two callers, one set of queries: a
 * page reads with the person's own client under RLS; the `investment.generate` job reads with its
 * scoped service client. Every query names the organisation either way. Nothing here writes —
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
export async function loadInvestmentSubject(db: SupabaseClient, orgId: string, requestId?: string): Promise<InvestmentSubject | null> {
  const [{ data: org, error: orgError }, { data: profile, error: profileError }] = await Promise.all([
    db.from('organizations').select('name, slug, base_currency, country_code, timezone, industry').eq('id', orgId).maybeSingle(),
    db.from('organization_profiles').select('website, social_links, products_services, description')
      .eq('organization_id', orgId).maybeSingle(),
  ]);
  if (orgError) throw toMotionError(orgError, requestId);
  if (profileError) throw toMotionError(profileError, requestId);
  if (org === null) return null;
  const o = org as {
    name: string; slug: string; base_currency: string; country_code: string; timezone: string; industry: string | null;
  };
  return {
    name: o.name,
    slug: String(o.slug),
    currency: o.base_currency.trim(),
    countryCode: o.country_code.trim().toUpperCase(),
    timeZone: o.timezone,
    profile: profileOf(profile as ProfileRow | null, o.industry),
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

const ATTEMPT_COLUMNS = 'id, status, failure, assumptions, created_at, finished_at';

/** The newest attempt at the pack, whatever became of it. */
export async function loadLatestAttempt(db: SupabaseClient, orgId: string, requestId?: string): Promise<InvestmentAttempt | null> {
  const { data, error } = await db.from('investment_reports')
    .select(ATTEMPT_COLUMNS)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(1).maybeSingle();
  if (error) throw toMotionError(error, requestId);
  return data === null ? null : attemptOf(data as AttemptRow);
}

/** One attempt by its id — the job reads the assumptions it was asked to build the pack on. */
export async function loadAttempt(db: SupabaseClient, orgId: string, reportId: string, requestId?: string): Promise<InvestmentAttempt | null> {
  const { data, error } = await db.from('investment_reports')
    .select(ATTEMPT_COLUMNS)
    .eq('organization_id', orgId).eq('id', reportId)
    .maybeSingle();
  if (error) throw toMotionError(error, requestId);
  return data === null ? null : attemptOf(data as AttemptRow);
}

/**
 * The newest READY pack, as it was stored. A stored document of another version is not one this build
 * can render, and is passed over rather than shown half-read.
 */
export async function loadLatestReadyReport(db: SupabaseClient, orgId: string, requestId?: string): Promise<{ readonly id: string; readonly report: InvestmentReport } | null> {
  const { data, error } = await db.from('investment_reports')
    .select('id, report')
    .eq('organization_id', orgId).eq('status', 'ready').eq('report_version', INVESTMENT_REPORT_VERSION)
    .order('finished_at', { ascending: false }).order('id', { ascending: false })
    .limit(1).maybeSingle();
  if (error) throw toMotionError(error, requestId);
  if (data === null) return null;
  const r = data as { id: string; report: InvestmentReport | null };
  return r.report === null ? null : { id: r.id, report: r.report };
}

/** The attempt queued or running for the organisation, if any — at most one (a unique index). */
export async function findInFlightReport(db: SupabaseClient, orgId: string): Promise<string | null> {
  const { data, error } = await db.from('investment_reports').select('id')
    .eq('organization_id', orgId).in('status', ['queued', 'running'])
    .limit(1).maybeSingle();
  if (error) throw toMotionError(error);
  return (data as { id: string } | null)?.id ?? null;
}
