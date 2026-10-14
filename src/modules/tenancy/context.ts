import type { SupabaseClient } from '@supabase/supabase-js';
import type { Permission, EffectiveRole } from '@/core/permissions';
import type { ActorType, OrgStatus } from './domain/types';
import type { ModuleKey } from './domain/modules';
import type { DepartmentKey } from './domain/member-access';

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
  /**
   * ADR-158: the systems this organisation may use, as the super admin set them. Absent (platform
   * contexts, tests) means every default-on system — see `moduleOn`.
   */
  readonly modules?: ReadonlySet<ModuleKey>;
  /**
   * ADR-173: the departments this member was given; null (or absent) = all of the company's. Already
   * applied to `modules`; kept so the team page knows what this person may hand on.
   */
  readonly departments?: readonly DepartmentKey[] | null;
}
