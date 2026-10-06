import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Button (SOW §6), themed with MOTION's tokens: the variants are the product's four tones.
 * Owned source, as shadcn/ui intends — edited here, never updated from a package.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border text-sm font-medium transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-accent text-on-accent hover:bg-accent-hover',
        secondary: 'border-line-strong bg-surface text-ink hover:bg-surface-sunken',
        ghost: 'border-transparent bg-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink',
        destructive: 'border-danger bg-surface text-danger hover:bg-danger-soft',
        link: 'border-transparent bg-transparent px-0 text-accent underline underline-offset-2',
      },
      size: {
        default: 'px-3.5 py-2',
        sm: 'px-2.5 py-1 text-xs',
        lg: 'px-5 py-2.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

function Button({
  className, variant, size, asChild = false, ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
