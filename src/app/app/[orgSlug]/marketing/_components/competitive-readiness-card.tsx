import { ChevronRight, Swords } from 'lucide-react';
import type { MarketingSummary } from '@/modules/marketing';
import { IconTile, StatusDot } from '@/components/dashboard/department-card';
import { CLICKABLE_CARD, CardLink } from '@/components/ui/clickable-card';

/**
 * Competitive Readiness on the Departments page (ADR-170): the first three comparators of the
 * marketing report's Section 01, name and positioning, and a way into the report. The department
 * card's own layout (ADR-155) with a list in place of its one-paragraph figures, because three names
 * run together in a sentence read as one. The comparators are the model's and are labelled as such:
 * directional, not verified. With no report it says where they will come from, not a placeholder.
 * The whole card opens the report's Section 01, as every clickable card does (`ui/clickable-card`).
 */
export function CompetitiveReadinessCard({ href, summary }: { href: string; summary: MarketingSummary }) {
  const title = 'Competitive Readiness';
  const status = summary.competitors.length > 0
    ? { tone: 'quiet' as const, label: 'Directional, not verified' }
    : { tone: summary.tone, label: summary.label };
  return (
    <section
      aria-label={title}
      className={`panel ${CLICKABLE_CARD} flex h-full flex-col rounded-card p-4`}
    >
      <div className="flex gap-3.5">
        <IconTile tint="pink" size="md"><Swords /></IconTile>
        <div className="min-w-0 flex-1">
          <h3 className="text-base text-ink">{title}</h3>
          <p className="text-xs text-ink-muted">
            Comparable competitors<span aria-hidden="true" className="mx-1">•</span>
            {summary.asOf === null ? 'From the marketing report' : `From the report of ${summary.asOf}`}
          </p>
          {summary.competitors.length === 0 ? (
            <p className="mt-1.5 text-sm text-ink-muted">The comparators appear here once the marketing report is ready.</p>
          ) : (
            <ol className="mt-2 flex flex-col gap-1 text-sm">
              {summary.competitors.map((c, i) => (
                <li key={c.name} className="flex min-w-0 gap-2">
                  <span aria-hidden="true" className="tabular text-pink-icon">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{c.name}</span>
                    {c.positioning === '' ? null : <span className="text-ink-muted"> — {c.positioning}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-3">
        <StatusDot status={status.tone} label={status.label} />
        <CardLink
          href={href}
          aria-label={`Open ${title}`}
          className="ml-auto inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors group-hover:border-accent group-hover:bg-accent-soft"
        >
          Open <ChevronRight aria-hidden="true" className="size-4" />
        </CardLink>
      </div>
    </section>
  );
}
