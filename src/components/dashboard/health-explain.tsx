import Link from 'next/link';
import { Badge, Card, CardBody } from '@/components/ui/surfaces';
import type { DimensionBreakdown, HealthCardView } from '@/modules/health';
import { Disclaimer } from './health-score-card';
import {
  BAND_SCALE, DIMENSION_DESCRIPTIONS, DIMENSION_LABELS, EXCLUSION_TEXT, capNote, figureGroups,
  RULE_LABELS, bandText, bandTone, dimensionsNote, orderedDimensions, pointsText, resultText,
  skipText,
} from './health-presentation';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/shadcn';

/**
 * The explainability panel (UX_ARCHITECTURE.md §Level 1 "explainability panel per dimension",
 * FINANCIAL_ENGINE.md §7.4).
 *
 * The panel's job is a single, checkable claim: a reader with a calculator must be able to reach the
 * number on the card. Every dimension shows its rules, the band each fell in, the points it scored
 * and the weight applied — and the test `scoreFromBreakdown` re-derives the score from exactly the
 * fields shown here. That is why the arithmetic is printed rather than summarised: "62 because
 * margins are healthy" is a reassurance, and "50 + 15 + 5 + 0 + 0 = 70, weighted 31.3%" is an
 * explanation somebody can argue with.
 *
 * It renders stored fields only. Nothing here recomputes a rule, so the panel cannot disagree with
 * the score it explains.
 */
export function HealthExplainPanel({
  view,
  periodLabel,
  orgSlug,
}: {
  view: HealthCardView;
  periodLabel: string;
  /** Present when the figures behind a dimension can be opened (`EVIDENCE_MODEL.md` §6). */
  orgSlug?: string;
}) {
  const dimensions = orderedDimensions(view.breakdown);
  const note = dimensionsNote(view.dimensionsUsed, view.dimensionsTotal);

  return (
    <section className="space-y-4">
      <Card>
        <CardBody>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg text-ink">What makes up your score</h2>
              <p className="mt-1 text-sm text-ink-muted">
                {periodLabel} · every area, every check and the points it scored.
              </p>
            </div>
            {view.score === null ? null : (
              <span className="inline-flex items-baseline gap-2">
                <span className="tabular text-3xl text-ink">{view.score}</span>
                <Badge tone={bandTone(view.band)}>{bandText(view.band)}</Badge>
              </span>
            )}
          </div>
          {note ? <p className="mt-2 text-xs text-ink-faint">{note}</p> : null}
          {/*
            * "Show evidence" on the score itself (EVIDENCE_MODEL.md §5, §6). The panel below prints
            * the arithmetic, which answers "how"; the bundle answers "which figures", which is what
            * somebody disputing a score actually asks.
            */}
          {orgSlug !== undefined && view.evidenceBundleId !== null ? (
            <p className="mt-2 text-sm">
              <Link
                href={`/app/${orgSlug}/evidence/${view.evidenceBundleId}`}
                className="text-accent underline underline-offset-2"
              >
                The figures behind this score
              </Link>
            </p>
          ) : null}
          <BandLegend />
          <Disclaimer />
        </CardBody>
      </Card>

      {dimensions.map((dimension) => (
        <DimensionPanel key={dimension.key} dimension={dimension} orgSlug={orgSlug} />
      ))}
    </section>
  );
}

