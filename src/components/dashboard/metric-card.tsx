import Link from 'next/link';
import { Card, CardBody } from '@/components/ui/surfaces';
import type { ChangeView, MetricCardView } from '@/modules/dashboard';
import { StatusBadgeView } from './data-quality-badge';
import { BASIS_DIFFERS_TEXT, changeToneClass, changeToneWord } from './presentation';

/**
 * One headline number (UX_ARCHITECTURE.md §4 level 2, §5).
 *
 * The card renders a `MetricCardView` and does nothing else. Every string on it — the figure, the
 * change line, the badge, the plain label — was decided and formatted by `modules/dashboard`
 * (SERVICE_ARCHITECTURE.md §8). That is what makes the integration assertion possible: every figure
 * on Home must equal its snapshot, which can only be checked if the card is incapable of altering
 * one.
 *
 * Two variants and no others (§5): `full` for Home's level 2, `compact` for a rail or a summary
 * band.
 */
export type MetricCardVariant = 'compact' | 'full';

export function MetricCard({
  card,
  variant = 'full',
}: {
  card: MetricCardView;
  variant?: MetricCardVariant;
}) {
  const compact = variant === 'compact';
  const notComputable = card.status.kind === 'not_available';

  return (
    <Card className="h-full">
      <CardBody className={compact ? 'px-4 py-3' : ''}>
        <div className="flex items-start justify-between gap-3">
          <MetricLabel card={card} compact={compact} />
          {/*
            Exactly one badge (§8.1). When the figure is not computable the badge IS the em dash,
            and it is shown once, on the value, rather than twice.
          */}
          {notComputable ? null : <StatusBadgeView status={card.status} size={compact ? 'sm' : 'md'} />}
        </div>

        <p
          className={`tabular mt-2 ${compact ? 'text-xl' : 'text-3xl'} ${
            notComputable ? 'text-ink-faint' : 'text-ink'
          }`}
          title={notComputable ? card.status.tooltip : undefined}
        >
          {card.value}
          {notComputable ? (
            // Never a 0 and never a blank: an em dash that says why (§4).
            <span className="sr-only"> — {card.status.tooltip}</span>
          ) : null}
        </p>

        {/*
          §4: operating profit carries net profit on a visible second line. It is never tooltip-only,
          because the figure an owner is asked about by their accountant is the one after tax.
        */}
        {card.secondaryLine ? (
          <p className="mt-1 text-sm text-ink-muted">
            {card.secondaryLine.label}: <span className="tabular">{card.secondaryLine.value}</span>
          </p>
        ) : null}

        <div className={compact ? 'mt-2' : 'mt-3'}>
          <ChangeLine change={card.change} />
        </div>

        <div className="mt-3 text-sm">
          <Link
            href={card.whyHref}
            className="text-accent underline underline-offset-2 transition-colors duration-100 hover:text-accent-hover"
          >
            Why?
            <span className="sr-only">
              {' '}
              See the evidence behind {card.label} for {card.period.label}
            </span>
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * The plain phrase a business owner reads, with the accountant's term in the tooltip (§8.1).
 * The technical term is never the headline: "Profit", not "Operating profit".
 */
function MetricLabel({ card, compact }: { card: MetricCardView; compact: boolean }) {
  const tooltip = [card.technicalLabel, card.basisText].filter(Boolean).join(' · ');

  return (
    <h3
      className={`min-w-0 font-sans font-medium text-ink-muted ${compact ? 'text-xs' : 'text-sm'}`}
      title={tooltip}
    >
      {card.label}
      <span className="sr-only"> — {tooltip}</span>
    </h3>
  );
}

/**
 * "+£2,100 (+8.3%) vs February" (§8.2).
 *
 * Colour says whether the movement is good news, and that judgement is metric-aware and arrives on
 * the view model: a fall in expenses is favourable, a fall in revenue is not (§4). The direction is
 * never inferred here from the sign. A screen reader is told the same thing in a word, so
 * favourability is not carried by colour alone (§11).
 */
function ChangeLine({ change }: { change: ChangeView | null }) {
  if (!change) {
    // §8.2: an absent comparison says so, rather than showing nothing or a zero.
    return <p className="text-sm text-ink-faint">no comparison yet</p>;
  }

  const word = changeToneWord(change.favourable);

  if (change.basisDiffers) {
    /*
     * ADR-030. The two months were measured from different sources, so a percentage would divide
     * one thing by another. The amount is still shown, greyed, and the reason takes the place of
     * the percentage.
     */
    return (
      <p className="text-sm text-ink-faint">
        <span className="tabular">{change.amount}</span>{' '}
        <span>{BASIS_DIFFERS_TEXT}</span>{' '}
        <span>vs {change.comparisonLabel}</span>
      </p>
    );
  }

  return (
    <p className={`text-sm ${changeToneClass(change.favourable)}`}>
      {word ? <span className="sr-only">{word}: </span> : null}
      <span className="tabular">{change.text}</span>
    </p>
  );
}
