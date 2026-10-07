import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Card (SOW §6), MOTION tokens: a liquid glass surface (ADR-153). The
 * root is a `<section>` (shadcn's is a `<div>`) because MOTION's pages name their cards as regions.
 */
function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return <section data-slot="card" className={cn('glass rounded-card text-ink', className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<'header'>) {
  return <header data-slot="card-header" className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4', className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <h2 data-slot="card-title" className={cn('text-base', className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="card-description" className={cn('mt-1 text-sm text-ink-muted', className)} {...props} />;
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-action" className={cn('shrink-0', className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-5 py-4', className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('flex items-center border-t border-line px-5 py-4', className)} {...props} />;
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
