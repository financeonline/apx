import type { SupabaseClient } from '@supabase/supabase-js';
import type { Permission, EffectiveRole } from '@/core/permissions';
import type { ActorType, OrgStatus } from './domain/types';

/**
 * Everything a service needs to authorise and act (SERVICE_ARCHITECTURE.md §3).
 * Built once per request by getAccessContext() and never re-derived from client input.
 */
export interface AccessContext {
  readonly userId: string;
  readonly orgId: string | null;
  readonly orgSlug: string | null;
  readonly effectiveRole: EffectiveRole;
  readonly permissions: ReadonlySet<Permission>;
  readonly actorType: ActorType;
  /** User-session client: SELECT under RLS and EXECUTE on api.*; it holds no write privilege. */
  readonly db: SupabaseClient;
  readonly requestId: string;
  readonly now: () => Date;
  /** Present so the UI can render the frozen-Home banner (ADR-044.4). */
  readonly organizationStatus: OrgStatus | null;
}
