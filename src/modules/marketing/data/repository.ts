import 'server-only';
import { ORG_SINGLETON_ID } from '@/db/schema';
import type { Db } from '@/db/types';
import { readOrganizationRow, readRowById, readRows } from '@/db/app/financials-reads';
import { EMPTY_PROFILE } from '../domain/profile';
import { MARKETING_REPORT_VERSION, type CompanyProfile, type MarketingReport, type SocialLink } from '../domain/types';

/**
 * Reads for Marketing (ADR-170). Two callers, one set of reads: a page reads as the person, under the
 * tables' policies (`src/db/rls.ts`); the `marketing.generate` job reads with its scoped service
 * handle. Every read names the organisation either way (`readRows`). Nothing here writes — `api.set_company_profile`,
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
export async function loadMarketingSubject(db: Db, orgId: string, requestId?: string): Promise<MarketingSubject | null> {
  void requestId;
  const [org, profile] = await Promise.all([
    readOrganizationRow(db, orgId),
    readRowById<ProfileRow>(db, orgId, 'organization_profiles', ORG_SINGLETON_ID),
  ]);
  if (org === null) return null;
  const o = org as { name: string; base_currency?: string | null; timezone: string; industry?: string | null };
  return {
    name: o.name,
    currency: String(o.base_currency ?? 'GBP').trim(),
    timeZone: o.timezone,
    profile: profileOf(profile, o.industry ?? null),
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
export async function loadLatestAttempt(db: Db, orgId: string, requestId?: string): Promise<MarketingAttempt | null> {
  void requestId;
  // Composite index: marketing_reports (created_at DESC, id DESC).
  const rows = await readRows<{ id: string; status: AttemptStatus; failure: string | null; created_at: string; finished_at: string | null }>(
    db, orgId, 'marketing_reports', (q) => q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1));
  const r = rows[0];
  if (r === undefined) return null;
  return { id: r.id, status: r.status, failure: r.failure ?? null, createdAt: r.created_at, finishedAt: r.finished_at ?? null };
}

/**
 * The newest READY report, as it was stored. A stored document of another version is not one this
 * build can render, and is passed over rather than shown half-read.
 */
export async function loadLatestReadyReport(db: Db, orgId: string, requestId?: string): Promise<{ readonly id: string; readonly report: MarketingReport } | null> {
  void requestId;
  // Composite index: marketing_reports (status, report_version, finished_at DESC, id DESC).
  const rows = await readRows<{ id: string; report: MarketingReport | null }>(db, orgId, 'marketing_reports', (q) => q
    .where('status', '==', 'ready').where('report_version', '==', MARKETING_REPORT_VERSION)
    .orderBy('finished_at', 'desc').orderBy('id', 'desc').limit(1));
  const r = rows[0];
  if (r === undefined) return null;
  return r.report === null || r.report === undefined ? null : { id: r.id, report: r.report };
}

/** The attempt queued or running for the organisation, if any — at most one (a unique index). */
export async function findInFlightReport(db: Db, orgId: string): Promise<string | null> {
  const rows = await readRows<{ id: string }>(db, orgId, 'marketing_reports', (q) => q
    .where('status', 'in', ['queued', 'running']).limit(1));
  return rows[0]?.id ?? null;
}
