import type { ReactNode } from 'react';
import { ButtonLink } from './button';

/** A white surface on paper with a single hairline. Elevation comes from the border, never a shadow. */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-card border border-line bg-surface ${className}`.trim()}>
      {children}
    </section>
  );
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
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-base">{title}</h2>
        {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`px-5 py-4 ${className}`.trim()}>{children}</div>;
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
          <p className="mb-1 text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-2xl md:text-3xl">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'warn' | 'danger';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunken text-ink-muted border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
};

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export type BannerTone = 'info' | 'warn' | 'danger';

const BANNER_TONES: Record<BannerTone, string> = {
  info: 'border-line bg-surface-sunken text-ink',
  warn: 'border-warn/40 bg-warn-soft text-ink',
  danger: 'border-danger/40 bg-danger-soft text-ink',
};

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
    <div className={`rounded-card border px-4 py-3 text-sm ${BANNER_TONES[tone]}`} role="status">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 text-ink-muted">{children}</div> : null}
    </div>
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
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
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
