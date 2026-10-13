/**
 * The APX colours for print (ADR-169; ADR-170). A Word file and a PDF cannot read the app's CSS
 * tokens, so the brand values in `src/app/globals.css` are restated here, once, for both renderers:
 * the coral red accent (`--color-accent`), the orange second colour (`--color-pink`, kept under its
 * old name) and the near-black that sits on them (`--color-on-accent`). A printed page is light, so
 * its text colours are dark ones of the document's own, not the app's light-on-dark ink.
 *
 * Hex without the "#", as Word wants it.
 */
export const PRINT = {
  accent: 'FF2D55',
  orange: 'FF8A4C',
  onAccent: '140A0C',
  ink: '18181B',
  muted: '5C5C66',
  rule: 'E4E4E7',
  /** The accent at about six per cent on white: the ground of a notice. */
  tint: 'FFF1F3',
  /** Alternate table rows. */
  zebra: 'F7F7F8',
} as const;

/** "FF2D55" as pdf-lib's 0–1 channels. */
export function channels(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex, 16);
  return { r: ((value >> 16) & 0xff) / 255, g: ((value >> 8) & 0xff) / 255, b: (value & 0xff) / 255 };
}
