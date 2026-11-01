import Link from 'next/link';
import { Bell } from 'lucide-react';
import { dataLinks, sectionLinks } from '@/components/dashboard/nav';
import type { SidebarGroup, SidebarIcon } from '@/components/dashboard/sidebar';
import { AppShell } from '@/components/dashboard/app-shell';
import { notFound } from 'next/navigation';
import { getAccessContext, landingPath, mayRequestAccess } from '@/modules/tenancy';
import { can, isPlatformStaff, isSuperAdmin } from '@/core/permissions';
import { isMotionError } from '@/core/errors';
import { recordAccessEvent } from '@/core/db/server-rpc';
import { callApi } from '@/core/db';
import { Banner } from '@/components/ui/surfaces';
import { AccessLinksProvider } from '@/components/dashboard/access-links';
import { LobbyCanvas } from '@/components/dashboard/lobby';
import { ROLE_LABELS } from '@/components/labels';
import { unreadCount } from '@/modules/engagement';
import { fundingEnabled } from '@/modules/funding';
import { marketingEnabled } from '@/modules/marketing';
import { investmentEnabled } from '@/modules/investment';

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
  // ADR-144: the inbox — personal, so anyone with the overview reads their own (ADR-172 follow-up: a
  // 3rd party reads the answer to their own access request there). Not for a suspended organisation,
  // which keeps only the frozen Home (ADR-044.4).
  const unread = can(ctx, 'dashboard.view') && !suspended ? await unreadCount(ctx) : null;
  // ADR-172: "Your access" and "Request more information", for members who may ask (never an owner,
  // never APX staff, never a suspended organisation — `mayRequestAccess`).
  const mayAsk = mayRequestAccess(ctx.effectiveRole);
  // Phase 16 (U-5): the Funding link exists only while the flag is on, for those with `reports.view`.
  const showFunding = can(ctx, 'reports.view') && await fundingEnabled(ctx);
  // ADR-170: Marketing, for `reports.view`, unless the super admin switched it off (ADR-158).
  const showMarketing = can(ctx, 'reports.view') && marketingEnabled(ctx);
  // ADR-171: Investment, gated as Marketing is.
  const showInvestment = can(ctx, 'reports.view') && investmentEnabled(ctx);

  const base = `/app/${orgSlug}`;
  const groups: SidebarGroup[] = [
    {
      label: 'Sections',
      links: [
        ...sectionLinks(ctx).map((l) => ({ label: l.label, href: `${base}/${l.path}`, hint: l.hint, icon: l.path as SidebarIcon })),
        ...(showFunding ? [{ label: 'Funding', href: `${base}/funding`, icon: 'funding' as const }] : []),
        ...(showMarketing ? [{ label: 'Marketing', href: `${base}/marketing`, icon: 'marketing' as const }] : []),
        ...(showInvestment ? [{ label: 'Investment', href: `${base}/investment`, icon: 'investment' as const }] : []),
      ],
    },
    // As the reference: one "Data & Forms" item; the data pages carry their own tabs (data/layout).
    ...(dataLinks(ctx).length === 0 ? [] : [{
      label: 'Data',
      links: [{ label: 'Data & Forms', href: `${base}/data/imports`, match: `${base}/data`, icon: 'documents' as const }],
    }]),
    {
      label: 'You',
      links: [
        ...(unread === null ? [] : [{
          label: 'Notifications', href: `${base}/notifications`, icon: 'notifications' as const,
          count: { value: unread, srText: `${unread} unread` },
        }]),
        ...(mayAsk ? [{ label: 'Your access', href: `${base}/access`, icon: 'access' as const }] : []),
        ...(showSettings ? [{ label: 'Settings', href: `${base}/settings`, icon: 'settings' as const }] : []),
        // The Command Centre is APX staff only (ADR-112 addendum, owner 2026-10-14): company owners and
        // admins hold assignments.view to see their analysts, but have no Command Centre.
        ...(isPlatformStaff(ctx) ? [{ label: 'Command Centre', href: '/portfolio', icon: 'portfolio' as const }] : []),
        { label: 'Switch', href: '/select-organization', icon: 'switch' as const },
      ],
    },
  ];
  // The reference's sidebar names the signed-in person (their own profile row; ADR-155).
  const profile = (await callApi<Array<{ full_name: string | null; email: string }>>(ctx.db, 'my_profile', {}, ctx.requestId))?.[0];
  const user = {
    name: profile?.full_name?.trim() || profile?.email || 'Your account',
    role: ROLE_LABELS[ctx.effectiveRole],
    href: '/account',
  };

  /*
   * The logo goes where signing in goes: Departments, or Home for a person without `financials.view`
   * (a 3rd party), who would otherwise be sent to a refusal (`landingPath`, ADR-172 follow-up). The
   * forbidden page offers the same Home and, to a member who may ask, "Request more information" —
   * through context, because `forbidden.tsx` takes no props.
   */
  const accessLinks = {
    homeHref: can(ctx, 'dashboard.view') ? `${base}/home` : null,
    accessHref: mayAsk ? `${base}/access` : null,
  };

  return (
    <AppShell
      homeHref={landingPath(orgSlug, ctx.permissions)}
      groups={groups}
      user={user}
      look="light"
      headerActions={unread === null ? null : (
        // The reference's round header icon: the notifications inbox, with its unread count.
        <Link
          href={`${base}/notifications`}
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          title="Notifications"
          className="relative flex size-[2.0625rem] shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
        >
          <Bell aria-hidden="true" className="size-[1.1875rem]" strokeWidth={1.6} />
          {unread > 0 ? (
            <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[0.625rem] leading-4 font-semibold text-on-accent tabular-nums">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </Link>
      )}
    >
      {/* ADR-176: every page of the company, Home and the sections inside, on the lobby's light palette. */}
      <LobbyCanvas>
        <div className="mb-6 flex flex-col gap-3 empty:mb-0">
          {isSuperAdmin(ctx) && (
            <Banner tone="warn" title="You are viewing this organisation as APX staff">
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
        <AccessLinksProvider value={accessLinks}>{children}</AccessLinksProvider>
      </LobbyCanvas>
    </AppShell>
  );
}
