export { PERMISSIONS, isPermission, type Permission } from './catalogue';
export { ROLE_MATRIX, matrixRows, type EffectiveRole, type GrantedRole } from './matrix';
export { can, assertCan, permissionsFor, isSuperAdmin, isPlatformStaff, type AuthzContext } from './check';
export {
  ceilingAllows,
  canInviteRole,
  canChangeRole,
  canRevokeAssignment,
  isSelfElevation,
  roleRank,
  type MembershipRole,
} from './guards';
