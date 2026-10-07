import Link from 'next/link';
import type { FundingReportContent } from '@/modules/reporting';
import { ChevronRight, CircleHelp, Gauge, Lightbulb, ListChecks, ThumbsUp, TriangleAlert } from 'lucide-react';
import { Badge, Banner, Card, CardBody, IconBadge } from '@/components/ui/surfaces';

/**
 * The Funding Readiness Report on screen (REQ-RP-05). Renders the stored content only — the assessment
 * as it stood when the report was produced — with the disclaimer first, as the Funding page does.
 */
export function FundingReportView({ content, orgSlug }: { content: FundingReportContent; orgSlug: string }) {
  const a = content.assessment;
  const positives = a.factors.flatMap((f) => f.positives);
  const negatives = a.factors.flatMap((f) => f.negatives);
  const missing = a.factors.flatMap((f) => f.missing.map((m) => ({ key: `${f.key}:${m.rule ?? ''}:${m.reason}`, text: `${f.name}: ${m.text}` })));
  return (
    <div className="flex flex-col gap-6">
      <Banner tone="info" title="Not a lending decision">{a.disclaimer}</Banner>

      <Card><CardBody className="flex min-w-0 items-start gap-4">
        <IconBadge tint="violet" size="lg"><Gauge /></IconBadge>
        <div className="min-w-0">
        <p className="text-sm text-ink-muted">{content.period.label}</p>
        {a.status === 'scored' ? (
          <p className="mt-1 flex flex-wrap items-baseline gap-3">
            <span className="font-serif text-4xl text-ink">{a.score}</span>
            <span className="text-sm text-ink-muted">out of 100</span>
            <Badge tone="accent">{a.band}</Badge>
          </p>
        ) : (
          <p className="mt-1 font-serif text-2xl text-ink">Insufficient data</p>
        )}
        <p className="mt-2 text-sm text-ink-muted">Data coverage {a.dataCoveragePercent}% · {a.factorsUsed} of 7 factors scored.</p>
        </div>
      </CardBody></Card>

      <Card><CardBody>
        <div className="flex min-w-0 items-center gap-3">
          <IconBadge tint="pink" size="sm"><ListChecks /></IconBadge>
          <h2 className="min-w-0 font-serif text-lg text-ink">The seven factors</h2>
        </div>
        <dl className="mt-3 flex flex-col gap-3">
          {a.factors.map((f) => (
            <div key={f.key} className="border-b border-line pb-3 last:border-0">
              <dt className="flex justify-between text-sm text-ink">
                <span>{f.name} <span className="text-ink-faint">· weight {f.weight}</span></span>
                <span className="font-serif text-lg">{f.score === null ? '—' : f.score}</span>
              </dt>
              <dd className="mt-1 text-sm text-ink-muted">
                {f.status === 'missing' ? f.missing[0]?.text ?? 'Not available.' : f.capReason === null ? 'Scored.' : `At most 70: ${f.capReason}.`}
              </dd>
            </div>
          ))}
        </dl>
      </CardBody></Card>

      {([['What helps', positives], ['What holds it back', negatives]] as const).map(([title, list]) => (
        <Card key={title}><CardBody>
          <div className="flex min-w-0 items-center gap-3">
            <IconBadge tint={title === 'What helps' ? 'violet' : 'pink'} size="sm">
              {title === 'What helps' ? <ThumbsUp /> : <TriangleAlert />}
            </IconBadge>
            <h2 className="min-w-0 font-serif text-lg text-ink">{title}</h2>
          </div>
          {list.length === 0 ? <p className="mt-2 text-sm text-ink-muted">Nothing here.</p> : (
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
              {list.map((s) => <li key={`${s.rule}:${s.text}`}>{s.text}</li>)}
            </ul>
          )}
        </CardBody></Card>
      ))}

      <Card><CardBody>
        <div className="flex min-w-0 items-center gap-3">
          <IconBadge tint="violet" size="sm"><CircleHelp /></IconBadge>
          <h2 className="min-w-0 font-serif text-lg text-ink">Missing information</h2>
        </div>
        {missing.length === 0 ? <p className="mt-2 text-sm text-ink-muted">Nothing is missing.</p> : (
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
            {missing.map((m) => <li key={m.key}>{m.text}</li>)}
          </ul>
        )}
      </CardBody></Card>

      <Card><CardBody>
        <div className="flex min-w-0 items-center gap-3">
          <IconBadge tint="pink" size="sm"><Lightbulb /></IconBadge>
          <h2 className="min-w-0 font-serif text-lg text-ink">What would improve readiness</h2>
        </div>
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
      </CardBody></Card>

      <p className="text-sm print:hidden">
        <Link href={`/app/${orgSlug}/funding?period=${content.period.id}`} className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft">
          Open the current assessment for {content.period.label}
          <ChevronRight aria-hidden="true" className="size-4" />
        </Link>
      </p>
      <p className="text-xs text-ink-faint">
        Rules {a.rulesVersion} · engine {a.engineVersion} · assessed {a.assessedAt.slice(0, 16).replace('T', ' ')} UTC from calculation {a.calculationRunId.slice(0, 8)}.
      </p>
    </div>
  );
}
