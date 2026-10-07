import { dataLinks, sectionLinks } from '@/components/dashboard/nav';
import type { SidebarGroup, SidebarIcon } from '@/components/dashboard/sidebar';
import { AppShell } from '@/components/dashboard/app-shell';
import { notFound } from 'next/navigation';
import { getAccessContext } from '@/modules/tenancy';
import { can, isSuperAdmin } from '@/core/permissions';
import { isMotionError } from '@/core/errors';
import { recordAccessEvent } from '@/core/db/server-rpc';
import { Banner, Badge } from '@/components/ui/surfaces';
import { ROLE_LABELS } from '@/components/labels';
import { unreadCount } from '@/modules/engagement';
import { fundingEnabled } from '@/modules/funding';

export const dynamic = 'force-dynamic';

/**
 * The tenant shell (ROUTE_ARCHITECTURE.md §9).
 *
 * It is the only place an AccessContext is created for this family. A caller with no access gets
 * the uniform 404 — never a 403 — so the existence of an organisation is never confirmed to a
 * non-member (SECURITY_MODEL.md §14).
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  let ctx;
  try {
    ctx = await getAccessContext(orgSlug);
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  // CD-13: every super-admin view of tenant data is recorded, and the organisation's owner can see
  // it in their own audit log.
  if (isSuperAdmin(ctx) && ctx.orgId) {
    await recordAccessEvent(
      { userId: ctx.userId, requestId: ctx.requestId },
      {
        organizationId: ctx.orgId,
        action: 'org.data_viewed',
        targetTable: 'organizations',
        targetId: ctx.orgId,
        metadata: { route: `/app/${orgSlug}` },
      },
    );
  }

  const suspended = ctx.organizationStatus === 'suspended';
  const pendingDeletion = ctx.organizationStatus === 'pending_deletion';
  const showSettings = can(ctx, 'settings.manage');
  // ADR-144: the inbox. Not for a suspended member, who keeps only the frozen Home (ADR-044.4).
  const unread = can(ctx, 'financials.view') ? await unreadCount(ctx) : null;
  // Phase 16 (U-5): the Funding link exists only while the flag is on, for those with `reports.view`.
  const showFunding = can(ctx, 'reports.view') && await fundingEnabled(ctx);

  const base = `/app/${orgSlug}`;
  const DATA_ICONS: Readonly<Record<string, SidebarIcon>> = {
    'data/imports/new': 'add-data', 'data/imports': 'imports', 'data/documents': 'documents', 'data/accounts': 'accounts',
  };
  const groups: SidebarGroup[] = [
    {
      label: 'Sections',
      links: [
        ...sectionLinks(ctx).map((l) => ({ label: l.label, href: `${base}/${l.path}`, hint: l.hint, icon: l.path as SidebarIcon })),
        ...(showFunding ? [{ label: 'Funding', href: `${base}/funding`, icon: 'funding' as const }] : []),
      ],
    },
    ...(dataLinks(ctx).length === 0 ? [] : [{
      label: 'Data',
      links: dataLinks(ctx).map((l) => ({ label: l.label, href: `${base}/${l.path}`, icon: DATA_ICONS[l.path] ?? 'imports' })),
    }]),
    {
      label: 'You',
      links: [
        ...(unread === null ? [] : [{
          label: 'Notifications', href: `${base}/notifications`, icon: 'notifications' as const,
          count: { value: unread, srText: `${unread} unread` },
        }]),
        ...(showSettings ? [{ label: 'Settings', href: `${base}/settings`, icon: 'settings' as const }] : []),
        // The roles that hold assignments.view are exactly the roles with a Command Centre (ADR-112).
        ...(can(ctx, 'assignments.view') ? [{ label: 'Command Centre', href: '/portfolio', icon: 'portfolio' as const }] : []),
        { label: 'Switch', href: '/select-organization', icon: 'switch' as const },
        { label: 'Account', href: '/account', icon: 'account' as const },
      ],
    },
  ];
  const role = <Badge tone="accent">{ROLE_LABELS[ctx.effectiveRole]}</Badge>;

  return (
    <AppShell homeHref={`${base}/home`} groups={groups} footer={role}>
        <div className="mb-6 flex flex-col gap-3 empty:mb-0">
          {isSuperAdmin(ctx) && (
            <Banner tone="warn" title="You are viewing this organisation as MOTION staff">
              This visit is recorded in the organisation&rsquo;s own audit log.
            </Banner>
          )}
          {suspended && (
            <Banner tone="warn" title="This organisation is suspended">
              You can see this page, but nothing can be changed until it is reactivated.
            </Banner>
          )}
          {pendingDeletion && (
            <Banner tone="danger" title="This organisation is scheduled for deletion">
              An owner can still cancel that from Settings.
            </Banner>
          )}
        </div>
        {children}
    </AppShell>
  );
}
