import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonTone = 'primary' | 'secondary' | 'quiet' | 'danger';

const TONES: Record<ButtonTone, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-ink border-line-strong hover:bg-surface-sunken',
  quiet: 'bg-transparent text-ink-muted border-transparent hover:text-ink hover:bg-surface-sunken',
  danger: 'bg-surface text-danger border-danger hover:bg-danger-soft',
};

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-md border px-3.5 py-2 text-sm font-medium ' +
  'transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50';

export function buttonClass(tone: ButtonTone = 'primary', extra = ''): string {
  return `${BASE} ${TONES[tone]} ${extra}`.trim();
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
}

export function Button({ tone = 'primary', className = '', ...props }: ButtonProps) {
  return <button {...props} className={buttonClass(tone, className)} />;
}

export function ButtonLink({
  href,
  tone = 'primary',
  className = '',
  children,
}: {
  href: string;
  tone?: ButtonTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={buttonClass(tone, className)}>
      {children}
    </Link>
  );
}
