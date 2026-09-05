import 'server-only';

/**
 * `callApi` moved to `@/core/db` in Phase 2, when a second and third module needed it. Re-exported
 * here so the tenancy call sites keep their existing import path.
 */
export { callApi } from '@/core/db';
