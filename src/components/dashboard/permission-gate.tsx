import type { ReactNode } from 'react';
import { can, type AuthzContext, type Permission } from '@/core/permissions';
import { DeniedState } from './states';

/**
 * One place that decides whether a control is on the page at all (UX_ARCHITECTURE.md §5, §7.4;
 * RBAC_MATRIX.md §5).
 *
 * An action the role lacks is HIDDEN, never disabled. A greyed-out "Delete organisation" tells a
 * client exactly which capabilities exist and who to ask for them, and invites a support request
 * about a button that was never theirs. Absence says nothing.
 *
 * `fallback: 'denied-state'` is for a whole page reached by a deep link, where saying nothing would
 * leave the reader staring at a blank screen. It says the reader lacks access and who to ask, and
 * nothing whatever about what the page contains (§7.4).
 *
 * This gate is a UX affordance, not a security boundary. The server action and the database policy
 * are the boundary; hiding a button no one can press keeps the interface honest.
 */
export function PermissionGate({
  ctx,
  permission,
  fallback = 'hide',
  organisationName,
  homeHref,
  children,
}: {
  ctx: AuthzContext;
  permission: Permission;
  fallback?: 'hide' | 'denied-state';
  /** Named in the denied state so the reader knows who to ask (§7.4). */
  organisationName?: string;
  homeHref?: string;
  children: ReactNode;
}) {
  if (can(ctx, permission)) return <>{children}</>;
  if (fallback === 'hide') return null;
  return <DeniedState organisationName={organisationName} homeHref={homeHref} />;
}
