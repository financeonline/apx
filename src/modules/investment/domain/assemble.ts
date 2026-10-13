import { normaliseUrl, reportDateLabel, type CompanyProfile, type SocialLink } from '@/modules/marketing';
import { allocatePortfolio } from './figures';
import {
  INVESTMENT_REPORT_VERSION,
  type InvestmentFigures, type InvestmentNarrative, type InvestmentReport,
} from './types';

/**
 * Putting the stored Investment Pack together (ADR-171), as Marketing's report is put together
 * (ADR-170). Pure: the job hands in what it read, what APX worked out and what ChatGPT wrote, and this
 * decides the cover date, the portfolio's amounts and the sources — nothing here reads, writes or
 * calls a model. The cover date is Marketing's own helper (`reportDateLabel`), so the two departments'
 * covers can never disagree about which month it is.
 */

/**
 * The same page written two ways is one source: the scheme, a leading `www.`, a trailing slash and the
 * host's case do not make a different address. (Marketing draws the same line for its own sources.)
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
 * The pack's sources, in the order the client's example lists its "Reference links": the regulators,
 * protection schemes and providers' public pages the writer cited, then each option's own reference
 * page (the example repeats every option's link in the list), then the company's website, and last
 * where the figures came from. A link the model gave that is not a web address is left out rather
 * than printed as a link. Duplicates go; the first label wins.
 *
 * The figures' source is a sentence, not a page, so it is the one entry whose `url` is empty: a
 * renderer prints its label without a link.
 */
export function buildInvestmentSources(input: {
  readonly organisationName: string;
  readonly profile: CompanyProfile;
  readonly narrative: Pick<InvestmentNarrative, 'references' | 'options'>;
  readonly sourceNote: string | null;
}): SocialLink[] {
  const out: SocialLink[] = [];
  const seen = new Set<string>();
  const add = (label: string, raw: string | null | undefined) => {
    const url = normaliseUrl(raw);
    if (url === null) return;
    const key = sourceKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label: label.trim() || url, url });
  };

  for (const ref of input.narrative.references) add(ref.label, ref.url);
  for (const option of input.narrative.options) add(option.name, option.referenceUrl);
  add(`${input.organisationName} website`, input.profile.website);

  const note = input.sourceNote?.trim();
  if (note) out.push({ label: note, url: '' });
  return out;
}

export interface AssembleInvestmentInput {
  readonly organisationName: string;
  readonly timeZone: string;
  readonly profile: CompanyProfile;
  readonly figures: InvestmentFigures;
  readonly narrative: InvestmentNarrative;
  readonly model: string;
  readonly promptVersion: string;
  readonly now: Date;
}

/**
 * The pack exactly as it is stored and rendered. The portfolio's amounts are APX's: the writer's
 * asset classes and shares applied to the external allocation (`allocatePortfolio`), never a figure
 * the model gave.
 */
export function assembleInvestmentReport(input: AssembleInvestmentInput): InvestmentReport {
  return {
    version: INVESTMENT_REPORT_VERSION,
    organisationName: input.organisationName,
    generatedAt: input.now.toISOString(),
    reportDate: reportDateLabel(input.now, input.timeZone),
    profile: input.profile,
    figures: input.figures,
    narrative: input.narrative,
    portfolio: allocatePortfolio(input.figures.allocation.external.amount, input.narrative.portfolio),
    sources: buildInvestmentSources({
      organisationName: input.organisationName,
      profile: input.profile,
      narrative: input.narrative,
      sourceNote: input.figures.base.sourceNote,
    }),
    model: input.model,
    promptVersion: input.promptVersion,
  };
}
