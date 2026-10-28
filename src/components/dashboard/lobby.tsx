import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, ChevronRight, LayoutGrid, Plus } from 'lucide-react';
import type { AlertView, MetricCardView } from '@/modules/dashboard';
import type { HealthCardView } from '@/modules/health';
import type { Action } from '@/modules/actions';
import { ABOVE_CARD_LINK, CardLink, TOUCH_TARGET } from '@/components/ui/clickable-card';
import { severityLabel } from './alert-presentation';
import { priorityLabel } from './action-card';
import {
  CHANGE_TONE_CLASS, HEALTH_DISCLAIMER, NOT_ENOUGH_DATA_BODY, NOT_ENOUGH_DATA_TITLE, PROXY_CAP_NOTE,
  bandText, changeText, changeTone, dimensionsNote, scoreRingDash,
} from './health-presentation';
import { SPARK_BOX, sparklineRuns, type TrendSeriesView } from './presentation';

/**
 * The client lobby (ADR-176), in the owner's second reference: a light page of quiet cards under the
 * unchanged APX bar — the departments in a row, the greeting, then the analysis in numbered bands.
 *
 * Every figure, label and sentence arrives from a view model; these components only lay them out.
 * The palette is `.theme-lobby` (globals.css), so the tokens used here are the lobby's own.
 */

/** A lobby card: white, a warm hairline, soft corners, no shadow — as the reference. */
export const LOBBY_CARD = 'rounded-xl border border-line bg-surface';

/** A lobby card that opens something: the reference's quiet hover, in place of the dark glow. */
export const LOBBY_CLICKABLE =
  'group relative transition-[box-shadow,border-color] duration-200 hover:border-accent/40 hover:shadow-[0_10px_28px_-18px_rgb(140_36_60/0.45)] focus-within:border-accent/60 focus-within:shadow-[0_0_0_2px_rgb(183_46_61/0.35)]';

const STRETCH_XL = 'after:rounded-xl';

/**
 * The light canvas, around every page of a company (the org layout). It runs to the shell's edges (the main column's padding is taken back) and,
 * through a clipped spread shadow, to the window's sides on a screen wider than the column.
 */
export function LobbyCanvas({ children }: { children: ReactNode }) {
  return (
    <div className="theme-lobby -mx-4 -my-6 min-h-[calc(100vh-4rem)] px-4 pt-6 pb-10 [box-shadow:0_0_0_100vmax_var(--color-paper)] [clip-path:inset(0_-100vmax)] sm:-mx-6 sm:px-6 lg:-mx-8 lg:-my-8 lg:px-8 lg:pt-8">
      {children}
    </div>
  );
}

/** The small capitals over a heading: "YOUR NEXT MOVES". */
export function Eyebrow({ children, tone = 'muted', as: Tag = 'p' }: { children: ReactNode; tone?: 'muted' | 'accent'; as?: 'p' | 'span' }) {
  return (
    <Tag className={`text-[0.625rem] font-semibold tracking-[0.2em] uppercase ${tone === 'accent' ? 'text-accent' : 'text-ink-muted'}`}>
      {children}
    </Tag>
  );
}

/** The reference's red full stop after a heading. Decorative. */
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
 * "More apps" — every department — last. Numbered as the reference; the count is of real tiles.
 */
