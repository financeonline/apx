import type { CompanyProfile, SocialLink } from './types';

/**
 * The company profile as the analyst types it, checked before it reaches `api.set_company_profile`
 * (ADR-170). Pure.
 *
 * The database is the rule (http(s) only, the same limits, at most twelve links) and holds for a direct
 * RPC caller too; this module exists so the form can say what is wrong field by field, and so a bare
 * domain ("bearabeara.co.uk") is accepted the way people write one — with `https://` added — rather
 * than refused.
 */

export const PROFILE_LIMITS = {
  website: 500,
  linkLabel: 60,
  linkUrl: 500,
  links: 12,
  productsServices: 2000,
  /** `organizations.industry` — the same limit `UpdateOrganizationPatch` has always applied. */
  industry: 120,
  description: 4000,
} as const;

export interface ProfileIssue {
  /** The field as the form names it ("Social link 2"): the form lists issues as "path: message". */
  readonly path: string;
  readonly message: string;
}

export type ProfileParse =
  | { readonly ok: true; readonly profile: CompanyProfile }
  | { readonly ok: false; readonly issues: readonly ProfileIssue[] };

/** What the form posts: every field as text, and the social links as parallel lists of rows. */
export interface CompanyProfileForm {
  readonly website?: string | null;
  readonly socialLinks?: ReadonlyArray<{ readonly label?: string | null; readonly url?: string | null }>;
  readonly productsServices?: string | null;
  readonly industry?: string | null;
  readonly description?: string | null;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** A host as people type one: "example.co.uk", "www.example.com/shop", "instagram.com/brand". */
const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]\S*)?$/i;

/**
 * An http(s) address, or null when the text is not one. A bare domain gains `https://`; any other
 * scheme (mailto:, javascript:) is refused. The text is otherwise kept as typed — the URL parser's own
 * rewriting (a trailing slash, lower-cased host) is not stored.
 */
export function normaliseUrl(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (text.length === 0 || /\s/.test(text)) return null;
  const candidate = SCHEME.test(text) ? text : BARE_HOST.test(text) ? `https://${text}` : null;
  if (candidate === null) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname.length === 0) return null;
    return candidate;
  } catch {
    return null;
  }
}

/** The name a social link is shown under when the analyst gave none: the network, or the host. */
const NETWORKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)instagram\.com$/i, 'Instagram'],
  [/(^|\.)linkedin\.com$/i, 'LinkedIn'],
  [/(^|\.)tiktok\.com$/i, 'TikTok'],
  [/(^|\.)facebook\.com$/i, 'Facebook'],
  [/(^|\.)(x|twitter)\.com$/i, 'X'],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i, 'YouTube'],
  [/(^|\.)pinterest\.[a-z.]+$/i, 'Pinterest'],
  [/(^|\.)threads\.net$/i, 'Threads'],
];

export function labelForUrl(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return 'Link';
  }
  for (const [pattern, label] of NETWORKS) if (pattern.test(host)) return label;
  return host.replace(/^www\./i, '').slice(0, PROFILE_LIMITS.linkLabel);
}

const blankToNull = (value: string | null | undefined): string | null => {
  const text = (value ?? '').trim();
  return text.length > 0 ? text : null;
};

/** Checks and normalises the form. Rows left entirely blank are dropped; half a row is an issue. */
export function parseCompanyProfile(input: CompanyProfileForm): ProfileParse {
  const issues: ProfileIssue[] = [];

  let website: string | null = null;
  const websiteText = blankToNull(input.website);
  if (websiteText !== null) {
    website = normaliseUrl(websiteText);
    if (website === null) issues.push({ path: 'Website', message: 'Enter the website as a web address, for example https://example.co.uk.' });
    else if (website.length > PROFILE_LIMITS.website) issues.push({ path: 'Website', message: `Keep the website to ${PROFILE_LIMITS.website} characters.` });
  }

  const socialLinks: SocialLink[] = [];
  const rows = (input.socialLinks ?? []).filter((r) => blankToNull(r.label) !== null || blankToNull(r.url) !== null);
  if (rows.length > PROFILE_LIMITS.links) {
    issues.push({ path: 'Social links', message: `Add at most ${PROFILE_LIMITS.links} social links.` });
  }
  rows.slice(0, PROFILE_LIMITS.links).forEach((row, index) => {
    const path = `Social link ${index + 1}`;
    const label = blankToNull(row.label);
    const urlText = blankToNull(row.url);
    if (urlText === null) {
      issues.push({ path, message: `Add the address for ${label ?? 'this link'}.` });
      return;
    }
    const url = normaliseUrl(urlText);
    if (url === null) {
      issues.push({ path, message: `Enter ${label ?? 'the link'} as a web address, for example https://instagram.com/yourbrand.` });
      return;
    }
    if (url.length > PROFILE_LIMITS.linkUrl) {
      issues.push({ path, message: `Keep each address to ${PROFILE_LIMITS.linkUrl} characters.` });
      return;
    }
    if (label !== null && label.length > PROFILE_LIMITS.linkLabel) {
      issues.push({ path, message: `Keep each link's name to ${PROFILE_LIMITS.linkLabel} characters.` });
      return;
    }
    socialLinks.push({ label: label ?? labelForUrl(url), url });
  });

  const productsServices = blankToNull(input.productsServices);
  if (productsServices !== null && productsServices.length > PROFILE_LIMITS.productsServices) {
    issues.push({ path: 'Products and services', message: `Keep products and services to ${PROFILE_LIMITS.productsServices.toLocaleString('en-GB')} characters.` });
  }
  const industry = blankToNull(input.industry);
  if (industry !== null && industry.length > PROFILE_LIMITS.industry) {
    issues.push({ path: 'Industry', message: `Keep the industry to ${PROFILE_LIMITS.industry} characters.` });
  }
  const description = blankToNull(input.description);
  if (description !== null && description.length > PROFILE_LIMITS.description) {
    issues.push({ path: 'Description', message: `Keep the description to ${PROFILE_LIMITS.description.toLocaleString('en-GB')} characters.` });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, profile: { website, socialLinks, productsServices, industry, description } };
}

/** The profile of a company nobody has described yet. */
export const EMPTY_PROFILE: CompanyProfile = {
  website: null, socialLinks: [], productsServices: null, industry: null, description: null,
};
