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
