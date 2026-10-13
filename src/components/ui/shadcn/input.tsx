import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Input (SOW §6), MOTION tokens. On a touch screen it is at least 40px tall and its text is
 * 16px: a phone zooms the page into any field set smaller, and the page then sits off to one side.
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'block w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink pointer-coarse:min-h-10 pointer-coarse:text-base transition-colors duration-100 outline-none placeholder:text-ink-faint hover:border-ink-faint focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
