import Link from 'next/link';
import type { Metadata } from 'next';
import { CalendarRange, ListChecks, Workflow } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import {
  loadDataProgress, type Blocker, type CoverageCell, type DataProgressView, type ProgressBatchView, type ProgressSourceView, type StepState,
} from '@/modules/departments';
import { PageHeader, Card, CardHeader, CardBody, DetailList } from '@/components/ui/surfaces';
import { ButtonLink } from '@/components/ui/button';
import { formatDate, formatDateTime } from '@/components/labels';
import { requirePermission } from '@/app/_lib/authz';
import { formatCoverage, importTypeLabel } from '../imports/labels';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Data progress' };

/**
 * Data progress (owner, 2026-11-02: "show the actual progress of where it is and what we are stuck
 * on"), opened from the dashboard's Compliance View card. Everything is read by
 * `loadDataProgress` from the company's own uploads, calculation runs, bank accounts, chart of
 * accounts and tax dates; this page only lays it out. Gated as the Imports pages (`imports.review`).
 */
export default async function DataProgressPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'imports.review');
  const view = await loadDataProgress(ctx);
  const base = `/app/${orgSlug}`;

  return (
    <>
      <PageHeader
        eyebrow="Data"
        title="Data progress"
        description="Where each upload is on its way into your figures, which months your data covers, and what is holding anything up."
        action={view.canAddData ? <ButtonLink href={`${base}/data/imports/new`}>Add data</ButtonLink> : undefined}
      />
      <div className="flex min-w-0 flex-col gap-6">
        <StatusCard view={view} />
        <BlockersCard blockers={view.blockers} />
        <CoverageCard coverage={view.coverage} />
        <SourcesCard sources={view.sources} importsHref={`${base}/data/imports`} />
      </div>
    </>
  );
}

const HEADLINE_DOT: Record<DataProgressView['headline']['kind'], string> = {
  up_to_date: 'bg-good-dot', updating: 'bg-warn-dot', needs_you: 'bg-accent', failed: 'bg-danger',
};

const RUN_STATUS: Readonly<Record<string, string>> = { succeeded: 'finished', failed: 'failed', running: 'running' };

function StatusCard({ view }: { view: DataProgressView }) {
  const items = [
    { label: 'Last data added', value: view.lastDataAdded === null ? 'Nothing yet' : formatDate(view.lastDataAdded) },
    ...(view.seesRuns ? [
      {
        label: 'Last calculation',
        value: view.lastRun === null ? 'None yet' : (
          <>
            {formatDateTime(view.lastRun.at)} · {RUN_STATUS[view.lastRun.status] ?? view.lastRun.status.replace(/_/g, ' ')}
            {view.lastRun.engineVersion ? <span className="text-ink-muted"> · engine {view.lastRun.engineVersion}</span> : null}
          </>
        ),
      },
      ...(view.lastRun !== null && view.lastRun.status !== 'succeeded'
        ? [{ label: 'Figures on screen from', value: view.lastSuccessAt === null ? 'No update has finished yet' : formatDateTime(view.lastSuccessAt) }]
        : []),
    ] : []),
  ];
  return (
    <Card>
      <CardBody className="p-5 sm:p-6">
        <div role="status" className="flex items-start gap-3">
          <span aria-hidden="true" className={`mt-3 size-2.5 shrink-0 rounded-full ${HEADLINE_DOT[view.headline.kind]}`} />
          <div className="min-w-0">
            <h2 className="font-serif text-2xl text-ink sm:text-3xl">{view.headline.title}</h2>
            <p className="mt-1 text-sm text-ink-muted">{view.headline.line}</p>
          </div>
        </div>
        <div className="mt-5 border-t border-line pt-4">
          <DetailList items={items} />
        </div>
      </CardBody>
    </Card>
  );
}

