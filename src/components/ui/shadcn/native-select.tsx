import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui NativeSelect (SOW §6), MOTION tokens. The native element is kept on purpose: it is what
 * every screen reader and phone handles best, and the journeys select options by label.
 */
function NativeSelect({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        'block w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition-colors duration-100 outline-none hover:border-ink-faint focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export { NativeSelect };
