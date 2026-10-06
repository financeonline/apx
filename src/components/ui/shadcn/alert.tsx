import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Alert (SOW §6), MOTION tones. `role` is the caller's: a passive notice is `status`, and
 * MOTION never makes one an `alert` (the route announcer already is one).
 */
const alertVariants = cva('rounded-card border px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'border-line bg-surface-sunken text-ink',
      warn: 'border-warn/40 bg-warn-soft text-ink',
      destructive: 'border-danger/40 bg-danger-soft text-ink',
    },
  },
  defaultVariants: { variant: 'default' },
});

function Alert({ className, variant, role = 'status', ...props }: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role={role} className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="alert-title" className={cn('font-medium', className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-description" className={cn('mt-1 text-ink-muted', className)} {...props} />;
}

export { Alert, AlertDescription, AlertTitle };
