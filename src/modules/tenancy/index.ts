export type { AccessContext } from './context';
export {
  MODULES, MODULE_KEYS, enabledModules, isModuleKey, moduleDefinition, type ModuleDefinition, type ModuleKey,
} from './domain/modules';
export { moduleOn, requireModule } from './services/modules';
export type { ActorType, OrgStatus, MembershipRole } from './domain/types';
export { resolveEffectiveRole, type ResolutionInput } from './domain/resolve';
export { getAccessContext, getPlatformContext, resolveAccessFresh, resolvePlatformRole } from './services/resolve-access';
export { confirmPassword } from './services/confirm-password';
export {
  createOrganization,
  updateOrganization,
  setVatRegistration,
  vatStatusOf,
  VatStatus,
  setTaxSettings,
  taxSettingsOf,
  TaxSettingsInput,
  VatScheme,
  setCurrencyAndCountry,
  CurrencyAndCountryInput,
  OrgCurrency,
  OrgCountry,
  type TaxSettings,
  requestDeletion,
  cancelDeletion,
  listMyOrganizations,
  setLastActiveOrg,
  CreateOrganizationInput,
  type OrganizationSummary,
} from './services/organizations';
export {
  listMembers,
  listInvitations,
  listAdvisers,
  inviteMember,
  revokeInvitation,
  acceptInvitation,
  changeMemberRole,
  setMemberStatus,
  removeMember,
  leaveOrganization,
  initiateOwnershipTransfer,
  acceptOwnershipTransfer,
  cancelOwnershipTransfer,
  revokeAssignment,
  type Member,
  type PendingInvitation,
  type Adviser,
} from './services/membership';
export { listOrgAuditEvents, type AuditEntry } from './services/audit';
// ADR-172: company roles, per-person permissions and "Request more information".
export {
  TENANT_ROLES,
  ROLE_NAMES,
  SWITCHABLE_PERMISSIONS,
  PERMISSION_WORDS,
  type TenantRole,
  type SwitchablePermission,
  type MemberPermissions,
  type AccessRequest,
  type AccessRequestStatus,
} from './domain/member-access';
export {
  isSwitchable,
  takesSwitches,
  mayRequestAccess,
  parseOverrides,
  agreedPermissions,
  resolvePermissions,
  switchableDefaults,
  switchableEffective,
  withinOwnRights,
  type PermissionOverride,
} from './domain/permissions';
export {
  listMemberPermissions,
  setMemberPermission,
  requestAccess,
  listAccessRequests,
  decideAccessRequest,
  withdrawAccessRequest,
} from './services/member-access';
