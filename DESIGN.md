# APX — Design

> **Company pages: ADR-179** (2026-11-01) — the owner's third reference: white ground and masthead, APX magenta `#c12591` with blue `#3284d8` as the second colour, ink `#273343`, cool rules `#e6ecf3`, muted text `#5a6a7f` (the reference's lighter greys darkened to pass WCAG AA), link blue `#236fac`, deep-blue Georgia display titles `#2d5376`, Inter for everything else. Tokens in `.theme-lobby` (`src/app/globals.css`); components in `src/components/dashboard/lobby.tsx`.
>
> **Current look: ADR-169** (2026-10-13) — the client's APX design: dark only, near-black ground `#09090b`, cards `#141417`, white text, hot-red accent `#ff2d55`, orange `#ff8a4c`, the pink-and-orange `--brand-gradient` on primary buttons and the current navigation item, the client's logo (`public/brand/apx-logo.png`) and sign-in background (`public/brand/apx-background.webp`) — now for sign-in, Command Centre and Platform. Tokens live in `src/app/globals.css`. The palette below is the original direction, kept for history.

MOTION is read by business owners who are not accountants, and by advisers who are. The interface
has to feel like a well-kept ledger: quiet, ordered, and confident enough that a number on screen is
believed without argument. Everything below exists to serve that.

**Direction** — *Quiet Ledger*: a warm paper ground, deep ink text, one restrained green accent, and figures set in a tabular monospace so columns align down the page. Editorial serif headings give the product the register of a written report rather than a control panel; the interface never shouts, uses one primary action per screen, and reserves colour for meaning (money, warning, danger) instead of decoration.

**Fonts** — Headings use the serif stack `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, ui-serif, serif` (`--font-serif`); body and interface text use `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` (`--font-sans`); every figure, identifier, slug and timestamp uses `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace` (`--font-mono`) with `font-variant-numeric: tabular-nums`. No web fonts are downloaded: the stacks are resident on every target platform, so first paint carries no font swap.

**Palette** — Paper `#FBFAF7`, surface `#FFFFFF`, sunken surface `#F4F2EC`, ink `#16211E`, muted ink `#5C6763`, faint ink `#8A938F`, hairline `#E4E0D6`, strong line `#CFC9BB`, accent `#14634F` with hover `#0E4C3C` and soft wash `#E6F0EB`, warning `#8A5A0B` on `#FAF1DE`, danger `#963320` on `#FBEBE7`, and the platform shell's own identity ink `#1D2A26` with brass `#B98C2F`. The dark scheme keeps the same roles: paper `#101614`, surface `#16201D`, ink `#EDEFEA`, muted ink `#9AA5A0`, hairline `#26312D`, accent `#58B394`.

**Chart palette** — Six categorical series, ordered for use, each legible on both grounds: `#14634F` (deep green), `#2E6F9E` (slate blue), `#8A5A0B` (amber), `#6B4E8F` (plum), `#963320` (rust), `#4A7A2B` (olive); positive movement uses the accent green, negative movement uses rust, and neutral/comparison series use faint ink `#8A938F`. Series are never distinguished by colour alone — every chart also carries a direct label or pattern.

---

## Tokens

Every value above is declared once, as a CSS custom property in `src/app/globals.css`, and consumed
through Tailwind v4 utilities (`bg-paper`, `text-ink`, `border-line`, `text-accent`, `font-serif`).
Nothing in a component hard-codes a hex value.

| Group | Token | Utility |
|---|---|---|
| Ground | `--color-paper`, `--color-surface`, `--color-surface-sunken` | `bg-paper`, `bg-surface`, `bg-surface-sunken` |
| Text | `--color-ink`, `--color-ink-muted`, `--color-ink-faint` | `text-ink`, `text-ink-muted`, `text-ink-faint` |
| Rules | `--color-line`, `--color-line-strong` | `border-line`, `border-line-strong` |
| Accent | `--color-accent`, `--color-accent-hover`, `--color-accent-soft` | `bg-accent`, `text-accent`, `bg-accent-soft` |
| Status | `--color-warn`, `--color-warn-soft`, `--color-danger`, `--color-danger-soft` | `text-warn`, `bg-warn-soft`, `text-danger`, `bg-danger-soft` |
| Platform | `--color-platform`, `--color-platform-accent` | `bg-platform`, `text-platform-accent` |
| Charts | `--color-chart-1` … `--color-chart-6` | `text-chart-1`, `bg-chart-1`, … |
| Type | `--font-sans`, `--font-serif`, `--font-mono` | `font-sans`, `font-serif`, `font-mono` |

## Layout

- One column of content, `max-width: 72rem`, gutters of `1.5rem` on mobile and `2rem` from `md`.
- Vertical rhythm in multiples of `0.25rem`; sections separated by `2.5rem`, cards by `1rem`.
- Cards are a white surface on paper with a single hairline border and no shadow. Elevation is
  expressed by the border and the ground, never by a drop shadow.
- Radii: `0.5rem` on cards and inputs, `0.375rem` on buttons and badges. Nothing is fully rounded
  except avatars and status dots.

## Behaviour

- Focus is always visible: a 2px accent ring with a 2px paper offset, on every interactive element.
- Colour never carries meaning alone — a status badge always carries its word ("Suspended",
  "Pending"), and a destructive action always names what it will do.
- Transitions are 120 ms on colour only. Nothing moves on the page as a decoration.
- The three shells are visually distinct so the user always knows which world they are in: the
  tenant shell is paper with a green accent, the account shell is paper with no chrome, and the
  platform shell has an ink header with a brass wordmark (`UX_ARCHITECTURE.md §9.5`).

## Voice

UK English, second person, no exclamation marks, no jargon in headline UI
(`UX_ARCHITECTURE.md §8`). "Organisation", not "organization", in anything a user reads; the code
and the database keep the American spelling because the schema does.
