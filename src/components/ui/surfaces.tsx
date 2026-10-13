import type { ReactNode } from 'react';
import { ButtonLink } from './button';
import {
  Alert, AlertDescription, AlertTitle, Badge as ShadcnBadge, Card as ShadcnCard, CardAction, CardContent,
  CardDescription, CardHeader as ShadcnCardHeader, CardTitle, Skeleton as ShadcnSkeleton,
} from './shadcn';

/* MOTION's surfaces, on shadcn/ui (SOW §6; ADR-151): the same names and props as before. */

/** A white panel with a soft violet shadow (ADR-155). */
export function Card({ children, className = '', id }: { children: ReactNode; className?: string; id?: string }) {
  return <ShadcnCard id={id} className={className}>{children}</ShadcnCard>;
}

export function CardHeader({
  title,
  description,
  action,
  icon,
  tint = 'violet',
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** A tinted icon tile before the title, as the reference's cards (ADR-155). Decorative. */
  icon?: ReactNode;
  tint?: IconTint;
}) {
  return (
    <ShadcnCardHeader>
      <div className="flex min-w-0 gap-3.5">
        {icon ? <IconBadge tint={tint}>{icon}</IconBadge> : null}
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
      </div>
      {action ? <CardAction>{action}</CardAction> : null}
    </ShadcnCardHeader>
  );
}

export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <CardContent className={className}>{children}</CardContent>;
}

/**
 * The page title band, as the reference's "Your departments" header (ADR-155). The title steps down
 * a size on a phone, and a long unbroken word in it (a bank reference, a file name) wraps rather than
 * widening the page.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-accent">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-3xl break-words sm:text-4xl md:text-5xl">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-3xl text-base break-words text-ink-muted sm:text-lg md:text-xl">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex min-w-0 max-w-full flex-wrap gap-3">{action}</div> : null}
    </header>
  );
}

export type IconTint = 'violet' | 'pink';

/** A tinted rounded tile holding an icon, as the reference's cards. Decorative. */
export function IconBadge({ tint = 'violet', size = 'md', children }: { tint?: IconTint; size?: 'sm' | 'md' | 'lg'; children: ReactNode }) {
  const tone = tint === 'pink' ? 'bg-pink-soft text-pink-icon' : 'bg-accent-soft text-accent';
  const box = size === 'lg' ? 'size-14 rounded-2xl [&_svg]:size-7' : size === 'md' ? 'size-11 rounded-xl [&_svg]:size-6' : 'size-9 rounded-xl [&_svg]:size-5';
  return <span aria-hidden="true" className={`flex shrink-0 items-center justify-center ${tone} ${box}`}>{children}</span>;
}

/** A figure in a white tile with its icon, as the reference's stat tiles (portfolio overview etc.). */
export function StatTile({
  label,
  value,
  icon,
  tint = 'violet',
  valueClassName = 'text-ink',
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tint?: IconTint;
  valueClassName?: string;
}) {
  return (
    <div className="panel flex items-center gap-3.5 rounded-card p-4">
      {icon ? <IconBadge tint={tint}>{icon}</IconBadge> : null}
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-[0.1em] text-ink-muted">{label}</p>
        <p className={`mt-0.5 font-mono text-2xl tabular-nums break-words ${valueClassName}`}>{value}</p>
      </div>
    </div>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'warn' | 'danger';

const BADGE_VARIANT = { neutral: 'default', accent: 'accent', warn: 'warn', danger: 'destructive' } as const;

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: BadgeTone;
}) {
  return <ShadcnBadge variant={BADGE_VARIANT[tone]}>{children}</ShadcnBadge>;
}

export type BannerTone = 'info' | 'warn' | 'danger';

const BANNER_VARIANT = { info: 'default', warn: 'warn', danger: 'destructive' } as const;

export function Banner({
  tone = 'info',
  title,
  children,
}: {
  tone?: BannerTone;
  title: string;
  children?: ReactNode;
}) {
  return (
    <Alert variant={BANNER_VARIANT[tone]}>
      <AlertTitle>{title}</AlertTitle>
      {children ? <AlertDescription>{children}</AlertDescription> : null}
    </Alert>
  );
}

/**
 * Every list and page has a first-run state that says what will appear here, what to do, and one
 * button that does it (UX_ARCHITECTURE.md §6).
 */
export function EmptyState({
  title,
  children,
  actionHref,
  actionLabel,
  secondary,
}: {
  title: string;
  children: ReactNode;
  actionHref?: string;
  actionLabel?: string;
  secondary?: ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-line-strong bg-surface px-4 py-10 text-center sm:px-6">
      <h2 className="text-lg">{title}</h2>
      <div className="mx-auto mt-2 max-w-prose text-sm text-ink-muted">{children}</div>
      {actionHref && actionLabel ? (
        <div className="mt-5">
          <ButtonLink href={actionHref}>{actionLabel}</ButtonLink>
        </div>
      ) : null}
      {secondary ? <div className="mt-3 text-sm text-ink-muted">{secondary}</div> : null}
    </div>
  );
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <ShadcnSkeleton className={className} />;
}

/**
 * Label/value pairs, used for read-only detail (organisation, profile, assignment). On a phone the
 * label sits above its value; from `sm` up, beside it.
 */
export function DetailList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="divide-y divide-line">
      {items.map((item) => (
        <div key={item.label} className="flex flex-wrap gap-x-6 gap-y-1 py-2.5 first:pt-0 last:pb-0">
          <dt className="w-full shrink-0 text-sm text-ink-muted sm:w-44">{item.label}</dt>
          <dd className="min-w-0 text-sm break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
