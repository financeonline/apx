import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isMotionError } from '@/core/errors';
import { getPortfolioContext } from '@/modules/portfolio';

export const dynamic = 'force-dynamic';

/**
 * The Command Centre shell (ADR-112). The one place a PortfolioContext is created for this family:
 * a caller with no organisation to advise gets the uniform 404, never a 403, so the existence of a
 * portfolio is never confirmed to someone who has none (SECURITY_MODEL.md §14).
 */
export default async function PortfolioLayout({ children }: { children: React.ReactNode }) {
  try {
    await getPortfolioContext();
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  return (
    <div className="min-h-dvh bg-canvas-alt">
      <header className="glass mx-3 mt-3 rounded-card sm:mx-4 lg:mx-auto lg:max-w-6xl">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/portfolio" className="text-sm font-semibold tracking-widest uppercase">
            MOTION · Command Centre
          </Link>
          <nav aria-label="Command Centre" className="flex flex-wrap items-center gap-4 text-sm">
            <Link href="/portfolio" className="text-ink-muted hover:text-ink">Overview</Link>
            <Link href="/portfolio/alerts" className="text-ink-muted hover:text-ink">Alerts</Link>
            <Link href="/portfolio/actions" className="text-ink-muted hover:text-ink">Actions</Link>
            <Link href="/portfolio/analyst" className="text-ink-muted hover:text-ink">Adviser analyst</Link>
            <Link href="/portfolio/report" className="text-ink-muted hover:text-ink">Report</Link>
          </nav>
          <div className="ml-auto flex items-center gap-4 text-sm">
            <Link href="/select-organization" className="text-ink-muted hover:text-ink">Organisations</Link>
            <Link href="/account" className="text-ink-muted hover:text-ink">Account</Link>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
