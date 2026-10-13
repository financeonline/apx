import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import { EMPTY_PROFILE } from '../domain/profile';
import { MARKETING_REPORT_VERSION, type CompanyProfile, type MarketingReport, type SocialLink } from '../domain/types';

/**
 * Reads for Marketing (ADR-170). Two callers, one set of queries: a page reads with the person's own
 * client under RLS; the `marketing.generate` job reads with its scoped service client. Every query
 * names the organisation either way. Nothing here writes — `api.set_company_profile`,
 * `api.request_marketing_report` and the job's `api_server.*` functions do.
 */

interface ProfileRow {
  website: string | null;
  social_links: unknown;
  products_services: string | null;
  description: string | null;
}

/** The stored links, defensively: anything that is not a {label, url} pair is not a link. */
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

export interface MarketingSubject {
  readonly name: string;
  /** `organizations.base_currency` — the currency the figures are kept in. */
  readonly currency: string;
  readonly timeZone: string;
  readonly profile: CompanyProfile;
}

/**
 * The organisation as a report is written about it: its name, currency and time zone, and its
 * profile — whose industry is `organizations.industry` (one industry per company). Null when the
 * organisation is not readable.
 */
export async function loadMarketingSubject(db: SupabaseClient, orgId: string, requestId?: string): Promise<MarketingSubject | null> {
  const [{ data: org, error: orgError }, { data: profile, error: profileError }] = await Promise.all([
    db.from('organizations').select('name, base_currency, timezone, industry').eq('id', orgId).maybeSingle(),
    db.from('organization_profiles').select('website, social_links, products_services, description')
      .eq('organization_id', orgId).maybeSingle(),
  ]);
  if (orgError) throw toMotionError(orgError, requestId);
  if (profileError) throw toMotionError(profileError, requestId);
  if (org === null) return null;
  const o = org as { name: string; base_currency: string; timezone: string; industry: string | null };
  return {
    name: o.name,
    currency: o.base_currency.trim(),
    timeZone: o.timezone,
    profile: profileOf(profile as ProfileRow | null, o.industry),
  };
}

export type AttemptStatus = 'queued' | 'running' | 'ready' | 'failed';

export interface MarketingAttempt {
  readonly id: string;
  readonly status: AttemptStatus;
  readonly failure: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** The newest attempt at the report, whatever became of it. */
export async function loadLatestAttempt(db: SupabaseClient, orgId: string, requestId?: string): Promise<MarketingAttempt | null> {
  const { data, error } = await db.from('marketing_reports')
    .select('id, status, failure, created_at, finished_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(1).maybeSingle();
  if (error) throw toMotionError(error, requestId);
  if (data === null) return null;
  const r = data as { id: string; status: AttemptStatus; failure: string | null; created_at: string; finished_at: string | null };
  return { id: r.id, status: r.status, failure: r.failure, createdAt: r.created_at, finishedAt: r.finished_at };
}

/**
 * The newest READY report, as it was stored. A stored document of another version is not one this
 * build can render, and is passed over rather than shown half-read.
 */
export async function loadLatestReadyReport(db: SupabaseClient, orgId: string, requestId?: string): Promise<{ readonly id: string; readonly report: MarketingReport } | null> {
  const { data, error } = await db.from('marketing_reports')
    .select('id, report')
    .eq('organization_id', orgId).eq('status', 'ready').eq('report_version', MARKETING_REPORT_VERSION)
    .order('finished_at', { ascending: false }).order('id', { ascending: false })
    .limit(1).maybeSingle();
  if (error) throw toMotionError(error, requestId);
  if (data === null) return null;
  const r = data as { id: string; report: MarketingReport | null };
  return r.report === null ? null : { id: r.id, report: r.report };
}

/** The attempt queued or running for the organisation, if any — at most one (a unique index). */
export async function findInFlightReport(db: SupabaseClient, orgId: string): Promise<string | null> {
  const { data, error } = await db.from('marketing_reports').select('id')
    .eq('organization_id', orgId).in('status', ['queued', 'running'])
    .limit(1).maybeSingle();
  if (error) throw toMotionError(error);
  return (data as { id: string } | null)?.id ?? null;
}