export function DepartmentStrip({
  departments, currentKey, moreHref,
}: { departments: readonly LobbyDepartment[]; currentKey: string; moreHref: string | null }) {
  return (
    <nav aria-labelledby="lobby-departments" className="border-b border-line pb-6">
      <div className="flex items-baseline gap-4">
        <h2 id="lobby-departments"><Eyebrow as="span">Your departments</Eyebrow></h2>
        <span className="text-[0.625rem] font-semibold tracking-[0.2em] text-ink-faint uppercase">
          {String(departments.length).padStart(2, '0')} active
        </span>
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-3 min-[30rem]:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        {departments.map((department, index) => {
          const current = department.key === currentKey;
          return (
            <li key={department.key} className="min-w-0">
              <Link
                href={department.href}
                aria-current={current ? 'page' : undefined}
                className={`relative flex h-full min-w-0 items-center gap-3 overflow-hidden rounded-[0.625rem] border px-4 py-3 transition-[border-color,box-shadow] duration-200 ${
                  current
                    ? 'border-accent/45 bg-[linear-gradient(115deg,var(--color-accent-soft),var(--color-surface))]'
                    : 'border-line bg-surface hover:border-accent/40 hover:shadow-[0_10px_28px_-18px_rgb(140_36_60/0.45)]'
                }`}
              >
                <span aria-hidden="true" className={`flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-[1.125rem] ${current ? 'bg-accent text-on-accent' : 'bg-accent-soft text-accent'}`}>
                  {department.icon}
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm font-semibold text-ink">{department.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-ink-muted">{department.line}</span>
                </span>
                <span aria-hidden="true" className="self-start text-[0.625rem] tracking-[0.15em] text-ink-faint">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {current ? <span aria-hidden="true" className="absolute inset-x-5 bottom-0 h-[3px] rounded-t-full bg-accent" /> : null}
              </Link>
            </li>
          );
        })}
        {moreHref ? (
          <li className="min-w-0">
            <Link
              href={moreHref}
              className="flex h-full min-w-0 items-center gap-3 rounded-[0.625rem] border border-dashed border-line-strong bg-surface-sunken px-4 py-3 transition-colors hover:border-accent/50"
            >
              <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent [&_svg]:size-[1.125rem]">
                <LayoutGrid />
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-sm font-semibold text-ink">More apps</span>
                <span className="mt-0.5 block truncate text-xs text-ink-muted">Every department</span>
              </span>
              <Plus aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
            </Link>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}

/** "Workspace / Financial Analysis", the greeting, and the company it is about. */
export function LobbyHero({
  section, greeting, orgName, orgLine,
}: { section: string; greeting: string; orgName: string; orgLine: string }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-6 pt-6">
      <div className="min-w-0">
        <p className="flex items-center gap-3 text-[0.625rem] tracking-[0.2em] text-ink-muted uppercase">
          Workspace <span aria-hidden="true">/</span>
          <span className="text-xs tracking-normal text-ink normal-case">{section}</span>
        </p>
        <h1 className="mt-3 text-[1.75rem] leading-tight font-normal tracking-[-0.01em] sm:text-[2rem]">
          Clarity today.{' '}
          <em className="font-[family-name:var(--lobby-serif)] font-normal text-accent">Confidence tomorrow.</em>
        </h1>
        <p className="mt-2 text-sm text-ink-muted">{greeting}</p>
      </div>
      <div className={`flex min-w-0 items-center gap-3 px-3 py-2.5 ${LOBBY_CARD}`}>
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line text-sm font-semibold text-accent">
          {orgName.trim().slice(0, 1).toUpperCase() || 'A'}
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-semibold text-ink">{orgName}</span>
          <span className="mt-0.5 block truncate text-xs text-ink-muted">{orgLine}</span>
        </span>
      </div>
    </header>
  );
}

/** A numbered band's heading: "01 / UNDERSTAND YOUR PERFORMANCE", then the title with its red stop. */
export function BandHeading({
  id, number, eyebrow, title, end,
}: { id: string; number: string; eyebrow: string; title: string; end?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <Eyebrow>{number} / {eyebrow}</Eyebrow>
        <h2 id={id} className="mt-2 text-[1.75rem] leading-tight font-semibold tracking-[-0.02em] text-ink">
          {title}<Stop />
        </h2>
      </div>
      {end ? <div className="flex flex-wrap items-center gap-2">{end}</div> : null}
    </div>
  );
}

/** A quiet text link with an arrow, as the reference's "Explore the insight →". */
export function ArrowLink({ href, children, className = '' }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={`inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:text-accent-hover ${TOUCH_TARGET} ${className}`}>
      {children} <ArrowRight aria-hidden="true" className="size-4" />
    </Link>
  );
}

/** A chip in a band's corner: the period, the basis. */
export function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-md bg-accent-soft px-2.5 py-1 text-xs text-accent">{children}</span>;
}

