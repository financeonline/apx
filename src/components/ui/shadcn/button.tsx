import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Button (SOW §6), themed with MOTION's tokens: the variants are the product's four tones,
 * styled as the owner's reference (ADR-155): a solid violet primary, a violet outline secondary.
 * Owned source, as shadcn/ui intends — edited here, never updated from a package.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border text-sm font-medium transition-[background-color,box-shadow,color,border-color] duration-150 [&_svg]:size-4 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-accent text-on-accent shadow-[0_10px_24px_-10px_rgb(124_58_237/0.65)] hover:bg-accent-hover',
        secondary: 'border-accent/45 bg-surface text-accent hover:border-accent hover:bg-accent-soft',
        ghost: 'border-transparent bg-transparent text-ink-muted hover:bg-accent-soft hover:text-accent',
        destructive: 'border-danger/45 bg-surface text-danger hover:border-danger hover:bg-danger-soft',
        link: 'border-transparent bg-transparent px-0 text-accent underline underline-offset-2',
      },
      size: {
        default: 'px-4 py-2',
        sm: 'px-3 py-1 text-xs',
        lg: 'px-5 py-3 text-base',
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
