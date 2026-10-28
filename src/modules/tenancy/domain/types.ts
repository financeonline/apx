/**
 * Pure tenancy types. No I/O, no framework: `domain/` must stay unit-testable in isolation
 * (ADR-022), which is why AccessContext — it carries a database client — lives one level up in
 * `modules/tenancy/context.ts` rather than here.
 */
import type { TenantRole } from './member-access';

export type OrgStatus = 'active' | 'suspended' | 'pending_deletion' | 'deleted';
/**
 * A company role as stored on a membership: the contract's TENANT_ROLES (ADR-172 added `accountant`
 * and `third_party`). One name kept for the existing call sites.
 */
export type MembershipRole = TenantRole;
export type ActorType = 'user' | 'employee' | 'platform_admin' | 'system' | 'ai';

/**
 * A person's id is their Firebase Auth uid — not a uuid (FIRESTORE_DATA_MODEL.md §3): letters,
 * digits, `-` and `_`, at most 128 characters. Row ids (invitations, transfers, requests) stay uuids.
 */
export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export function isUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID_PATTERN.test(value);
}
