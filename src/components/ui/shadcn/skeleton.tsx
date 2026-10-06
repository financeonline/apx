import * as React from 'react';
import { cn } from '@/lib/utils';

/** shadcn/ui Skeleton (SOW §6); MOTION's shimmer class. */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="skeleton" aria-hidden="true" className={cn('skeleton', className)} {...props} />;
}

export { Skeleton };
