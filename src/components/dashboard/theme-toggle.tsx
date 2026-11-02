'use client';

import { useRouter } from 'next/navigation';
import { Moon, Sun } from 'lucide-react';
import { THEME_COOKIE, type Look } from './theme-cookie';

function useChooseLook(look: Look) {
  const router = useRouter();
  const next: Look = look === 'dark' ? 'light' : 'dark';
  const choose = () => {
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };
  return { next, choose };
}

/**
 * Light / dark (ADR-184). Writes the lasting `apx_theme` cookie and asks the server for the page
 * again, which renders the other look: the whole shell changes (masthead, menu, palette), so a
 * server render is the honest way to switch rather than a class flipped on the client.
 */
export function ThemeToggle({ look, className = '' }: { look: Look; className?: string }) {
  const { next, choose } = useChooseLook(look);
  const label = next === 'dark' ? 'Switch to dark mode' : 'Switch to light mode';
  return (
    <button
      type="button"
      onClick={choose}
      aria-label={label}
      title={label}
      className={`flex shrink-0 items-center justify-center transition-colors ${
        look === 'light'
          ? 'size-[2.375rem] rounded-[0.4375rem] border border-[#c7cfd9] bg-white/65 text-ink hover:border-accent/60 hover:bg-accent-soft hover:text-accent'
          : 'size-10 rounded-xl border border-line text-ink hover:border-accent/60 hover:bg-accent-soft hover:text-accent'
      } ${className}`}
    >
      {next === 'dark'
        ? <Moon aria-hidden="true" className="size-4" strokeWidth={1.75} />
        : <Sun aria-hidden="true" className="size-4" strokeWidth={1.75} />}
    </button>
  );
}

/** The same choice as a menu item, beside Sign out: the top bar (and its button) is hidden while the menu is shown. */
export function ThemeMenuItem({ look }: { look: Look }) {
  const { next, choose } = useChooseLook(look);
  return (
    <button
      type="button"
      onClick={choose}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-[0.9375rem] text-ink transition-colors hover:bg-accent-soft hover:text-accent"
    >
      {next === 'dark'
        ? <Moon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
        : <Sun aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />}
      {next === 'dark' ? 'Dark mode' : 'Light mode'}
    </button>
  );
}
