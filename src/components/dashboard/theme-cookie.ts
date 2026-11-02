/**
 * The light/dark choice (ADR-184): `apx_theme=light|dark`, a lasting cookie read by the server
 * shell, so the chosen look is rendered on the first paint — no flash — and written by the toggle.
 * Without it an area keeps its own default: company pages light, Command Centre and Platform dark.
 * A plain module so the server shell and the client toggle share the one name.
 */
export const THEME_COOKIE = 'apx_theme';

export type Look = 'dark' | 'light';

export function lookFromCookie(value: string | undefined, fallback: Look): Look {
  return value === 'light' || value === 'dark' ? value : fallback;
}
