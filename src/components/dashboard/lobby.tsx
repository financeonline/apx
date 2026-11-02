import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, ChevronRight } from 'lucide-react';
import type { AlertView, MetricCardView } from '@/modules/dashboard';
import type { HealthCardView } from '@/modules/health';
import type { Action } from '@/modules/actions';
import { ABOVE_CARD_LINK, CardLink, TOUCH_TARGET } from '@/components/ui/clickable-card';
import { formatDate } from '@/components/labels';
import { MoreApps } from './more-apps';
import { severityLabel } from './alert-presentation';
import { priorityLabel } from './action-card';
import {
  CHANGE_TONE_CLASS, HEALTH_DISCLAIMER, NOT_ENOUGH_DATA_BODY, NOT_ENOUGH_DATA_TITLE, PROXY_CAP_NOTE,
  bandText, changeText, changeTone, dimensionsNote, scoreRingDash,
} from './health-presentation';
import { SPARK_BOX, sparklineRuns, type TrendSeriesView } from './presentation';

/**
 * The client lobby (ADR-176), in the owner's third reference (ADR-179, "APX Financial System",
 * 2026-11-01): white cards with cool hairlines, APX magenta with blue as the second colour, Georgia
 * for the cards' display titles — the departments in a row, the greeting, then the analysis.
 *
 * Every figure, label and sentence arrives from a view model; these components only lay them out.
 * Colours are the shell's tokens only: the shell root carries `.theme-lobby` in the light look and
 * ADR-169's dark tokens otherwise (`data-look`), so the lobby follows the owner's light/dark toggle.
 * The lobby-only properties (`--lobby-serif`, `--lobby-wine`, `--icon-gradient`) carry dark fallbacks.
 */

/** A lobby card: white, a cool hairline, 12px corners, no shadow — as the reference. */
export const LOBBY_CARD = 'rounded-xl border border-line bg-surface';

/** A lobby card that opens something: the reference's quiet magenta hover. */
export const LOBBY_CLICKABLE =
  'group relative transition-[box-shadow,border-color,background-color] duration-200 hover:border-accent/50 hover:shadow-[var(--glow-card)] focus-within:border-accent/60 focus-within:shadow-[var(--glow-card-focus)]';

const STRETCH_XL = 'after:rounded-xl';

/** The reference's serif display title (cards' headings): Georgia, deep blue. */
export const SERIF_TITLE = 'font-[family-name:var(--lobby-serif,var(--font-serif))] font-normal tracking-[-0.015em] text-[color:var(--lobby-wine,var(--color-ink))]';

/**
 * The light canvas, around every page of a company (the org layout). It runs to the shell's edges (the main column's padding is taken back) and,
 * through a clipped spread shadow, to the window's sides on a screen wider than the column.
 */
export function LobbyCanvas({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 -my-6 min-h-[calc(100vh-4rem)] px-4 pt-6 pb-10 [box-shadow:0_0_0_100vmax_var(--color-paper)] [clip-path:inset(0_-100vmax)] sm:-mx-6 sm:px-6 lg:-mx-8 lg:-my-8 lg:px-11 lg:pt-8">
      {children}
    </div>
  );
}

/** The small capitals over a heading: "YOUR NEXT MOVES" — with the reference's magenta dot when asked. */
export function Eyebrow({
  children, tone = 'muted', as: Tag = 'p', dot = false,
}: { children: ReactNode; tone?: 'muted' | 'accent'; as?: 'p' | 'span'; dot?: boolean }) {
  return (
    <Tag className={`flex items-center gap-2 text-[0.625rem] leading-relaxed font-semibold tracking-[0.17em] uppercase ${tone === 'accent' ? 'text-accent' : 'text-ink-muted'}`}>
      {dot ? <span aria-hidden="true" className="inline-block size-[5px] shrink-0 rounded-full bg-accent" /> : null}
      {children}
    </Tag>
  );
}

