import Link from 'next/link';
import { can } from '@/core/permissions';
import { notFound } from 'next/navigation';
import { isMotionError } from '@/core/errors';
import {
  FUNDING_DISCLAIMER, NOT_SCORED_LABEL, READINESS_BANDS, getFundingView, ruleDescription, type FactorResult,
  type RuleResult,
} from '@/modules/funding';
import { BASIS_TEXT } from '@/modules/financials';
import { formatDateTime } from '@/components/labels';
import { getAccessContext } from '@/modules/tenancy';
import {
  ChevronRight, CircleHelp, Gauge, Lightbulb, ListChecks, ThumbsUp, TriangleAlert,
} from 'lucide-react';
import { Badge, Banner, Card, CardBody, EmptyState, IconBadge, PageHeader } from '@/components/ui/surfaces';
import { TOUCH_TARGET } from '@/components/ui/clickable-card';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Funding Readiness (PHASE_16_IMPLEMENTATION.md §11; ADR-145). The page order is the design's: the
 * disclaimer first, then the score or "Not enough data to score yet", coverage, the seven factor cards, what helps,
 * what hurts, what is missing, what to do, the evidence, and which rules and run produced it. Flag off
 * is NOT FOUND for every role (U-5). Nothing here is written by AI (D-15).
 */

/** The few band words that read as jargon, said plainly. */
const BAND_TEXT: Readonly<Record<string, string>> = {
  full: 'the whole month',
  partial: 'part of the month',
  reconciled: 'all match',
  unreconciled: 'one does not match',
};

/** ">= 15%" reads "at least 15%"; a stored code ("no_debt") reads as words; a basis reads as its source. */
function bandText(r: RuleResult): string | null {
  if (r.band === null) return null;
  if (r.rule === 'F7.2' && BASIS_TEXT[r.band]) return BASIS_TEXT[r.band]!.toLowerCase();
  if (BAND_TEXT[r.band]) return BAND_TEXT[r.band]!;
  return r.band.replace(/^>= /, 'at least ').replace(/^<= /, 'at most ').replace(/^> /, 'above ').replace(/_/g, ' ');
}

