export type { AccessContext } from './context';
export {
  MODULES, MODULE_KEYS, enabledModules, isModuleKey, moduleDefinition, type ModuleDefinition, type ModuleKey,
} from './domain/modules';
export { moduleOn, requireModule } from './services/modules';
export type { ActorType, OrgStatus, MembershipRole } from './domain/types';
export { resolveEffectiveRole, type ResolutionInput } from './domain/resolve';
export { getAccessContext, getPlatformContext, resolveAccessFresh, resolvePlatformRole, narrowToDepartments } from './services/resolve-access';
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
  DEPARTMENT_KEYS,
  DEPARTMENT_WORDS,
  isDepartmentKey,
  type DepartmentKey,
  type MemberDepartments,
} from './domain/member-access';
// ADR-173: a company creates its team members' logins and chooses their departments.
export {
  LOGIN_ROLES,
  createMemberLogin,
  mayCreateMembers,
  listMemberDepartments,
  setMemberDepartments,
  departmentsAvailable,
  type LoginRole,
} from './services/team-logins';
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
  setsOwnerSwitches,
  parseOverrideDetails,
  type PermissionOverride,
  type PermissionOverrideDetail,
} from './domain/permissions';
export {
  listMemberPermissions,
  setMemberPermission,
  resetMemberPermissions,
  requestAccess,
  listAccessRequests,
  decideAccessRequest,
  withdrawAccessRequest,
} from './services/member-access';
// ADR-172 follow-up: where a person lands in a company — Departments, or Home without `financials.view`.
export {
  DEPARTMENTS_PERMISSION,
  landingPath,
  landingPathForRole,
  landingSection,
  type LandingSection,
} from './domain/landing';