/** The reference's magenta full stop after a heading. Decorative. */
function Stop() {
  return <span aria-hidden="true" className="text-accent">.</span>;
}

export interface LobbyDepartment {
  readonly key: string;
  readonly title: string;
  readonly line: string;
  readonly href: string;
  readonly icon: ReactNode;
}

/**
 * "Your departments": one tile per department the reader may open, the current one marked, and
 * "More apps" in its own column — it opens the workspace window (`MoreApps`). Numbered as the
 * reference; the count is of real tiles.
 */
export function DepartmentStrip({
  departments, currentKey, showMore,
}: { departments: readonly LobbyDepartment[]; currentKey: string; showMore: boolean }) {
  return (
    <nav
      aria-labelledby="lobby-departments"
      className={`grid gap-x-3 gap-y-2.5 border-b border-line pb-[1.375rem] ${showMore ? 'lg:grid-cols-[minmax(0,1fr)_9rem] xl:grid-cols-[minmax(0,1fr)_10.3125rem]' : ''}`}
    >
      <div className="flex items-baseline gap-3.5 lg:col-span-full">
        <h2 id="lobby-departments"><Eyebrow as="span">Your departments</Eyebrow></h2>
        <span className="text-[0.5625rem] font-semibold tracking-[0.17em] text-ink-muted uppercase">
          {String(departments.length).padStart(2, '0')} active
        </span>
      </div>
      <ul className="grid min-w-0 grid-cols-2 gap-2.5 sm:grid-cols-3 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none xl:gap-[0.6875rem]">
        {departments.map((department, index) => {
          const current = department.key === currentKey;
          return (
            <li key={department.key} className="min-w-0">
              <Link
                href={department.href}
                aria-current={current ? 'page' : undefined}
                className={`relative flex h-full min-h-[4.375rem] min-w-0 items-center gap-2.5 rounded-[0.625rem] border px-3 py-3 transition-[border-color,transform,background-color] duration-200 ${
                  current
                    ? 'border-accent bg-accent-soft/50'
                    : 'border-line bg-surface hover:-translate-y-0.5 hover:border-accent/50 hover:bg-accent-soft/40'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`flex size-[2.0625rem] shrink-0 items-center justify-center rounded-lg [&_svg]:size-[1.125rem] [&_svg]:stroke-[1.6] ${current ? 'bg-[image:var(--icon-gradient,var(--brand-gradient))] text-on-accent' : 'bg-accent-soft text-accent'}`}
                >
                  {department.icon}
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[0.75rem] font-semibold text-ink">{department.title}</span>
                  <span className="mt-1 block truncate text-[0.6875rem] text-ink-muted">{department.line}</span>
                </span>
                <span aria-hidden="true" className="hidden self-start text-[0.5625rem] text-ink-faint xl:inline">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {current ? <span aria-hidden="true" className="absolute inset-x-[1.125rem] -bottom-px h-[3px] rounded-[2px] bg-accent" /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
      {showMore ? (
        <div className="min-w-0">
          <MoreApps departments={departments} />
        </div>
      ) : null}
    </nav>
  );
}

/** "Workspace / Financial Analysis", the greeting, and the company it is about. */
export function LobbyHero({
  section, greeting, orgName, orgLine,
}: { section: string; greeting: string; orgName: string; orgLine: string }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-6 pt-[1.375rem] pb-2">
      <div className="min-w-0">
        <p className="flex items-center gap-3 text-[0.625rem] tracking-[0.18em] text-ink-muted uppercase">
          Workspace <span aria-hidden="true" className="text-ink-faint">/</span>
          <span className="text-[0.6875rem] font-medium tracking-[0.02em] text-ink normal-case">{section}</span>
        </p>
        <h1 className="mt-3 text-[1.5625rem] leading-[1.2] font-normal tracking-[-0.032em] text-ink">
          Clarity today.{' '}
          <em className="block font-[family-name:var(--lobby-serif,var(--font-serif))] text-[1.6875rem] font-normal tracking-[-0.022em] text-accent sm:ml-1.5 sm:inline">
            Confidence tomorrow.
          </em>
        </h1>
        <p className="mt-2.5 text-[0.75rem] text-ink-muted">{greeting}</p>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden="true" className="flex size-[2.3125rem] shrink-0 items-center justify-center rounded-[0.625rem] border border-line text-sm font-semibold text-accent">
          {orgName.trim().slice(0, 1).toUpperCase() || 'A'}
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-[0.75rem] font-semibold text-ink">{orgName}</span>
          <span className="mt-1.5 block truncate text-[0.6875rem] text-ink-muted">{orgLine}</span>
        </span>
      </div>
    </header>
  );
}

/** A numbered band's heading: "• 01 / UNDERSTAND YOUR PERFORMANCE", then the title with its magenta stop. */
export function BandHeading({
  id, number, eyebrow, title, end,
}: { id: string; number: string; eyebrow: string; title: string; end?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <Eyebrow dot>{number} / {eyebrow}</Eyebrow>
        <h2 id={id} className="mt-1.5 text-[1.5rem] leading-tight font-semibold tracking-[-0.025em] text-ink sm:text-[1.75rem]">
          {title}<Stop />
        </h2>
      </div>
      {end ? <div className="flex flex-wrap items-center gap-x-5 gap-y-2">{end}</div> : null}
    </div>
  );
}

/** The reference's text button: blue, semibold, an arrow — "View assumptions →". */
export function ArrowLink({ href, children, className = '' }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={`inline-flex items-center gap-2 text-[0.75rem] font-semibold text-blue-ink hover:text-accent ${TOUCH_TARGET} ${className}`}>
      {children} <ArrowRight aria-hidden="true" className="size-[0.8125rem]" />
    </Link>
  );
}

/** A pill in a band's corner: the period, the basis — the reference's "2023 vs 2022". */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-[0.3125rem] border border-line bg-surface-sunken px-2.5 py-1.5 text-[0.6875rem] whitespace-nowrap text-ink-muted">
      {children}
    </span>
  );
}

const STATUS_CHIP: Readonly<Record<string, string>> = {
  check: 'bg-warn-soft text-warn',
  partial: 'bg-warn-soft text-warn',
  estimate: 'bg-surface-sunken text-ink-muted',
};

/**
 * A headline figure, the reference's metric card: the label, the figure large, the change under it,
 * and its last twelve months as a small magenta line at the right. The whole card opens the figure's
 * evidence ("Why?"), for a reader who may open it (ADR-172).
 */
export function LobbyFigure({ card, trend, showWhy }: { card: MetricCardView; trend: TrendSeriesView | null; showWhy: boolean }) {
  const runs = trend ? sparklineRuns(trend) : [];
  const tone = !card.change || card.change.basisDiffers || card.change.favourable === null ? 'text-ink-muted'
    : card.change.favourable ? 'text-good' : 'text-danger';
  return (
    <article className={`@container flex h-full flex-col px-[1.4375rem] py-[1.3125rem] ${LOBBY_CARD} ${showWhy ? LOBBY_CLICKABLE : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-[0.75rem] font-normal tracking-normal text-ink-muted">{card.label}</h3>
        {/* Only a status that asks the reader to take care is shown here; "Calculated" is the ordinary case. */}
        {card.status.kind !== 'none' && card.status.kind !== 'calculated' && card.status.label !== null ? (
          <span title={card.status.tooltip} className={`${ABOVE_CARD_LINK} shrink-0 rounded px-2 py-0.5 text-[0.6875rem] ${STATUS_CHIP[card.status.kind] ?? 'bg-surface-sunken text-ink-muted'}`}>
            {card.status.label}
          </span>
        ) : null}
      </div>
      <p className="mt-3.5 text-[1.75rem] leading-[1.15] font-medium tracking-[-0.025em] break-words text-ink tabular-nums @[16rem]:text-[2.125rem]">
        {card.value}
      </p>
      {card.secondaryLine ? (
        <p className="mt-2 text-[0.6875rem] text-ink-muted">
          {card.secondaryLine.label}: <span className="tabular-nums">{card.secondaryLine.value}</span>
        </p>
      ) : null}
      <div className="mt-auto flex items-end justify-between gap-4 pt-3">
        <div className="min-w-0 text-[0.6875rem] leading-[1.7]">
          {!card.change ? (
            <p className="text-ink-faint">no comparison yet</p>
          ) : card.change.basisDiffers ? (
            <p className="text-ink-faint"><span className="tabular-nums">{card.change.amount}</span> compared on a different basis</p>
          ) : (
            <p className={`font-semibold tabular-nums ${tone}`}>{card.change.text}</p>
          )}
          {showWhy ? (
            <CardLink
              href={card.whyHref}
              title={[card.technicalLabel, card.basisText].filter(Boolean).join(' · ') || undefined}
              className={`mt-1 inline-flex items-center gap-0.5 text-ink-muted group-hover:text-accent ${STRETCH_XL}`}
            >
              Why? <ChevronRight aria-hidden="true" className="size-3.5" />
            </CardLink>
          ) : card.basisText ? (
            <p className="mt-1 text-ink-faint">{card.basisText}</p>
          ) : null}
        </div>
        {runs.length > 0 ? (
          <svg aria-hidden="true" viewBox={`0 0 ${SPARK_BOX.width} ${SPARK_BOX.height}`} className="h-[3.0625rem] w-[8.375rem] max-w-[45%] shrink-0 overflow-visible">
            {runs.map((points) => (
              <polyline key={points} points={points} fill="none" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className="stroke-accent" />
            ))}
          </svg>
        ) : null}
      </div>
    </article>
  );
}

/**
 * "Top risks" in the reference's "Key Report Indicators" panel: up to three numbered cards, each
 * opening its alert, with the alert's next step as the card's "Focus". Highest severity first, as
 * the service ordered them.
 */
export function RiskPoints({ risks, allHref, periodLabel }: { risks: readonly AlertView[]; allHref: string; periodLabel: string }) {
  return (
    <section aria-labelledby="lobby-risks" className="rounded-xl border border-line bg-surface p-5 sm:p-[1.4375rem]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow>From your alerts</Eyebrow>
          <h2 id="lobby-risks" className="mt-1.5 text-[1.25rem] font-semibold tracking-[-0.022em] text-ink">
            {risks.length === 0 ? 'Nothing needs your attention' : 'Key report indicators'}<Stop />
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Chip>{periodLabel}</Chip>
          <ArrowLink href={allHref}>See all alerts</ArrowLink>
        </div>
      </div>
      {risks.length === 0 ? (
        <p className="mt-3 max-w-prose text-[0.75rem] text-ink-muted">No open alerts. APX checks again after every calculation.</p>
      ) : (
        <ul className="mt-5 grid gap-[1.125rem] md:grid-cols-2 xl:grid-cols-3">
          {risks.map((risk, index) => (
            <li key={risk.id} className="min-w-0">
              <article className={`flex h-full flex-col rounded-[0.625rem] border border-line bg-surface p-5 ${LOBBY_CLICKABLE}`}>
                <div className="flex items-center justify-between gap-2">
                  <span aria-hidden="true" className="text-[0.625rem] tracking-[0.15em] text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                  <span title={risk.thresholdNote ?? undefined} className={`${ABOVE_CARD_LINK} rounded px-[0.4375rem] py-1 text-[0.625rem] leading-[1.6] ${risk.severity === 'critical' || risk.severity === 'high' ? 'bg-accent-soft text-danger' : risk.severity === 'medium' ? 'bg-warn-soft text-warn' : 'bg-surface-sunken text-ink-muted'}`}>
                    {severityLabel(risk.severity)}
                  </span>
                </div>
                <h3 className="mt-4 text-[1.0625rem] leading-snug font-semibold tracking-[-0.01em] text-accent">
                  <CardLink href={risk.detailHref} className={STRETCH_XL}>{risk.title}</CardLink>
                </h3>
                <p className="mt-1.5 text-[0.6875rem] text-ink-muted">
                  {risk.family} · {risk.periodLabel}{risk.recurring ? ` · seen since ${risk.firstSeenLabel}` : null}
                </p>
                <p className="mt-4 mb-[1.125rem] text-[0.75rem] leading-[1.85] text-ink-muted">{risk.whatHappened}</p>
                {risk.whatYouCanDo || risk.whyItMatters ? (
                  <div className="mt-auto border-t border-line pt-3">
                    <Eyebrow tone="accent">{risk.whatYouCanDo ? 'Focus' : 'Why it matters'}</Eyebrow>
                    <p className="mt-1 text-[0.6875rem] leading-[1.8] text-ink-muted">{risk.whatYouCanDo ?? risk.whyItMatters}</p>
                  </div>
                ) : null}
                {risk.evidenceHref ? (
                  <Link href={risk.evidenceHref} className={`${ABOVE_CARD_LINK} mt-3 inline-flex w-fit items-center gap-0.5 text-[0.6875rem] font-semibold text-blue-ink hover:text-accent ${TOUCH_TARGET}`}>
                    Why? <ChevronRight aria-hidden="true" className="size-3.5" />
                  </Link>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const PANEL_TONE: Readonly<Record<'plain' | 'tinted' | 'growth' | 'blush', string>> = {
  plain: 'border-line bg-surface',
  // The reference's light-blue insight card.
  tinted: 'border-line bg-pink-soft',
  // The reference's "How can I Grow?" card: a blue wash fading to white.
  growth: 'border-line bg-[linear-gradient(135deg,var(--color-pink-soft),var(--color-surface)_75%)] shadow-[0_4px_22px_rgb(30_109_184/0.03)]',
  // The reference's pink feedback card.
  blush: 'border-line bg-accent-soft',
};

/**
 * A lobby card with a band label and a title, as the reference's chart and insight cards. A `serif`
 * title is the reference's Georgia display heading in deep blue.
 */
export function LobbyPanel({
  id, eyebrow, title, end, children, tone = 'plain', serif = false, className = '',
}: {
  id: string; eyebrow: string; title: ReactNode; end?: ReactNode; children: ReactNode;
  tone?: 'plain' | 'tinted' | 'growth' | 'blush'; serif?: boolean; className?: string;
}) {
  return (
    <section aria-labelledby={id} className={`min-w-0 rounded-xl border p-5 sm:p-6 ${PANEL_TONE[tone]} ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h2
            id={id}
            className={serif
              ? `mt-3 text-[1.5rem] leading-[1.2] sm:text-[1.625rem] ${SERIF_TITLE}`
              : 'mt-1.5 text-[1.0625rem] font-semibold tracking-[-0.012em] text-ink'}
          >
            {title}
          </h2>
        </div>
        {end}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * The Business Health Score as the reference's "Revenue mix" donut: the score in the middle, its
 * band and change beside it as the mix rows, and the SOW §9 disclaimer, which is never left off a
 * screen showing the score.
 */
export function HealthRing({
  view, comparisonLabel, explainHref,
}: { view: HealthCardView; comparisonLabel: string | null; explainHref: string }) {
  const note = dimensionsNote(view.dimensionsUsed, view.dimensionsTotal);
  if (view.score === null) {
    return (
      <div>
        <p className="text-sm text-ink">{NOT_ENOUGH_DATA_TITLE}</p>
        <p className="mt-1 text-[0.75rem] text-ink-muted">{NOT_ENOUGH_DATA_BODY}</p>
        <p className="mt-4 text-[0.6875rem] text-ink-faint">{HEALTH_DISCLAIMER}</p>
      </div>
    );
  }
  const radius = 44;
  const ring = scoreRingDash(view.score, radius);
  const tone = changeTone(view.changeVsPrevious);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-6">
        <div className="relative size-28 shrink-0">
          <svg viewBox="0 0 112 112" aria-hidden="true" className="size-full -rotate-90">
            <circle cx="56" cy="56" r={radius} fill="none" strokeWidth="11" className="stroke-pink" />
            <circle cx="56" cy="56" r={radius} fill="none" strokeWidth="11" strokeDasharray={ring.dash} strokeLinecap="butt" className="stroke-accent" />
          </svg>
          <p className="absolute inset-0 flex flex-col items-center justify-center leading-none">
            <span className="text-[1.25rem] font-semibold tracking-[-0.04em] text-ink tabular-nums">{view.score}</span>
            <span className="mt-1.5 text-[0.625rem] text-ink-muted">out of 100</span>
          </p>
        </div>
        <dl className="min-w-0 flex-1 text-[0.75rem]">
          <div className="my-3 flex items-center gap-2">
            <dt className="flex items-center gap-2 text-ink-muted"><span aria-hidden="true" className="size-[5px] rounded-[2px] bg-accent" />Band</dt>
            <dd className="ml-auto font-semibold whitespace-nowrap text-ink">{bandText(view.band)}</dd>
          </div>
          <div className="my-3 flex items-center gap-2">
            <dt className="flex items-center gap-2 text-ink-muted"><span aria-hidden="true" className="size-[5px] rounded-[2px] bg-pink" />Change</dt>
            <dd className={`ml-auto font-semibold whitespace-nowrap tabular-nums ${CHANGE_TONE_CLASS[tone]}`}>{changeText(view.changeVsPrevious, comparisonLabel)}</dd>
          </div>
          <div className="my-3 flex items-center gap-2">
            <dt className="flex items-center gap-2 text-ink-muted"><span aria-hidden="true" className="size-[5px] rounded-[2px] bg-line-strong" />Areas scored</dt>
            <dd className="ml-auto font-semibold whitespace-nowrap text-ink tabular-nums">{view.dimensionsUsed} of {view.dimensionsTotal}</dd>
          </div>
        </dl>
      </div>
      {note ? <p className="mt-3 text-[0.6875rem] text-ink-faint">{note}</p> : null}
      {view.capped ? <p className="mt-1 text-[0.6875rem] text-ink-muted">{PROXY_CAP_NOTE}</p> : null}
      <ArrowLink href={explainHref} className="mt-3">What makes up this score?</ArrowLink>
      <p className="mt-2 text-[0.6875rem] text-ink-faint">{HEALTH_DISCLAIMER}</p>
    </div>
  );
}

/**
 * "Priorities & observations": the open actions as the reference's queue — an icon well, the action,
 * its priority and date, a tag for its state. Each row opens its action.
 */
export function ActionQueue({
  actions, today, actionHref, icon,
}: { actions: readonly Action[]; today: string; actionHref: (id: string) => string; icon: ReactNode }) {
  return (
    <ul className="border-b border-line">
      {actions.map((action) => {
        const overdue = action.dueDate !== null && action.dueDate < today;
        return (
          <li key={action.id} className="group relative flex items-center gap-2.5 border-t border-line py-4 first:border-t-0 hover:bg-surface-sunken">
            <span aria-hidden="true" className="flex size-[1.625rem] shrink-0 items-center justify-center rounded-[0.4375rem] border border-accent/20 bg-surface-sunken text-accent [&_svg]:size-[0.9375rem]">{icon}</span>
            <span className="min-w-0 flex-1">
              <Link href={actionHref(action.id)} className="block text-[0.75rem] leading-[1.6] font-medium text-ink [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] group-hover:text-accent">
                {action.title}
              </Link>
              <span className="mt-0.5 block text-[0.6875rem] leading-[1.6] text-ink-muted">
                {priorityLabel(action.priority)} priority · {action.ownerName ?? 'No owner'} · {action.dueDate === null ? 'No date' : `Due ${formatDate(action.dueDate)}`}
              </span>
            </span>
            <span className={`shrink-0 rounded px-2 py-1 text-[0.625rem] whitespace-nowrap ${overdue ? 'bg-accent-soft text-danger' : action.status === 'in_progress' ? 'bg-warn-soft text-warn' : 'bg-good-soft text-good'}`}>
              {overdue ? 'Overdue' : action.status === 'in_progress' ? 'In progress' : 'Open'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export interface NextMove {
  readonly key: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly line: string;
  readonly href: string;
  readonly cta: string;
  readonly icon: ReactNode;
}

/**
 * "Make the next move." — the reference's operations panel: one card per workspace the reader may
 * open, each a serif title, a line on what it is for, and a full-width button that opens it.
 */
export function NextMovePanel({ moves }: { moves: readonly NextMove[] }) {
  if (moves.length === 0) return null;
  return (
    <section aria-labelledby="lobby-next-move" className="rounded-[0.875rem] border border-line bg-surface p-5 sm:p-[1.375rem]">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Eyebrow>APX intelligence · Operations · Targets</Eyebrow>
          <h2 id="lobby-next-move" className={`mt-2.5 text-[1.625rem] leading-[1.2] sm:text-[1.8125rem] ${SERIF_TITLE}`}>Make the next move.</h2>
          <p className="mt-2 text-[0.75rem] leading-[1.8] text-ink-muted">Connect the work, ask better questions and keep each month’s progress visible.</p>
        </div>
      </div>
      <ul className={`mt-5 grid gap-4 sm:grid-cols-2 ${moves.length >= 4 ? 'xl:grid-cols-4' : moves.length === 3 ? 'xl:grid-cols-3' : ''}`}>
        {moves.map((move, index) => (
          <li key={move.key} className="min-w-0">
            <article className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface">
              <div className="border-b border-line px-[1.0625rem] pt-4 pb-3">
                <p className="text-[0.5625rem] font-semibold tracking-[0.13em] text-ink-muted uppercase">
                  {String(index + 1).padStart(2, '0')} / {move.eyebrow}
                </p>
                <h3 className={`mt-2 text-[1.3125rem] leading-[1.2] ${SERIF_TITLE}`}>{move.title}</h3>
              </div>
              <div className="flex flex-1 items-start gap-3 bg-[linear-gradient(145deg,var(--color-surface),var(--color-surface-sunken))] px-[1.0625rem] py-4">
                <span aria-hidden="true" className="flex size-[1.875rem] shrink-0 items-center justify-center rounded-lg bg-pink-soft text-pink-icon [&_svg]:size-[1.0625rem]">{move.icon}</span>
                <p className="text-[0.75rem] leading-[1.7] text-ink-muted">{move.line}</p>
              </div>
              <div className="px-[0.9375rem] pt-3.5 pb-4">
                <Link
                  href={move.href}
                  className="flex min-h-[2.375rem] w-full items-center justify-center gap-2.5 rounded-md bg-accent px-3 py-2.5 text-[0.75rem] font-medium text-on-accent transition-colors hover:bg-accent-hover"
                >
                  {move.cta} <ArrowRight aria-hidden="true" className="size-3.5" />
                </Link>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The lobby's last line, as the reference's footer. */
export function LobbyFooter({ line }: { line: string }) {
  return (
    <footer className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-5 pb-6 text-[0.6875rem] text-ink-muted">
      <p className="flex flex-wrap items-center gap-1.5">
        <span className="mr-2 font-semibold tracking-[0.18em] text-ink">APX</span>Finance in motion.
      </p>
      <p className="flex items-center gap-2"><span aria-hidden="true" className="size-1 rounded-full bg-accent/60" />{line}</p>
    </footer>
  );
}
