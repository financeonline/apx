import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPlatformContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';

export const dynamic = 'force-dynamic';

/** Super-admin only. Everyone else gets the uniform 404 (ROUTE_ARCHITECTURE.md §6). */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getPlatformContext();
  if (!can(ctx, 'system.manage')) notFound();

  return (
    <div className="min-h-dvh bg-canvas-alt">
      <header className="border-b border-line-strong bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <Link href="/platform" className="text-sm font-semibold tracking-widest uppercase">
            MOTION · Platform
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/platform/organizations" className="text-ink-muted hover:text-ink">Organisations</Link>
            <Link href="/platform/users" className="text-ink-muted hover:text-ink">Platform users</Link>
            <Link href="/platform/assignments" className="text-ink-muted hover:text-ink">Assignments</Link>
            <Link href="/platform/jobs" className="text-ink-muted hover:text-ink">Jobs</Link>
            <Link href="/platform/ai-feedback" className="text-ink-muted hover:text-ink">AI feedback</Link>
            <Link href="/platform/audit" className="text-ink-muted hover:text-ink">Audit</Link>
            <Link href="/platform/settings" className="text-ink-muted hover:text-ink">Settings</Link>
          </nav>
          <Link href="/account" className="ml-auto text-sm text-ink-muted hover:text-ink">Account</Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
