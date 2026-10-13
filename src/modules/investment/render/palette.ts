import type { RiskLevel } from '../domain/types';

/**
 * The APX colours for the printed pack (ADR-169; ADR-171). A Word file and a PDF cannot read the
 * app's CSS tokens, so the brand values in `src/app/globals.css` are restated for print — the same
 * values as the Marketing report's print palette (`modules/marketing/render/palette.ts`, ADR-170),
 * which that module's barrel does not export; when it does, this file should import it instead of
 * repeating it. The chart colours are `--color-chart-1..6`, in the same order the page uses them, so
 * a series is the same colour on screen, in Word and in the PDF.
 *
 * A printed page is light, so its text colours are dark ones of the document's own. Hex without the
 * "#", as Word wants it.
 */
export const PRINT = {
  accent: 'FF2D55',
  orange: 'FF8A4C',
  onAccent: '140A0C',
  ink: '18181B',
  muted: '5C5C66',
  rule: 'E4E4E7',
  /** The accent at about six per cent on white: the ground of a notice and a headline tile. */
  tint: 'FFF1F3',
  /** Alternate table rows. */
  zebra: 'F7F7F8',
  /** The empty part of a drawn bar. */
  track: 'F1F1F3',
} as const;

/** `--color-chart-1..6`. */
export const PRINT_CHART = ['FF2D55', 'FF8A4C', '38BDF8', 'C084FC', '34D399', 'A1A1AA'] as const;

export function printChart(index: number): string {
  return PRINT_CHART[index % PRINT_CHART.length] ?? PRINT_CHART[0];
}

/**
 * The chart colour of each risk level, from green at the lower end to the coral accent at the
 * higher: lower `chart-5`, low–medium `chart-3`, medium `chart-4`, higher `chart-2`, high and very
 * high `chart-1`. Colour is never the only signal — the level is the dot's POSITION and is named in
 * words beside it (UX_ARCHITECTURE.md §11).
 */
export const RISK_CHART_INDEX: Readonly<Record<RiskLevel, number>> = {
  lower: 4, low_medium: 2, medium: 3, higher: 1, high: 0, very_high: 0,
};

/** "FF2D55" as pdf-lib's 0–1 channels. */
export function channels(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex, 16);
  return { r: ((value >> 16) & 0xff) / 255, g: ((value >> 8) & 0xff) / 255, b: (value & 0xff) / 255 };
}
