import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button as ShadcnButton, buttonVariants } from './shadcn';

/** MOTION's four button tones, as shadcn/ui variants (SOW §6; ADR-151). */
export type ButtonTone = 'primary' | 'secondary' | 'quiet' | 'danger';

const VARIANT = { primary: 'default', secondary: 'secondary', quiet: 'ghost', danger: 'destructive' } as const;

export function buttonClass(tone: ButtonTone = 'primary', extra = ''): string {
  return cn(buttonVariants({ variant: VARIANT[tone] }), extra);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
}

export function Button({ tone = 'primary', className = '', ...props }: ButtonProps) {
  return <ShadcnButton variant={VARIANT[tone]} className={className} {...props} />;
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
    <ShadcnButton asChild variant={VARIANT[tone]} className={className}>
      <Link href={href}>{children}</Link>
    </ShadcnButton>
  );
}
