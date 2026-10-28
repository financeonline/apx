import Link from 'next/link';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * Whole-card links (owner, 2026-10-07 for the department cards; 2026-10-14 for every card that opens
 * something). A card that stands for one thing a reader can open — a department, a figure and its
 * "Why?", an alert, an action, a page of Money — opens it from anywhere on the card, not only from
 * its small link. The pattern is the department card's (ADR-155), kept here so every card does it
 * the same way:
 *
 *   - the card is the positioning context (`CLICKABLE_CARD`) and glows on hover and on keyboard
 *     focus, so the reader can see the whole of it is a target;
 *   - its ONE primary link (`CardLink`) keeps its own words and stretches an invisible layer over the
 *     whole card, so assistive technology still meets exactly one link per card, named as before;
 *   - anything else interactive inside — a second link, a button, a form, a badge whose tooltip says
 *     something — sits above that layer (`ABOVE_CARD_LINK`) and keeps its own target. Nothing
 *     interactive is ever nested inside the link.
 *
 * A card with no destination stays a plain card: a card that looks clickable and goes nowhere is
 * worse than one that does not look clickable at all.
 */

/** The hover/focus glow on a clickable card: a coral edge and a soft coral halo (ADR-169); quieter in the lobby palette (ADR-176). */
export const CARD_GLOW =
  'hover:border-accent/70 hover:shadow-[var(--glow-card)] focus-within:border-accent/70 focus-within:shadow-[var(--glow-card-focus)]';

/**
 * On the card itself: the box the link's layer fills, and the glow. `group`, so a visible "Open" or
 * "Why?" inside can brighten with the card (`group-hover:`).
 */
export const CLICKABLE_CARD = `group relative transition-[box-shadow,border-color] duration-200 ${CARD_GLOW}`;

/**
 * On the card's one primary link: the invisible layer over the whole card. The link's own outline is
 * not drawn, because it would ring only the few words of the link; the card's glow is the focus ring.
 * The layer's corners follow the card's (`rounded-card`); a card with other corners overrides them.
 */
export const CARD_LINK_STRETCH = "outline-none after:absolute after:inset-0 after:rounded-card after:content-['']";

/**
 * A row in a list that opens one thing (a movement and its "Why?", a saved scenario): the same
 * pattern at a row's weight — a tint on hover and on keyboard focus rather than a glow. Its link is
 * a `CardLink` given the row's corners (`after:rounded-lg` on a `rounded-lg` row).
 */
export const CLICKABLE_ROW = 'group relative transition-colors duration-150 hover:bg-accent-soft/30 focus-within:bg-accent-soft/40';

/** Above the card's link layer: a second link, a button, a form, a badge whose tooltip carries meaning. */
export const ABOVE_CARD_LINK = 'relative z-10';

/**
 * A tap target of at least 40px on a touch screen, for the small pills and chips (a filter, a month,
 * a quick link) that are sized for a mouse. Applies to an `inline-flex items-center` element.
 */
export const TOUCH_TARGET = 'pointer-coarse:min-h-10';

/** The card's one primary link, stretched over the card. Everything else about it is a `Link`'s. */
export function CardLink({ className, ...props }: ComponentProps<typeof Link>) {
  return <Link className={cn(CARD_LINK_STRETCH, className)} {...props} />;
}
