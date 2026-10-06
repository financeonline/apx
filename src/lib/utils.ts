import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge, told about MOTION's own radius token so an override (`rounded-md` over
 * `rounded-card`) replaces it instead of both landing in the class list. Colour tokens (`text-ink`,
 * `bg-surface`…) are already read as colours.
 */
const twMerge = extendTailwindMerge({ extend: { theme: { radius: ['card'] } } });

/** shadcn/ui's class combiner: conditional classes, with later Tailwind utilities winning conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
