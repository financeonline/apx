/**
 * Pure tenancy types. No I/O, no framework: `domain/` must stay unit-testable in isolation
 * (ADR-022), which is why AccessContext — it carries a database client — lives one level up in
 * `modules/tenancy/context.ts` rather than here.
 */
export type OrgStatus = 'active' | 'suspended' | 'pending_deletion' | 'deleted';
export type MembershipRole = 'owner' | 'admin' | 'client';
export type ActorType = 'user' | 'employee' | 'platform_admin' | 'system' | 'ai';
