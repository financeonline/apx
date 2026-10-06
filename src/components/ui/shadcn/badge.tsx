import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/** shadcn/ui Badge (SOW §6); variants are MOTION's tones. */
const badgeVariants = cva('inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium', {
  variants: {
    variant: {
      default: 'border-line bg-surface-sunken text-ink-muted',
      accent: 'border-transparent bg-accent-soft text-accent',
      warn: 'border-transparent bg-warn-soft text-warn',
      destructive: 'border-transparent bg-danger-soft text-danger',
    },
  },
  defaultVariants: { variant: 'default' },
});

function Badge({
  className, variant, asChild = false, ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span';
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