function BlockersCard({ blockers }: { blockers: readonly Blocker[] }) {
  return (
    <Card id="stuck">
      <CardHeader icon={<ListChecks />} tint="pink" title="What we are stuck on" description="In the order to deal with them. Each opens the page that fixes it." />
      <CardBody className="pt-0">
        {blockers.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing is stuck. Every upload has gone through and nothing is waiting for you.</p>
        ) : (
          <ol className="divide-y divide-line">
            {blockers.map((b, i) => (
              <li key={`${b.kind}-${i}`} className="flex flex-wrap items-start gap-3 py-3.5 last:pb-0">
                <span
                  aria-hidden="true"
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${b.needsYou ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-surface-sunken text-ink-muted'}`}
                >
                  {b.needsYou ? '!' : 'i'}
                </span>
                <div className="min-w-0 flex-1 basis-60">
                  <p className="text-sm text-ink">
                    <span className="sr-only">{b.needsYou ? 'Needs you: ' : 'For information: '}</span>
                    {b.sentence}
                  </p>
                  {b.detail ? <p className="mt-0.5 text-sm break-words text-ink-muted">{b.detail}</p> : null}
                </div>
                {b.action ? (
                  <ButtonLink href={b.action.href} tone={b.needsYou ? 'primary' : 'secondary'} className="shrink-0">{b.action.label}</ButtonLink>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

const CELL_CLASS: Record<CoverageCell, string> = {
  full: 'bg-pink border-pink',
  partial: 'bg-pink/25 border-pink/60',
  none: 'bg-surface border-line',
  gap: 'bg-accent-soft border-accent border-dashed',
};
const CELL_WORDS: Record<CoverageCell, string> = { full: 'Covered', partial: 'Part of the month', none: 'Not covered', gap: 'Missing' };

function CoverageCard({ coverage }: { coverage: DataProgressView['coverage'] }) {
  const { months, rows } = coverage;
  return (
    <Card id="coverage" className="min-w-0">
      <CardHeader
        icon={<CalendarRange />}
        title="Month by month"
        description="The last twelve months, and which of your sources covers each one — by the dates each file says it covers."
      />
      <CardBody className="min-w-0 pt-0">
        {rows.length === 0 ? (
          <p className="text-sm text-ink-muted">No upload is in your figures yet, so no month is covered.</p>
        ) : (
          <>
            {/* `relative`: the screen-reader text in the cells is positioned inside this box, not the page;
                tabIndex: a keyboard user can reach the strip to scroll it on a narrow screen. */}
            <div tabIndex={0} className="relative w-full max-w-full overflow-x-auto rounded-sm pb-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <table className="w-full min-w-[40rem] border-separate border-spacing-1 text-xs">
                <caption className="sr-only">Which sources cover each of the last twelve months</caption>
                <thead>
                  <tr>
                    <th scope="col" className="w-44 text-left font-medium text-ink-muted">Source</th>
                    {months.map((m) => (
                      <th key={m.key} scope="col" className="text-center font-medium text-ink-muted">
                        <span aria-hidden="true">{m.short}</span>
                        <span className="sr-only">{m.label}{m.current ? ', this month so far' : ''}</span>
                        {m.short === 'Jan' || m.key === months[0]!.key ? <span aria-hidden="true" className="block text-[0.625rem] text-ink-faint">{m.key.slice(0, 4)}</span> : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key}>
                      <th scope="row" className="pr-2 text-left font-normal break-words text-ink">{row.label}</th>
                      {row.cells.map((cell, i) => (
                        <td key={months[i]!.key} className="p-0">
                          <span title={`${months[i]!.label}: ${CELL_WORDS[cell]}`} className={`block h-6 rounded-md border ${CELL_CLASS[cell]} ${months[i]!.current ? 'opacity-70' : ''}`}>
                            <span className="sr-only">{months[i]!.label}: {CELL_WORDS[cell]}</span>
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <th scope="row" className="pr-2 pt-1 text-left font-normal text-ink-muted">Month complete in APX</th>
                    {months.map((m) => (
                      <td key={m.key} className="pt-1 text-center">
                        <span aria-hidden="true" className={m.complete === true ? 'text-blue-ink' : 'text-ink-faint'}>{m.complete === true ? '✓' : m.complete === false ? '…' : '—'}</span>
                        <span className="sr-only">{m.label}: {m.complete === true ? 'complete' : m.complete === false ? 'not complete yet' : 'no figures'}</span>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <ul aria-label="Key" className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-muted">
              {(['full', 'partial', 'gap', 'none'] as const).map((cell) => (
                <li key={cell} className="flex items-center gap-1.5">
                  <span aria-hidden="true" className={`inline-block h-3 w-5 rounded border ${CELL_CLASS[cell]}`} />
                  {cell === 'gap' ? 'Missing — inside the months your data covers' : CELL_WORDS[cell]}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SourcesCard({ sources, importsHref }: { sources: readonly ProgressSourceView[]; importsHref: string }) {
  return (
    <Card id="uploads">
      <CardHeader
        icon={<Workflow />}
        title="Your uploads, step by step"
        description="Each source’s latest uploads: uploaded, read, columns matched, checked, reviewed by you, in the books, and counted in your figures."
        action={<Link href={importsHref} className="text-sm font-medium text-accent underline-offset-2 hover:underline">All imports</Link>}
      />
      <CardBody className="pt-0">
        <div className="divide-y divide-line">
          {sources.map((s) => (
            <section key={s.key} aria-labelledby={`source-${s.key}`} className="py-4 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 id={`source-${s.key}`} className="font-serif text-lg text-ink">{s.label}</h3>
                <p className="text-xs text-ink-muted">{[s.sublabel, s.reach].filter(Boolean).join(' · ') || null}</p>
              </div>
              {s.batches.length === 0 ? (
                <p className="mt-1 text-sm text-ink-muted">Nothing uploaded yet.</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-3">
                  {s.batches.map((b) => <BatchRow key={b.id} batch={b} />)}
                </ul>
              )}
              {s.more > 0 ? (
                <p className="mt-2 text-xs text-ink-muted">
                  And {s.more} earlier {s.more === 1 ? 'upload' : 'uploads'} — <Link href={importsHref} className="text-accent underline underline-offset-2">see all imports</Link>.
                </p>
              ) : null}
            </section>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

const STEP_CLASS: Record<StepState, string> = {
  done: 'border-pink/30 bg-pink/10 text-blue-ink',
  current: 'border-pink/60 bg-pink/20 font-semibold text-blue-ink',
  waiting: 'border-accent/50 bg-accent-soft font-semibold text-accent',
  failed: 'border-danger/50 bg-danger-soft font-semibold text-danger',
  stopped: 'border-line bg-surface-sunken text-ink-muted line-through',
  todo: 'border-line bg-surface text-ink-faint',
};
const STEP_MARK: Record<StepState, string> = { done: '✓', current: '•', waiting: '!', failed: '×', stopped: '–', todo: '' };
const STEP_WORDS: Record<StepState, string> = { done: 'done', current: 'in progress', waiting: 'waiting for you', failed: 'failed', stopped: 'stopped', todo: 'not yet' };
const TONE_CLASS: Record<ProgressBatchView['pipeline']['tone'], string> = {
  good: 'text-blue-ink', active: 'text-ink', attention: 'text-accent', failed: 'text-danger', muted: 'text-ink-muted',
};

function BatchRow({ batch }: { batch: ProgressBatchView }) {
  return (
    <li className="rounded-xl border border-line p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Link href={batch.href} className="min-w-0 font-medium break-words text-accent underline underline-offset-2">{batch.filename}</Link>
        <span className={`text-sm font-medium ${TONE_CLASS[batch.pipeline.tone]}`}>{batch.pipeline.summary}</span>
      </div>
      <p className="mt-0.5 text-xs text-ink-muted">
        {importTypeLabel(batch.importType)} · {formatCoverage(batch.periodStart, batch.periodEnd)} · {batch.rows} {batch.rows === 1 ? 'row' : 'rows'}
        {batch.addedAt ? ` · ${formatDate(batch.addedAt)}` : ''}
      </p>
      <ol aria-label={`Progress of ${batch.filename}`} className="mt-2.5 flex flex-wrap gap-1.5">
        {batch.pipeline.steps.map((step) => (
          <li key={step.label} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] ${STEP_CLASS[step.state]}`}>
            {STEP_MARK[step.state] ? <span aria-hidden="true">{STEP_MARK[step.state]}</span> : null}
            {step.label}
            <span className="sr-only">: {STEP_WORDS[step.state]}</span>
          </li>
        ))}
      </ol>
      {batch.error ? <p className="mt-2 text-sm break-words text-danger">{batch.error}</p> : null}
    </li>
  );
}