function BandLegend() {
  return (
    <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
      {[...BAND_SCALE].reverse().map((band, index, all) => {
        const upper = index === all.length - 1 ? 100 : (all[index + 1]!.min - 1);
        return (
          <div key={band.band} className="flex items-center gap-1">
            <dt className="tabular">{band.min}–{upper}</dt>
            <dd>{band.label}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function DimensionPanel({
  dimension,
  orgSlug,
}: {
  dimension: DimensionBreakdown;
  orgSlug?: string;
}) {
  const label = DIMENSION_LABELS[dimension.key];

  if (!dimension.included) {
    return (
      <Card>
        <CardBody>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-ink">{label}</h3>
              <p className="mt-1 text-sm text-ink-muted">{DIMENSION_DESCRIPTIONS[dimension.key]}</p>
            </div>
            <span className="text-sm text-ink-faint">—</span>
          </div>
          <p className="mt-2 text-sm text-warn">
            {dimension.exclusion_reason === null
              ? 'Not scored this month.'
              : EXCLUSION_TEXT[dimension.exclusion_reason]}
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-ink">{label}</h3>
            <p className="mt-1 text-sm text-ink-muted">{DIMENSION_DESCRIPTIONS[dimension.key]}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="tabular text-2xl text-ink">{dimension.score}</p>
            <p className="tabular text-xs text-ink-faint">
              {dimension.weight_applied}% of the score
            </p>
          </div>
        </div>

        {dimension.capped ? (
          <p className="mt-2 text-xs text-ink-muted">{capNote(dimension)}</p>
        ) : null}

        <RuleTable dimension={dimension} />

        {dimension.positives.length > 0 ? (
          <FactorList title="What is going well" items={dimension.positives} tone="text-ink" />
        ) : null}
        {dimension.negatives.length > 0 ? (
          <FactorList title="What needs a look" items={dimension.negatives} tone="text-ink" />
        ) : null}

        <MetricLinks dimension={dimension} orgSlug={orgSlug} />
      </CardBody>
    </Card>
  );
}

/**
 * "Show evidence" on a health factor (`EVIDENCE_MODEL.md` §6).
 *
 * §7.4 pins the exact `metric_snapshots.id` behind every figure a dimension rested on, so each of
 * these opens the evidence for THAT figure — the one this score was worked out from — rather than
 * whatever the metric says now. A score that cannot be traced to its inputs is an opinion.
 */
function MetricLinks({
  dimension,
  orgSlug,
}: {
  dimension: DimensionBreakdown;
  orgSlug?: string;
}) {
  if (orgSlug === undefined) return null;
  const groups = figureGroups(dimension.metrics);
  if (groups.length === 0) return null;
  const href = (snapshotId: string) => `/app/${orgSlug}/evidence?snapshot=${snapshotId}`;

  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="text-xs text-ink-faint">The figures this used</p>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {groups.map((group) => (
          // A long figure name must wrap inside the card, never widen the page on a phone (§11).
          <li key={group.label} className="min-w-0 max-w-full">
            {group.snapshotIds.length === 1 ? (
              <Link
                href={href(group.snapshotIds[0]!)}
                className="text-accent underline underline-offset-2 [overflow-wrap:anywhere]"
              >
                {group.label}
              </Link>
            ) : (
              // The same figure more than once (a customer's sales in each month, say): named once,
              // with a numbered link to each; the evidence each opens names its month.
              <span className="[overflow-wrap:anywhere]">
                <span className="text-ink">{group.label}:</span>
                {group.snapshotIds.map((id, index) => (
                  <Link
                    key={id}
                    href={href(id)}
                    aria-label={`${group.label}, figure ${index + 1} of ${group.snapshotIds.length}`}
                    className="ml-1 inline-block min-w-6 px-1 text-center text-accent underline underline-offset-2"
                  >
                    {index + 1}
                  </Link>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The arithmetic, printed.
 *
 * The baseline row is shown explicitly because the sum does not add up without it: §7.3 starts every
 * dimension at 50 and moves it. A panel that listed only the rules would leave a reader unable to
 * reconcile "+15 +5" with a score of 70.
 */
function RuleTable({ dimension }: { dimension: DimensionBreakdown }) {
  return (
    <Table className="mt-3 min-w-0">
      <TableCaption className="sr-only">
        How {DIMENSION_LABELS[dimension.key]} reached {dimension.score}
      </TableCaption>
      <TableHeader>
        <TableRow className="text-left text-xs uppercase tracking-wide text-ink-muted">
          <TableHead scope="col" className="py-1 font-medium">Check</TableHead>
          <TableHead scope="col" className="py-1 font-medium">Result</TableHead>
          <TableHead scope="col" className="py-1 text-right font-medium">Points</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow className="border-t border-line">
          <TableCell className="py-1 text-ink-muted" colSpan={2}>Starting point</TableCell>
          <TableCell className="tabular py-1 text-right text-ink-muted">50</TableCell>
        </TableRow>
        {dimension.rules.map((rule) => {
          const skipped = skipText(rule.skipped_reason);
          return (
            <TableRow key={rule.rule} className="border-t border-line align-top">
              <TableHead scope="row" className="py-1 text-left font-normal text-sm normal-case tracking-normal text-ink">
                {RULE_LABELS[rule.rule] ?? rule.rule}
              </TableHead>
              <TableCell className="py-1 text-ink-muted">
                {skipped ?? resultText(rule.rule, rule.result)}
              </TableCell>
              <TableCell className="tabular py-1 text-right text-ink">
                {skipped === null ? pointsText(rule.points) : '—'}
              </TableCell>
            </TableRow>
          );
        })}
        <TableRow className="border-t border-line font-medium">
          <TableCell className="py-1 text-ink" colSpan={2}>
            {dimension.capped ? 'Total, capped' : 'Total'}
          </TableCell>
          <TableCell className="tabular py-1 text-right text-ink">{dimension.score}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

function FactorList({
  title, items, tone,
}: { title: string; items: readonly string[]; tone: string }) {
  return (
    <div className="mt-3">
      <p className="text-xs uppercase tracking-wide text-ink-muted">{title}</p>
      <ul className={`mt-1 list-disc space-y-1 pl-5 text-sm ${tone}`}>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}
