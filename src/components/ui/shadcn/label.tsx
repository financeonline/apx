'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/utils';

/** shadcn/ui Label (SOW §6), on Radix Label. */
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root data-slot="label" className={cn('block text-sm font-medium select-none', className)} {...props} />;
}

export { Label };
