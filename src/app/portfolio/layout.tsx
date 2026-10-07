import { AppShell } from '@/components/dashboard/app-shell';
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
    <AppShell
      homeHref="/portfolio"
      homeLabel="Command Centre home"
      area="Command Centre"
      groups={[
        {
          label: 'Command Centre',
          links: [
            { label: 'Overview', href: '/portfolio', icon: 'home' },
            { label: 'Alerts', href: '/portfolio/alerts', icon: 'alerts' },
            { label: 'Actions', href: '/portfolio/actions', icon: 'actions' },
            { label: 'Adviser analyst', href: '/portfolio/analyst', icon: 'analyst' },
            { label: 'Report', href: '/portfolio/report', icon: 'reports' },
          ],
        },
        {
          label: 'You',
          links: [
            { label: 'Organisations', href: '/select-organization', icon: 'switch' },
            { label: 'Account', href: '/account', icon: 'account' },
          ],
        },
      ]}
    >
      {children}
    </AppShell>
  );
}
