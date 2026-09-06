import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import next from 'eslint-config-next';
import motion from './eslint-rules/index.js';

export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'supabase/**', 'next-env.d.ts', 'eslint-rules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,
  {
    plugins: { motion },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Architecture enforcement (SERVICE_ARCHITECTURE.md §8, TEST_STRATEGY.md §1)
      'motion/no-service-role-outside-sanctioned-files': 'error',
      'motion/no-api-server-outside-server-rpc': 'error',
      'motion/no-unscoped-service-query': 'error',
      'motion/no-money-parsefloat': 'error',
      'motion/no-arithmetic-in-components': 'error',
      'motion/no-deep-module-import': 'error',
      'motion/no-direct-table-write': 'error',
      'motion/no-role-name-literals': [
        'error',
        { allow: ['src/core/permissions/', 'src/modules/tenancy/domain/', 'src/modules/tenancy/services/resolve-access.ts'] },
      ],
    },
  },
  // Layering (ADR-022): app -> modules -> core, downward only.
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@supabase/*'], message: 'Components and routes never import Supabase directly; use modules/* services (ADR-013).' },
            { group: ['@anthropic-ai/*'], message: 'Only modules/ai/data/claude-client.ts imports the Anthropic SDK (ADR-023).' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@/modules/*', '@/app/*'], message: 'core must not depend on modules or app (ADR-022).' }] },
      ],
    },
  },
  {
    files: ['src/modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@supabase/*', '@/core/db', '@/core/db/*'], message: 'domain/ is pure: no I/O (ADR-022).' },
            { group: ['next/*', 'react'], message: 'domain/ is framework-free (ADR-022).' },
          ],
        },
      ],
    },
  },
  /*
   * These three rules describe what PRODUCTION code may do. The security suites exist precisely to
   * prove the database refuses the forbidden thing, so they must be able to write the forbidden
   * thing: rls-isolation.test.ts attempts a table write on all 13 tables and calls api_server.* with
   * a user JWT, and asserts each is rejected. Silencing the rules here does not widen production —
   * every one of them is still enforced across src/, and the refusal is enforced by the database.
   */
  {
    files: ['test/**/*.ts', 'e2e/**/*.ts', 'scripts/**/*.ts', 'vitest.config.ts', 'playwright.config.ts'],
    rules: {
      'no-console': 'off',
      'motion/no-direct-table-write': 'off',
      'motion/no-role-name-literals': 'off',
      'motion/no-api-server-outside-server-rpc': 'off',
    },
  },
);
