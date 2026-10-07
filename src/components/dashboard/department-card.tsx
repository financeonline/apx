import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * A department card (ADR-155), the owner's reference template: a tinted icon tile, a bold title,
 * what the department covers, its own figures, quick links as pills, and a footer with a status
 * dot and "Open". Every figure and status comes from the caller's view model; nothing here is
 * computed or invented.
 */

export type CardTint = 'violet' | 'pink';
export type CardStatus = 'good' | 'attention' | 'quiet';

const TINT: Readonly<Record<CardTint, string>> = {
  violet: 'bg-accent-soft text-accent',
  pink: 'bg-pink-soft text-pink-icon',
};

const DOT: Readonly<Record<CardStatus, string>> = {
  good: 'bg-good-dot',
  attention: 'bg-warn-dot',
  quiet: 'bg-line-strong',
};

const STATUS_TEXT: Readonly<Record<CardStatus, string>> = {
  good: 'text-good',
  attention: 'text-warn',
  quiet: 'text-ink-muted',
};

export function IconTile({ tint, children, size = 'lg' }: { tint: CardTint; children: ReactNode; size?: 'lg' | 'sm' }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center ${TINT[tint]} ${
        size === 'lg' ? 'size-14 rounded-2xl [&_svg]:size-7' : 'size-10 rounded-xl [&_svg]:size-5'
      }`}
    >
      {children}
    </span>
  );
}

export function StatusDot({ status, label }: { status: CardStatus; label: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-sm font-medium ${STATUS_TEXT[status]}`}>
      <span aria-hidden="true" className={`size-2.5 rounded-full ${DOT[status]}`} />
      {label}
    </span>
  );
}

export function DepartmentCard({
  title,
  href,
  icon,
  tint,
  description,
  headline,
  lines = [],
  pills = [],
  status,
  featured = false,
}: {
  title: string;
  href: string;
  icon: ReactNode;
  tint: CardTint;
  description: readonly string[];
  headline?: string;
  lines?: readonly string[];
  pills?: readonly { label: string; href: string }[];
  status: { tone: CardStatus; label: string } | null;
  /** The reference's highlighted card: a soft pink wash. */
  featured?: boolean;
}) {
  return (
    <section
      aria-label={title}
      className={`panel flex h-full flex-col rounded-card p-5 ${featured ? 'bg-linear-to-br from-pink-soft to-surface' : ''}`}
    >
      <div className="flex gap-4">
        <IconTile tint={tint}>{icon}</IconTile>
        <div className="min-w-0">
          <h3 className="text-lg text-ink">{title}</h3>
          <p className="mt-1 text-sm text-ink-muted">
            {description.map((part, i) => (
              <span key={part}>
                {i > 0 ? <span aria-hidden="true" className="mx-1.5">•</span> : null}
                {part}
              </span>
            ))}
          </p>
          {headline ? <p className="mt-2 text-sm font-medium text-ink">{headline}</p> : null}
          {lines.map((line) => <p key={line} className="mt-0.5 text-sm text-ink-muted">{line}</p>)}
        </div>
      </div>

      {pills.length > 0 ? (
        <ul className="mt-4 flex flex-wrap gap-2 sm:pl-[4.5rem]">
          {pills.map((pill) => (
            <li key={pill.href}>
              <Link
                href={pill.href}
                className="inline-flex rounded-full bg-surface-sunken px-3 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
              >
                {pill.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-3 pt-5">
        {status ? <StatusDot status={status.tone} label={status.label} /> : <span />}
        <Link
          href={href}
          aria-label={`Open ${title}`}
          className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3.5 py-1.5 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft"
        >
          Open <ChevronRight aria-hidden="true" className="size-4" />
        </Link>
      </div>
    </section>
  );
}

/** A quick link with an icon tile, title and one line, as the reference's "Data capture" row. */
export function QuickLink({ href, title, line, icon, tint }: { href: string; title: string; line: string; icon: ReactNode; tint: CardTint }) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 transition-colors hover:border-accent/45 hover:bg-accent-soft/40">
      <IconTile tint={tint} size="sm">{icon}</IconTile>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="block truncate text-xs text-ink-muted">{line}</span>
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
    </Link>
  );
}

/** A small icon button-link, as the reference's report shortcuts. */
export function ShortcutLink({ href, label, icon }: { href: string; label: string; icon: ReactNode }) {
  return (
    <Link href={href} className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm font-medium whitespace-nowrap text-ink transition-colors hover:border-accent/45 hover:bg-accent-soft hover:text-accent [&_svg]:size-4 [&_svg]:text-accent">
      {icon}
      {label}
    </Link>
  );
}
