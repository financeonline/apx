/**
 * `server-only` throws on import outside a React Server Component. That guard exists to fail a
 * client bundle at build time, which is exactly what we want in production — see the modules that
 * import it in src/modules/tenancy/services and src/core/db.
 *
 * Vitest is neither a client nor a server bundle, so the real package throws on any test that
 * reaches a service barrel. Aliasing it to this no-op keeps the production guard intact while
 * letting tests import through the module's public index as ADR-022 requires.
 */
export {};
