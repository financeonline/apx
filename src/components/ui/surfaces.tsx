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
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <ShadcnCardHeader>
      <div className="min-w-0">
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </div>
      {action ? <CardAction>{action}</CardAction> : null}
    </ShadcnCardHeader>
  );
}

export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <CardContent className={className}>{children}</CardContent>;
}

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
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-accent">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-3xl md:text-4xl">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-base text-ink-muted md:text-lg">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
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
    <div className="rounded-card border border-dashed border-line-strong bg-surface px-6 py-10 text-center">
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

/** Label/value pairs, used for read-only detail (organisation, profile, assignment). */
export function DetailList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="divide-y divide-line">
      {items.map((item) => (
        <div key={item.label} className="flex flex-wrap gap-x-6 gap-y-1 py-2.5 first:pt-0 last:pb-0">
          <dt className="w-44 shrink-0 text-sm text-ink-muted">{item.label}</dt>
          <dd className="min-w-0 text-sm">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