function FactorCard({ factor }: { factor: FactorResult }) {
  return (
    <Card className="h-full">
      <CardBody>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-serif text-lg text-ink">{factor.name}</h3>
          <span className="rounded-xl bg-accent-soft px-2.5 py-0.5 font-mono text-xl tabular-nums text-accent">
            {factor.score === null ? '—' : factor.score}
            {factor.score === null ? null : <span className="sr-only"> out of 100</span>}
          </span>
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          {factor.status === 'scored' ? `Counts for ${factor.appliedWeight}% of the overall score` : 'Not scored, so left out of the overall score'}
          {factor.key === 'F7' ? '. It checks the quality of your data: it counts towards the score, but not towards whether there is one.' : '.'}
        </p>
        {factor.capped || factor.capReason ? <p className="mt-1 text-xs text-ink-muted">Capped at 70: {factor.capReason}.</p> : null}
        {factor.status === 'missing' ? (
          <p className="mt-2 text-sm text-ink-muted">{factor.missing[0]?.text ?? 'Not available.'}</p>
        ) : (
          <details className="mt-2 text-sm">
            <summary className={`cursor-pointer text-ink-muted underline underline-offset-2 ${TOUCH_TARGET}`}>How this was scored</summary>
            <p className="mt-2 text-xs text-ink-muted">Each area starts from a middle score; each check below adds points or takes them off.</p>
            <ul className="mt-2 flex flex-col gap-1">
              {factor.rules.map((r) => {
                const band = bandText(r);
                return (
                  <li key={r.rule} className="flex justify-between gap-2 [overflow-wrap:anywhere]">
                    <span className="text-ink-muted">
                      {ruleDescription(r.rule)}{band === null ? '' : `: ${band}`}{r.unavailable === null ? '' : ' — not available'}
                      <span className="ml-1 text-xs text-ink-faint">({r.rule})</span>
                    </span>
                    <span className="whitespace-nowrap text-ink">
                      {r.unavailable === null ? (r.points > 0 ? `+${r.points}` : String(r.points)) : '—'}
                      {r.unavailable === null ? <span className="sr-only"> points</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </CardBody>
    </Card>
  );
}

export default async function FundingPage({
  params, searchParams,
}: { params: Promise<{ orgSlug: string }>; searchParams: Promise<{ period?: string }> }) {
  const { orgSlug } = await params;
  const { period } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'reports.view');

  let view;
  try {
    view = await getFundingView(ctx, period);
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const a = view.assessment;
  return (
    <>
      <PageHeader
        eyebrow="Indicative assessment"
        title="Funding Readiness"
        description="A guide, scored from 0 to 100 from your own records, to how your figures might look if you asked for a loan or other funding — with what helps, what holds it back and what to improve."
      />
      <Banner tone="info" title="Not a lending decision">{FUNDING_DISCLAIMER}</Banner>

      {view.state === 'preparing' ? (
        <div className="mt-8"><EmptyState title="Preparing your assessment">Funding Readiness was just switched on. Each complete month is being assessed; this page fills in shortly.</EmptyState></div>
      ) : view.state === 'no_eligible_period' || a === null ? (
        <div className="mt-8"><EmptyState title="No complete month yet">An assessment is made for each finished month with figures. Once a month is complete, it appears here.</EmptyState></div>
      ) : (
        <>
          {view.months.length > 1 ? (
            <nav aria-label="Months" className="mt-6 flex flex-wrap gap-2 text-sm">
              {view.months.map((m) => (
                <Link key={m.periodId} href={`/app/${orgSlug}/funding?period=${m.periodId}`} aria-current={m.periodId === a.periodId ? 'page' : undefined}
                  className={`inline-flex items-center ${TOUCH_TARGET} ${m.periodId === a.periodId
                    ? 'rounded-full bg-accent-soft px-3 py-1 font-medium text-accent'
                    : 'rounded-full px-3 py-1 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent'}`}>{m.label}</Link>
              ))}
            </nav>
          ) : null}

          <Card className="mt-6"><CardBody className="flex min-w-0 items-start gap-4">
            <IconBadge tint="violet" size="lg"><Gauge /></IconBadge>
            <div className="min-w-0">
            <p className="text-sm text-ink-muted">{a.periodLabel}</p>
            {a.status === 'scored' ? (
              <p className="mt-1 flex flex-wrap items-baseline gap-3">
                <span className="font-serif text-4xl text-ink">{a.score}</span>
                <span className="text-sm text-ink-muted">out of 100</span>
                <Badge tone="accent">{a.band}</Badge>
              </p>
            ) : (
              <p className="mt-1 font-serif text-2xl text-ink">{NOT_SCORED_LABEL}</p>
            )}
            <p className="mt-2 text-sm text-ink-muted">
              {a.factorsUsed} of 7 areas could be scored, using {a.dataCoveragePercent}% of the information the assessment looks for.
              {a.status === 'insufficient_data' ? ' A score needs sales and profit, cash flow, and at least three of the other four main areas.' : ''}
            </p>
            {a.status === 'scored' ? (
              <p className="mt-1 text-xs text-ink-muted">
                How to read it: {READINESS_BANDS.map((b, i) => {
                  const word = b.label.replace(' indicative readiness', '').toLowerCase();
                  return b.min === 0 ? `below ${READINESS_BANDS[i - 1]?.min ?? 0} ${word}` : `${b.min}+ ${word}`;
                }).join(' · ')}.
              </p>
            ) : null}
            </div>
          </CardBody></Card>

          <section aria-labelledby="factors" className="mt-6">
            <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="pink" size="sm"><ListChecks /></IconBadge>
              <h2 id="factors" className="min-w-0 font-serif text-lg text-ink">The seven areas</h2>
            </div>
            <p className="mt-2 text-sm text-ink-muted">Each area is scored out of 100 and counts for part of the overall score.</p>
            <ul className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {a.factors.map((f) => <li key={f.key}><FactorCard factor={f} /></li>)}
            </ul>
          </section>

          {[['What helps', a.factors.flatMap((f) => f.positives)], ['What holds it back', a.factors.flatMap((f) => f.negatives)]].map(([title, list]) => (
            <Card key={title as string} className="mt-6"><CardBody>
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint={title === 'What helps' ? 'violet' : 'pink'} size="sm">
                  {title === 'What helps' ? <ThumbsUp /> : <TriangleAlert />}
                </IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">{title as string}</h2>
              </div>
              {(list as FactorResult['positives']).length === 0 ? <p className="mt-2 text-sm text-ink-muted">{title === 'What helps' ? 'Nothing stands out yet.' : 'Nothing is holding it back.'}</p> : (
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
                  {(list as FactorResult['positives']).map((s) => <li key={`${s.rule}:${s.text}`}>{s.text}</li>)}
                </ul>
              )}
            </CardBody></Card>
          ))}

          <Card className="mt-6"><CardBody>
            <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="violet" size="sm"><CircleHelp /></IconBadge>
              <h2 className="min-w-0 font-serif text-lg text-ink">Missing information</h2>
            </div>
            {a.factors.flatMap((f) => f.missing).length === 0 ? <p className="mt-2 text-sm text-ink-muted">Nothing is missing.</p> : (
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
                {a.factors.flatMap((f) => f.missing.map((m) => <li key={`${f.key}:${m.rule ?? ''}:${m.reason}:${m.text}`}>{f.name}: {m.text}</li>))}
              </ul>
            )}
          </CardBody></Card>

          <Card className="mt-6"><CardBody>
            <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="pink" size="sm"><Lightbulb /></IconBadge>
              <h2 className="min-w-0 font-serif text-lg text-ink">What would improve readiness</h2>
            </div>
            {a.actions.length === 0 ? <p className="mt-2 text-sm text-ink-muted">Nothing to suggest.</p> : (
              <ol className="mt-2 flex flex-col gap-2 text-sm">
                {a.actions.map((x) => (
                  <li key={`${x.factor}:${x.rule ?? x.reason}`} className="flex flex-wrap justify-between gap-2">
                    <span className="text-ink">{x.text}</span>
                    <Badge tone={x.priority === 'high' ? 'warn' : 'neutral'}>{x.priority === 'high' ? 'High' : x.priority === 'medium' ? 'Medium' : 'Low'} priority</Badge>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-3 text-xs text-ink-faint">These are suggestions from fixed rules; nothing is added to the Action Centre automatically.</p>
          </CardBody></Card>

          <p className="mt-6 text-sm">
            {/* The evidence page is detail (`financials.view`); a 3rd party reads the assessment without it (ADR-172). */}
            {a.evidenceBundleId === null || !can(ctx, 'financials.view') ? null : (
              <Link href={`/app/${orgSlug}/evidence/${a.evidenceBundleId}`} className={`inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft ${TOUCH_TARGET}`}>See the figures behind this assessment<ChevronRight aria-hidden="true" className="size-4" /></Link>
            )}
          </p>
          <p className="mt-2 text-xs text-ink-muted">Assessed {formatDateTime(a.createdAt)} (UTC).</p>
          {/* Which rules and run produced it (§11) — kept for anyone checking, folded away for everyone else. */}
          <details className="mt-1 text-xs text-ink-faint">
            <summary className="cursor-pointer underline underline-offset-2">Technical details</summary>
            <p className="mt-1">Rules {a.rulesVersion} · engine {a.engineVersion} · calculation {a.calculationRunId.slice(0, 8)}.</p>
          </details>
        </>
      )}
    </>
  );
}
