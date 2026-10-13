import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Card (SOW §6), MOTION tokens: a white panel with a soft violet shadow (ADR-155). The
 * root is a `<section>` (shadcn's is a `<div>`) because MOTION's pages name their cards as regions.
 *
 * On a phone the header, body and footer sit 16px in from the card's edge rather than 24px — a
 * little more room for the words on a narrow screen (owner, 2026-10-14). A caller that sets its own
 * padding (`p-8`, or `px-0` for a table that runs edge to edge) keeps exactly that, on every screen.
 */
const OWN_PADDING = /(^|\s)(p|px)-/;

/** The phone's side padding, unless the caller has chosen its own. */
function phonePadding(className: string | undefined): string | false {
  return !OWN_PADDING.test(className ?? '') && 'max-sm:px-4';
}

function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return <section data-slot="card" className={cn('panel rounded-card text-ink', className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<'header'>) {
  return <header data-slot="card-header" className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-line px-6 py-5', phonePadding(className), className)} {...props} />;
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
  return <div data-slot="card-content" className={cn('px-6 py-5', phonePadding(className), className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('flex items-center border-t border-line px-6 py-5', phonePadding(className), className)} {...props} />;
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
