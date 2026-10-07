import Link from 'next/link';
import { DataMenu, PrimaryNav } from '@/components/dashboard/nav';
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

  return (
    <div className="min-h-dvh">
      <header className="glass rounded-none border-x-0 border-t-0">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <Link href={`/app/${orgSlug}/home`} className="text-sm font-semibold tracking-widest uppercase">
            MOTION
          </Link>
          <PrimaryNav ctx={ctx} orgSlug={orgSlug} />
          {showFunding ? (
            <Link href={`/app/${orgSlug}/funding`} className="text-sm text-ink-muted transition-colors hover:text-ink">Funding</Link>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-3 text-sm">
            <DataMenu ctx={ctx} orgSlug={orgSlug} />
            {unread === null ? null : (
              <Link href={`/app/${orgSlug}/notifications`} className="text-ink-muted hover:text-ink">
                Notifications{unread > 0 ? <span className="ml-1 rounded-full bg-accent px-1.5 text-xs text-white">{unread}</span> : null}
                {unread > 0 ? <span className="sr-only"> ({unread} unread)</span> : null}
              </Link>
            )}
            {showSettings && (
              <Link href={`/app/${orgSlug}/settings`} className="text-ink-muted hover:text-ink">
                Settings
              </Link>
            )}
            <Badge tone="neutral">{ROLE_LABELS[ctx.effectiveRole]}</Badge>
            {/* The roles that hold assignments.view are exactly the roles with a Command Centre (ADR-112). */}
            {can(ctx, 'assignments.view') && (
              <Link href="/portfolio" className="text-ink-muted hover:text-ink">Command Centre</Link>
            )}
            <Link href="/select-organization" className="text-ink-muted hover:text-ink">Switch</Link>
            <Link href="/account" className="text-ink-muted hover:text-ink">Account</Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 py-8">
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
      </main>
    </div>
  );
}
