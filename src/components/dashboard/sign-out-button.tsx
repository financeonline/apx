import { LogOut } from 'lucide-react';

/** Sign out (a POST to /auth/sign-out), styled as a sidebar item. */
export function SignOutButton({ className = '' }: { className?: string }) {
  return (
    <form action="/auth/sign-out" method="post" className={className}>
      <button
        type="submit"
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-[0.9375rem] text-ink transition-colors hover:bg-danger-soft hover:text-danger"
      >
        <LogOut aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
        Sign out
      </button>
    </form>
  );
}

/**
 * Log out at the right of the top bar (owner, 2026-10-14: "add logout button right hand side"), so
 * it is one tap away while the menu is hidden. The same POST to /auth/sign-out as the menu's item.
 */
export function SignOutHeaderButton({ look = 'dark' }: { look?: 'dark' | 'light' }) {
  return (
    <form action="/auth/sign-out" method="post" className="ml-auto">
      <button
        type="submit"
        className={look === 'light'
          // The reference's outlined header button ("Give feedback"): 7px corners, a cool grey border.
          ? 'flex h-[2.375rem] items-center gap-2 rounded-[0.4375rem] border border-[#c7cfd9] bg-white/65 px-3 text-[0.8125rem] font-medium text-ink transition-colors hover:border-accent/60 hover:bg-accent-soft hover:text-accent'
          : 'flex h-10 items-center gap-2 rounded-xl border border-line px-3 text-sm font-medium text-ink transition-colors hover:border-danger/60 hover:bg-danger-soft hover:text-danger'}
      >
        <LogOut aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        Log out
      </button>
    </form>
  );
}
