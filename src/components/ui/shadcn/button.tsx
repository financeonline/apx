import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Button (SOW §6), themed with MOTION's tokens: the variants are the product's four tones,
 * styled as the client's APX reference (ADR-169): a coral-to-orange gradient primary, a coral outline secondary.
 * Owned source, as shadcn/ui intends — edited here, never updated from a package.
 *
 * On a touch screen every button is at least 40px tall (owner, 2026-10-14: the app on a phone), so a
 * small one is still a target a thumb can hit; with a mouse they keep their size.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border text-sm font-medium pointer-coarse:min-h-10 transition-[background-color,box-shadow,color,border-color,filter] duration-150 [&_svg]:size-4 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-accent bg-brand-gradient font-semibold text-on-accent shadow-[0_10px_28px_-12px_rgb(255_45_85/0.7)] hover:brightness-110',
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
