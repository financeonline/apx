'use client';

import { useRouter } from 'next/navigation';
import { Moon, Sun } from 'lucide-react';
import { THEME_COOKIE, type Look } from './theme-cookie';

/**
 * Light / dark (ADR-184). Writes the lasting `apx_theme` cookie and asks the server for the page
 * again, which renders the other look: the whole shell changes (masthead, menu, palette), so a
 * server render is the honest way to switch rather than a class flipped on the client.
 */
export function ThemeToggle({ look, className = '' }: { look: Look; className?: string }) {
  const router = useRouter();
  const next: Look = look === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? 'Switch to dark mode' : 'Switch to light mode';
  const choose = () => {
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };
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
