import { labelForUrl, normaliseUrl } from './profile';
import {
  MARKETING_REPORT_VERSION,
  type CompanyProfile, type Competitor, type MarketingFinancials, type MarketingNarrative, type MarketingReport, type SocialLink,
} from './types';

/**
 * Putting the stored report together (ADR-170). Pure: the job hands in what it read and what the model
 * wrote, and this decides the cover date and the sources — nothing here reads, writes or calls a model.
 */

/** "October 2026" — the month the report was written, in the company's own time zone (for the cover). */
export function reportDateLabel(now: Date, timeZone: string): string {
  const format = (zone: string) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: zone }).format(now);
  try {
    return format(timeZone);
  } catch {
    // A zone the runtime does not know (the database validates zones; this is belt and braces).
    return format('UTC');
  }
}

/**
 * The same page written two ways is one source: the scheme, a leading `www.`, a trailing slash and the
 * host's case do not make a different address.
 */
function sourceKey(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * The report's sources, in the order the example document lists them: the company's website, its
 * social pages, each competitor's website and social page, and — when Section 03 has figures — where
 * the figures came from. A competitor link the model gave that is not a web address is left out
 * rather than printed as a link. Duplicates go; the first label wins.
 *
 * The figures' source is a sentence, not a page, so it is the one entry whose `url` is empty: a
 * renderer prints its label without a link.
 */
export function buildSources(input: {
  readonly organisationName: string;
  readonly profile: CompanyProfile;
  readonly competitors: readonly Competitor[];
  readonly financials: MarketingFinancials | null;
}): SocialLink[] {
  const out: SocialLink[] = [];
  const seen = new Set<string>();
  const add = (label: string, raw: string | null | undefined) => {
    const url = normaliseUrl(raw);
    if (url === null) return;
    const key = sourceKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, url });
  };

  const name = input.organisationName;
  add(`${name} website`, input.profile.website);
  for (const link of input.profile.socialLinks) add(`${name} on ${link.label}`, link.url);
  for (const c of input.competitors) {
    add(`${c.name} website`, c.website);
    const social = normaliseUrl(c.social);
    if (social !== null) add(`${c.name} on ${labelForUrl(social)}`, social);
  }

  const note = input.financials?.sourceNote.trim();
  if (note) out.push({ label: note, url: '' });
  return out;
}

export interface AssembleInput {
  readonly organisationName: string;
  readonly timeZone: string;
  readonly profile: CompanyProfile;
  readonly narrative: MarketingNarrative;
  readonly financials: MarketingFinancials | null;
  readonly model: string;
  readonly promptVersion: string;
  readonly now: Date;
}

/** The report exactly as it is stored and rendered. */
export function assembleMarketingReport(input: AssembleInput): MarketingReport {
  return {
    version: MARKETING_REPORT_VERSION,
    organisationName: input.organisationName,
    generatedAt: input.now.toISOString(),
    reportDate: reportDateLabel(input.now, input.timeZone),
    profile: input.profile,
    narrative: input.narrative,
    financials: input.financials,
    sources: buildSources({
      organisationName: input.organisationName,
      profile: input.profile,
      competitors: input.narrative.competitors.competitors,
      financials: input.financials,
    }),
    model: input.model,
    promptVersion: input.promptVersion,
  };
}
