import { AppShell } from '@/components/dashboard/app-shell';
import { notFound } from 'next/navigation';
import { getPlatformContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { ConfirmItsYou } from './confirm-its-you';

export const dynamic = 'force-dynamic';

/** Super-admin only. Everyone else gets the uniform 404 (ROUTE_ARCHITECTURE.md §6). */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getPlatformContext();
  if (!can(ctx, 'system.manage')) notFound();

  return (
    <AppShell
      homeHref="/platform"
      homeLabel="Platform home"
      area="Platform"
      groups={[
        {
          label: 'Platform',
          links: [
            { label: 'Organisations', href: '/platform/organizations', icon: 'portfolio' },
            { label: 'Platform users', href: '/platform/users', icon: 'users' },
            { label: 'Assignments', href: '/platform/assignments', icon: 'assignments' },
            { label: 'Jobs', href: '/platform/jobs', icon: 'jobs' },
            { label: 'AI feedback', href: '/platform/ai-feedback', icon: 'analyst' },
            { label: 'Audit', href: '/platform/audit', icon: 'audit' },
            { label: 'Settings', href: '/platform/settings', icon: 'settings' },
          ],
        },
        { label: 'You', links: [{ label: 'Account', href: '/account', icon: 'account' }] },
      ]}
    >
      <ConfirmItsYou />
      {children}
    </AppShell>
  );
}