const STATUS_CHIP: Readonly<Record<string, string>> = {
  check: 'bg-warn-soft text-warn',
  partial: 'bg-warn-soft text-warn',
  estimate: 'bg-surface-sunken text-ink-muted',
};

/**
 * A headline figure, the reference's way: the label, the figure large, the change in colour under it,
 * and its last twelve months as a small line in the corner. The whole card opens the figure's
 * evidence ("Why?"), for a reader who may open it (ADR-172).
 */
export function LobbyFigure({ card, trend, showWhy }: { card: MetricCardView; trend: TrendSeriesView | null; showWhy: boolean }) {
  const runs = trend ? sparklineRuns(trend) : [];
  const tone = !card.change || card.change.basisDiffers || card.change.favourable === null ? 'text-ink-muted'
    : card.change.favourable ? 'text-good' : 'text-danger';
  return (
    <article className={`@container flex h-full flex-col px-6 py-5 ${LOBBY_CARD} ${showWhy ? LOBBY_CLICKABLE : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-[0.8125rem] font-normal tracking-normal text-ink-muted">{card.label}</h3>
        {card.status.kind !== 'none' && card.status.label !== null ? (
          <span title={card.status.tooltip} className={`${ABOVE_CARD_LINK} shrink-0 rounded-md px-2 py-0.5 text-[0.6875rem] ${STATUS_CHIP[card.status.kind] ?? 'bg-surface-sunken text-ink-muted'}`}>
            {card.status.label}
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-[1.75rem] leading-none font-medium tracking-[-0.03em] break-words text-ink tabular-nums @[16rem]:text-[2.125rem]">
        {card.value}
      </p>
      {card.secondaryLine ? (
        <p className="mt-2 text-xs text-ink-muted">
          {card.secondaryLine.label}: <span className="tabular-nums">{card.secondaryLine.value}</span>
        </p>
      ) : null}
      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <div className="min-w-0">
          {!card.change ? (
            <p className="text-xs text-ink-faint">no comparison yet</p>
          ) : card.change.basisDiffers ? (
            <p className="text-xs text-ink-faint"><span className="tabular-nums">{card.change.amount}</span> compared on a different basis</p>
          ) : (
            <p className={`text-xs font-semibold tabular-nums ${tone}`}>{card.change.text}</p>
          )}
          {showWhy ? (
            <CardLink
              href={card.whyHref}
              title={[card.technicalLabel, card.basisText].filter(Boolean).join(' · ') || undefined}
              className={`mt-1.5 inline-flex items-center gap-0.5 text-xs text-ink-muted group-hover:text-accent ${STRETCH_XL}`}
            >
              Why? <ChevronRight aria-hidden="true" className="size-3.5" />
            </CardLink>
          ) : card.basisText ? (
            <p className="mt-1.5 text-xs text-ink-faint">{card.basisText}</p>
          ) : null}
        </div>
        {runs.length > 0 ? (
          <svg aria-hidden="true" viewBox={`0 0 ${SPARK_BOX.width} ${SPARK_BOX.height}`} className="h-9 w-24 shrink-0 overflow-visible">
            {runs.map((points) => (
              <polyline key={points} points={points} fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="stroke-pink" />
            ))}
          </svg>
        ) : null}
      </div>
    </article>
  );
}

/**
 * "Top risks" in the reference's report-points panel: a tinted band of up to three numbered cards,
 * each opening its alert. Highest severity first, as the service ordered them.
 */
export function RiskPoints({ risks, allHref, periodLabel }: { risks: readonly AlertView[]; allHref: string; periodLabel: string }) {
  return (
    <section aria-labelledby="lobby-risks" className="rounded-xl border border-line-strong bg-[linear-gradient(115deg,var(--color-surface-sunken),var(--color-surface))] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow tone="accent">From your alerts</Eyebrow>
          <h2 id="lobby-risks" className="mt-2 text-xl font-semibold tracking-[-0.01em] text-ink">
            {risks.length === 0 ? 'Nothing needs your attention' : risks.length === 1 ? 'One point to look at' : `${risks.length === 2 ? 'Two' : 'Three'} points to look at`}<Stop />
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Chip>{periodLabel}</Chip>
          <ArrowLink href={allHref}>See all alerts</ArrowLink>
        </div>
      </div>
      {risks.length === 0 ? (
        <p className="mt-3 max-w-prose text-sm text-ink-muted">No open alerts. APX checks again after every calculation.</p>
      ) : (
        <ul className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {risks.map((risk, index) => (
            <li key={risk.id} className="min-w-0">
              <article className={`flex h-full flex-col p-5 ${LOBBY_CARD} ${LOBBY_CLICKABLE}`}>
                <div className="flex items-start justify-between gap-3">
                  <span aria-hidden="true" className="text-xs tracking-[0.2em] text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                  <span title={risk.thresholdNote ?? undefined} className={`${ABOVE_CARD_LINK} rounded px-2 py-0.5 text-[0.6875rem] ${risk.severity === 'critical' || risk.severity === 'high' ? 'bg-accent-soft text-accent' : risk.severity === 'medium' ? 'bg-warn-soft text-warn' : 'bg-surface-sunken text-ink-muted'}`}>
                    {severityLabel(risk.severity)}
                  </span>
                </div>
                <h3 className="mt-4 text-[0.9375rem] font-semibold tracking-normal text-[color:var(--lobby-wine)]">
                  <CardLink href={risk.detailHref} className={STRETCH_XL}>{risk.title}</CardLink>
                </h3>
                <p className="mt-1 text-xs text-ink-muted">
                  {risk.family} · {risk.periodLabel}{risk.recurring ? ` · seen since ${risk.firstSeenLabel}` : null}
                </p>
                <p className="mt-4 text-sm leading-relaxed text-ink-muted">{risk.whatHappened}</p>
                {risk.whatYouCanDo || risk.whyItMatters ? (
                  <div className="mt-auto border-t border-line pt-4">
                    <Eyebrow tone="accent">{risk.whatYouCanDo ? 'What you can do' : 'Why it matters'}</Eyebrow>
                    <p className="mt-1.5 text-sm text-ink-muted">{risk.whatYouCanDo ?? risk.whyItMatters}</p>
                  </div>
                ) : null}
                {risk.evidenceHref ? (
                  <Link href={risk.evidenceHref} className={`${ABOVE_CARD_LINK} mt-4 inline-flex w-fit items-center gap-0.5 text-xs font-semibold text-accent hover:text-accent-hover ${TOUCH_TARGET}`}>
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

/** A lobby card with a band label and a title, as the reference's "Performance over time" card. */
export function LobbyPanel({
  id, eyebrow, title, end, children, tone = 'plain', className = '',
}: {
  id: string; eyebrow: string; title: ReactNode; end?: ReactNode; children: ReactNode;
  /** `tinted` is the reference's pink "APX perspective" card. */
  tone?: 'plain' | 'tinted'; className?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`min-w-0 rounded-xl border p-5 sm:p-6 ${tone === 'tinted' ? 'border-accent/15 bg-accent-soft' : 'border-line bg-surface'} ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow tone={tone === 'tinted' ? 'accent' : 'muted'}>{eyebrow}</Eyebrow>
          <h2 id={id} className="mt-2 text-xl font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        </div>
        {end}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * The Business Health Score as the reference's ring: the score in the middle, its band and change
 * beside it, and the SOW §9 disclaimer, which is never left off a screen showing the score.
 */
export function HealthRing({
  view, comparisonLabel, explainHref,
}: { view: HealthCardView; comparisonLabel: string | null; explainHref: string }) {
  const note = dimensionsNote(view.dimensionsUsed, view.dimensionsTotal);
  if (view.score === null) {
    return (
      <div>
        <p className="text-base text-ink">{NOT_ENOUGH_DATA_TITLE}</p>
        <p className="mt-1 text-sm text-ink-muted">{NOT_ENOUGH_DATA_BODY}</p>
        <p className="mt-4 text-xs text-ink-faint">{HEALTH_DISCLAIMER}</p>
      </div>
    );
  }
  const radius = 44;
  const ring = scoreRingDash(view.score, radius);
  const tone = changeTone(view.changeVsPrevious);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-6">
        <div className="relative size-32 shrink-0">
          <svg viewBox="0 0 112 112" aria-hidden="true" className="size-full -rotate-90">
            <circle cx="56" cy="56" r={radius} fill="none" strokeWidth="12" className="stroke-pink-soft" />
            <circle cx="56" cy="56" r={radius} fill="none" strokeWidth="12" strokeDasharray={ring.dash} strokeLinecap="butt" className="stroke-accent" />
          </svg>
          <p className="absolute inset-0 flex flex-col items-center justify-center leading-none">
            <span className="text-2xl font-semibold text-ink tabular-nums">{view.score}</span>
            <span className="mt-1 text-[0.625rem] text-ink-muted">out of 100</span>
          </p>
        </div>
        <dl className="min-w-0 flex-1 space-y-2 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="flex items-center gap-2 text-ink-muted"><span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />Band</dt>
            <dd className="font-semibold text-ink">{bandText(view.band)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="flex items-center gap-2 text-ink-muted"><span aria-hidden="true" className="size-1.5 rounded-full bg-pink" />Change</dt>
            <dd className={`font-semibold tabular-nums ${CHANGE_TONE_CLASS[tone]}`}>{changeText(view.changeVsPrevious, comparisonLabel)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="flex items-center gap-2 text-ink-muted"><span aria-hidden="true" className="size-1.5 rounded-full bg-line-strong" />Areas scored</dt>
            <dd className="font-semibold text-ink tabular-nums">{view.dimensionsUsed} of {view.dimensionsTotal}</dd>
          </div>
        </dl>
      </div>
      {note ? <p className="mt-3 text-xs text-ink-faint">{note}</p> : null}
      {view.capped ? <p className="mt-1 text-xs text-ink-muted">{PROXY_CAP_NOTE}</p> : null}
      <ArrowLink href={explainHref} className="mt-4">What makes up this score?</ArrowLink>
      <p className="mt-3 text-xs text-ink-faint">{HEALTH_DISCLAIMER}</p>
    </div>
  );
}

/**
 * "Your next moves": the open actions as the reference's queue — an icon, the action, its priority
 * and date, a chip for its state, and an arrow. Each row opens its action.
 */
export function ActionQueue({
  actions, today, actionHref, icon,
}: { actions: readonly Action[]; today: string; actionHref: (id: string) => string; icon: ReactNode }) {
  return (
    <ul className="divide-y divide-line border-b border-line">
      {actions.map((action) => {
        const overdue = action.dueDate !== null && action.dueDate < today;
        return (
          <li key={action.id} className="group relative flex items-center gap-4 py-4">
            <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-sunken text-accent [&_svg]:size-4">{icon}</span>
            <span className="min-w-0 flex-1">
              <Link href={actionHref(action.id)} className="block font-semibold text-ink [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] group-hover:text-accent">
                {action.title}
              </Link>
              <span className="mt-0.5 block text-xs text-ink-muted">
                {priorityLabel(action.priority)} priority · {action.ownerName ?? 'No owner'} · {action.dueDate === null ? 'No date' : `Due ${action.dueDate}`}
              </span>
            </span>
            <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs ${overdue ? 'bg-accent-soft text-accent' : action.status === 'in_progress' ? 'bg-warn-soft text-warn' : 'bg-surface-sunken text-ink-muted'}`}>
              {overdue ? 'Overdue' : action.status === 'in_progress' ? 'In progress' : 'Open'}
            </span>
            <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-ink-faint group-hover:text-accent" />
          </li>
        );
      })}
    </ul>
  );
}

/** The lobby's last line, as the reference's footer. */
export function LobbyFooter({ line }: { line: string }) {
  return (
    <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-xs text-ink-muted">
      <p><span className="font-semibold tracking-[0.2em] text-ink">APX</span><span className="ml-3">Finance in motion.</span></p>
      <p className="flex items-center gap-2"><span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />{line}</p>
    </footer>
  );
}
