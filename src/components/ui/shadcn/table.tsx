import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Table (SOW §6), MOTION tokens. The container keeps MOTION's two load-bearing classes:
 * `min-w-0` (a flex/grid child must be able to shrink) and `relative` (screen-reader text inside is
 * absolutely positioned and must not escape the scroll box) — ADR-058.12.
 */
function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    // tabIndex: a table wider than the screen scrolls inside this box, and a keyboard user must be
    // able to reach it to scroll it (WCAG 2.1.1; axe `scrollable-region-focusable`, found with the
    // sample data's sales pipeline).
    <div data-slot="table-container" tabIndex={0} className="relative min-w-0 overflow-x-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
      <table data-slot="table" className={cn('w-full min-w-[36rem] border-collapse text-sm', className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn(className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('divide-y divide-line', className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr data-slot="table-row" className={cn('align-top', className)} {...props} />;
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return <th data-slot="table-head" className={cn('px-5 py-2.5 text-left text-xs font-medium uppercase tracking-[0.08em] text-ink-faint', className)} {...props} />;
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={cn('px-5 py-3', className)} {...props} />;
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return <caption data-slot="table-caption" className={cn('mt-3 text-sm text-ink-muted', className)} {...props} />;
}

export { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow };
