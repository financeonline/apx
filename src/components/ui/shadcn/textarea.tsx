import * as React from 'react';
import { cn } from '@/lib/utils';

/** shadcn/ui Textarea (SOW §6), MOTION tokens; 16px text on a touch screen, as `Input`. */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'block w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink pointer-coarse:text-base transition-colors duration-100 outline-none placeholder:text-ink-faint hover:border-ink-faint focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
