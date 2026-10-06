import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isMotionError } from '@/core/errors';
import { FUNDING_DISCLAIMER, getFundingView, type FactorResult } from '@/modules/funding';
import { getAccessContext } from '@/modules/tenancy';
import { Badge, Banner, Card, CardBody, EmptyState, PageHeader } from '@/components/ui/surfaces';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Funding Readiness (PHASE_16_IMPLEMENTATION.md §11; ADR-145). The page order is the design's: the
 * disclaimer first, then the score or "Insufficient data", coverage, the seven factor cards, what helps,
 * what hurts, what is missing, what to do, the evidence, and which rules and run produced it. Flag off
 * is NOT FOUND for every role (U-5). Nothing here is written by AI (D-15).
 */

function FactorCard({ factor }: { factor: FactorResult }) {
  return (
    <Card className="h-full">
      <CardBody>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-serif text-lg text-ink">{factor.name}</h3>
          <span className="font-serif text-xl text-ink">{factor.score === null ? '—' : factor.score}</span>
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          Weight {factor.weight}{factor.status === 'scored' ? ` · applied ${factor.appliedWeight}` : ' · not scored'}
          {factor.key === 'F7' ? ' · diagnostic, not counted towards whether there is a score' : ''}
        </p>
        {factor.capped || factor.capReason ? <p className="mt-1 text-xs text-ink-muted">At most 70: {factor.capReason}.</p> : null}
        {factor.status === 'missing' ? (
          <p className="mt-2 text-sm text-ink-muted">{factor.missing[0]?.text ?? 'Not available.'}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {factor.rules.map((r) => (
              <li key={r.rule} className="flex justify-between gap-2">
                <span className="text-ink-muted">{r.rule}{r.band === null ? '' : ` · ${r.band}`}{r.unavailable === null ? '' : ' · not available'}</span>
                <span className="text-ink">{r.unavailable === null ? (r.points > 0 ? `+${r.points}` : String(r.points)) : '—'}</span>
              </li>
            ))}
          </ul>
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
      <PageHeader eyebrow="Indicative assessment" title="Funding Readiness" />
      <Banner tone="info" title="Not a lending decision">{FUNDING_DISCLAIMER}</Banner>

      {view.state === 'preparing' ? (
        <div className="mt-8"><EmptyState title="Preparing your assessment">Funding Readiness was just switched on. Each complete month is being assessed; this page fills in shortly.</EmptyState></div>
      ) : view.state === 'no_eligible_period' || a === null ? (
        <div className="mt-8"><EmptyState title="No complete month yet">An assessment is made for each finished month with figures. Once a month is complete, it appears here.</EmptyState></div>
      ) : (
        <>
          {view.months.length > 1 ? (
            <nav aria-label="Months" className="mt-6 flex flex-wrap gap-3 text-sm">
              {view.months.map((m) => (
                <Link key={m.periodId} href={`/app/${orgSlug}/funding?period=${m.periodId}`} aria-current={m.periodId === a.periodId ? 'page' : undefined}
                  className={m.periodId === a.periodId ? 'font-medium text-ink' : 'text-accent underline underline-offset-2'}>{m.label}</Link>
              ))}
            </nav>
          ) : null}

          <Card className="mt-6"><CardBody>
            <p className="text-sm text-ink-muted">{a.periodLabel}</p>
            {a.status === 'scored' ? (
              <p className="mt-1 flex flex-wrap items-baseline gap-3">
                <span className="font-serif text-4xl text-ink">{a.score}</span>
                <span className="text-sm text-ink-muted">out of 100</span>
                <Badge tone="accent">{a.band}</Badge>
              </p>
            ) : (
              <p className="mt-1 font-serif text-2xl text-ink">Insufficient data</p>
            )}
            <p className="mt-2 text-sm text-ink-muted">
              Data coverage {a.dataCoveragePercent}% · {a.factorsUsed} of 7 factors scored.
              {a.status === 'insufficient_data' ? ' A score needs revenue and profitability, cash flow, and at least three of the other four substantive factors.' : ''}
            </p>
          </CardBody></Card>

          <section aria-labelledby="factors" className="mt-6">
            <h2 id="factors" className="font-serif text-lg text-ink">The seven factors</h2>
            <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {a.factors.map((f) => <li key={f.key}><FactorCard factor={f} /></li>)}
            </ul>
          </section>

          {[['What helps', a.factors.flatMap((f) => f.positives)], ['What holds it back', a.factors.flatMap((f) => f.negatives)]].map(([title, list]) => (
            <Card key={title as string} className="mt-6"><CardBody>
              <h2 className="font-serif text-lg text-ink">{title as string}</h2>
              {(list as FactorResult['positives']).length === 0 ? <p className="mt-2 text-sm text-ink-muted">Nothing here.</p> : (
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
                  {(list as FactorResult['positives']).map((s) => <li key={`${s.rule}:${s.text}`}>{s.text}</li>)}
                </ul>
              )}
            </CardBody></Card>
          ))}

          <Card className="mt-6"><CardBody>
            <h2 className="font-serif text-lg text-ink">Missing information</h2>
            {a.factors.flatMap((f) => f.missing).length === 0 ? <p className="mt-2 text-sm text-ink-muted">Nothing is missing.</p> : (
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
                {a.factors.flatMap((f) => f.missing.map((m) => <li key={`${f.key}:${m.rule ?? ''}:${m.reason}:${m.text}`}>{f.name}: {m.text}</li>))}
              </ul>
            )}
          </CardBody></Card>

          <Card className="mt-6"><CardBody>
            <h2 className="font-serif text-lg text-ink">What would improve readiness</h2>
            {a.actions.length === 0 ? <p className="mt-2 text-sm text-ink-muted">Nothing to suggest.</p> : (
              <ol className="mt-2 flex flex-col gap-2 text-sm">
                {a.actions.map((x) => (
                  <li key={`${x.factor}:${x.rule ?? x.reason}`} className="flex flex-wrap justify-between gap-2">
                    <span className="text-ink">{x.text}</span>
                    <Badge tone={x.priority === 'high' ? 'warn' : 'neutral'}>{x.priority}</Badge>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-3 text-xs text-ink-faint">These are suggestions from fixed rules; nothing is added to the Action Centre automatically.</p>
          </CardBody></Card>

          <p className="mt-6 text-sm">
            {a.evidenceBundleId === null ? null : (
              <Link href={`/app/${orgSlug}/evidence/${a.evidenceBundleId}`} className="text-accent underline underline-offset-2">See the figures behind this assessment</Link>
            )}
          </p>
          <p className="mt-2 text-xs text-ink-faint">
            Rules {a.rulesVersion} · engine {a.engineVersion} · assessed {a.createdAt.slice(0, 16).replace('T', ' ')} UTC from calculation {a.calculationRunId.slice(0, 8)}.
          </p>
        </>
      )}
    </>
  );
}
