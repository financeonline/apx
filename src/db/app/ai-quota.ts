import 'server-only';
import { AggregateField, type Firestore } from 'firebase-admin/firestore';
import { globalRow, orgCollection, orgRow, ORG_SINGLETON_ID } from '../schema';
import { readerOf, type Reader } from '../types';

/**
 * The AI allowance an organisation has, and what it has used — `app.effective_quota` and
 * `app.ai_tokens_used_this_month` (AI_ARCHITECTURE.md §2 step 4; ADR-076, ADR-079, ADR-170, ADR-171).
 *
 * Shared by every area that charges the analyst allowance: the analyst turn and its status
 * (`api_server.ai_persist_turn`, `api.ai_quota_status`), document reading
 * (`api_server.charge_extraction_page`), and the Marketing and Investment reports
 * (`api.request_marketing_report`, `api.request_investment_report`). One definition, so the notice a
 * page shows and the refusal a write raises can never disagree.
 *
 * These are server reads (the SQL helpers were SECURITY DEFINER): they count rows the caller may not
 * be able to read, because an allowance is the organisation's, not the person's.
 */

export type QuotaKey = 'ai_quota_daily' | 'ai_token_ceiling_monthly' | 'ai_extraction_pages_per_day';

/**
 * The platform defaults the PostgreSQL migration seeded into `platform_settings` "so the keys exist
 * from day one" (20260905000004). Firestore has no migration to seed them, so a missing setting
 * document falls back to the same value; a document whose value is null still means "no limit", as
 * a NULL setting did.
 */
export const PLATFORM_QUOTA_DEFAULTS: Readonly<Record<QuotaKey, number>> = {
  ai_quota_daily: 100,
  ai_token_ceiling_monthly: 20_000_000,
  ai_extraction_pages_per_day: 300,
};

/** A stored count as a number: settings were jsonb, so a value may arrive as `100` or `"100"`. */
function asCount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * `app.effective_quota(org, key)`: the organisation's own override (`platform_org_settings`), else
 * the platform setting, else null — no limit.
 */
export async function effectiveQuota(fs: Firestore, orgId: string, key: QuotaKey, r: Reader = readerOf()): Promise<number | null> {
  const [own, platform] = await Promise.all([
    r.get(orgRow(fs, orgId, 'platform_org_settings', ORG_SINGLETON_ID)),
    r.get(globalRow(fs, 'platform_settings', key)),
  ]);
  const override = own.exists ? asCount(own.get(key)) : null;
  if (override !== null) return override;
  if (!platform.exists) return PLATFORM_QUOTA_DEFAULTS[key];
  return asCount(platform.get('value'));
}

/** The first instant of the current UTC day and month, as stored timestamps compare (ISO strings). */
export function utcDayStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export function utcMonthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** The next UTC midnight — when the daily count returns to zero. */
export function utcNextDayStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

/** User turns since UTC midnight — what `ai_quota_daily` counts. */
export async function userTurnsToday(fs: Firestore, orgId: string, now = new Date()): Promise<number> {
  const snap = await orgCollection(fs, orgId, 'ai_messages')
    .where('role', '==', 'user')
    .where('created_at', '>=', utcDayStart(now))
    .count()
    .get();
  return snap.data().count;
}

/**
 * `app.ai_tokens_used_this_month(org)`: every AI token the organisation spent since the first of the
 * UTC month — analyst turns, document reading, and every attempt at the Marketing report and the
 * Investment Pack (ready or failed) in the month it finished.
 */
export async function aiTokensUsedThisMonth(fs: Firestore, orgId: string, now = new Date()): Promise<number> {
  const since = utcMonthStart(now);
  const [messages, batches, marketing, investment] = await Promise.all([
    orgCollection(fs, orgId, 'ai_messages').where('created_at', '>=', since)
      .aggregate({ tokensIn: AggregateField.sum('input_tokens'), tokensOut: AggregateField.sum('output_tokens') })
      .get(),
    orgCollection(fs, orgId, 'import_batches').where('updated_at', '>=', since).select('extraction_stats').get(),
    orgCollection(fs, orgId, 'marketing_reports').where('finished_at', '>=', since).select('input_tokens', 'output_tokens').get(),
    orgCollection(fs, orgId, 'investment_reports').where('finished_at', '>=', since).select('input_tokens', 'output_tokens').get(),
  ]);
  const m = messages.data();
  let total = (asCount(m.tokensIn) ?? 0) + (asCount(m.tokensOut) ?? 0);
  for (const b of batches.docs) {
    const stats = (b.get('extraction_stats') as Record<string, unknown> | null | undefined) ?? {};
    total += (asCount(stats.tokens_in) ?? 0) + (asCount(stats.tokens_out) ?? 0);
  }
  for (const r of [...marketing.docs, ...investment.docs]) {
    total += (asCount(r.get('input_tokens')) ?? 0) + (asCount(r.get('output_tokens')) ?? 0);
  }
  return total;
}
