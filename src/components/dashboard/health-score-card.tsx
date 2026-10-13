import { Badge, Card, CardBody } from '@/components/ui/surfaces';
import { CLICKABLE_CARD, CardLink } from '@/components/ui/clickable-card';
import type { HealthCardView } from '@/modules/health';
import {
  CHANGE_TONE_CLASS, HEALTH_DISCLAIMER, NOT_ENOUGH_DATA_BODY, NOT_ENOUGH_DATA_TITLE,
  PROXY_CAP_NOTE, bandText, bandTone, changeText, changeTone, dimensionsNote,
} from './health-presentation';

/**
 * The health score (UX_ARCHITECTURE.md §Level 1, §5).
 *
 * Renders a `HealthCardView` and computes nothing. The score, its band and its dimension count were
 * decided by the engine and stored; the change against last month was worked out by the read service
 * from two stored scores. Nothing on this card can move a number.
 *
 * The SOW §9 disclaimer is part of the card rather than a page-level footnote, so it cannot be left
 * off a screen that shows the score. It is the difference between an indicator and a claim.
 *
 * With `explainHref` the whole card opens the breakdown (owner, 2026-10-14): "What makes up this
 * score?" is its one link, stretched over the card (`ui/clickable-card`).
 */
export function HealthScoreCard({
  view,
  periodLabel,
  comparisonLabel,
  explainHref,
}: {
  view: HealthCardView;
  periodLabel: string;
  comparisonLabel: string | null;
  explainHref?: string;
}) {
  const note = dimensionsNote(view.dimensionsUsed, view.dimensionsTotal);

  if (view.score === null) {
    return (
      <Card>
        <CardBody>
          <p className="text-xs uppercase tracking-wide text-ink-muted">Business health</p>
          <p className="mt-2 text-xl text-ink">{NOT_ENOUGH_DATA_TITLE}</p>
          <p className="mt-1 text-sm text-ink-muted">{NOT_ENOUGH_DATA_BODY}</p>
          {note ? <p className="mt-2 text-xs text-ink-faint">{note}</p> : null}
          <Disclaimer />
        </CardBody>
      </Card>
    );
  }

  const tone = changeTone(view.changeVsPrevious);

  return (
    <Card className={explainHref ? CLICKABLE_CARD : undefined}>
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-ink-muted">
              Business health · {periodLabel}
            </p>
            <p className="tabular mt-2 text-5xl leading-none text-ink">{view.score}</p>
          </div>
          <Badge tone={bandTone(view.band)}>{bandText(view.band)}</Badge>
        </div>

        <p className={`tabular mt-3 text-sm ${CHANGE_TONE_CLASS[tone]}`}>
          {changeText(view.changeVsPrevious, comparisonLabel)}
        </p>

        {note ? <p className="mt-1 text-xs text-ink-faint">{note}</p> : null}

        {/*
          ADR-035: a score resting on bank-proxy figures says so on the card, not only in the panel.
          A reader who never opens the breakdown still needs to know what the number is made of.
        */}
        {view.capped ? (
          <p className="mt-1 text-xs text-ink-muted">{PROXY_CAP_NOTE}</p>
        ) : null}

        {explainHref ? (
          <p className="mt-3 text-sm">
            <CardLink href={explainHref} className="text-accent underline underline-offset-2 group-hover:text-accent-hover">
              What makes up this score?
            </CardLink>
          </p>
        ) : null}

        <Disclaimer />
      </CardBody>
    </Card>
  );
}

/** SOW §9. Never omitted, on any screen that shows the score. */
export function Disclaimer() {
  return <p className="mt-4 text-xs text-ink-faint">{HEALTH_DISCLAIMER}</p>;
}

/**
 * The compact form, for the adviser's portfolio cards (UX §9).
 *
 * One line: the number, the band, and how much of the picture it rests on. The disclaimer lives once
 * on the portfolio page rather than forty times down a list.
 */
export function HealthScoreInline({
  score,
  band,
  dimensionsUsed,
  dimensionsTotal,
}: {
  score: number | null;
  band: Parameters<typeof bandTone>[0];
  dimensionsUsed: number;
  dimensionsTotal: number;
}) {
  if (score === null) {
    return <span className="text-sm text-ink-faint">No score yet</span>;
  }
  const note = dimensionsNote(dimensionsUsed, dimensionsTotal);
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="tabular text-2xl text-ink">{score}</span>
      <Badge tone={bandTone(band)}>{bandText(band)}</Badge>
      {note ? <span className="text-xs text-ink-faint">{note}</span> : null}
    </span>
  );
}
