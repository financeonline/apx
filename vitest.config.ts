import { defineConfig } from 'vitest/config';
import path from 'node:path';

const alias = {
  '@': path.resolve(process.cwd(), 'src'),
  // See test/stubs/server-only.ts: the real package throws outside an RSC bundle.
  'server-only': path.resolve(process.cwd(), 'test/stubs/server-only.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    // Every integration file talks to the one local Supabase instance and each calls
    // resetFixtures(), which deletes every `itest-` row — including rows another file is still
    // asserting on. Files must run one at a time.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // TEST_STRATEGY.md §1 gates coverage on the permission core and the pure resolution logic.
      include: ['src/core/permissions/**', 'src/modules/tenancy/domain/**'],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 60_000,
          setupFiles: ['test/integration/setup.ts'],
        },
      },
    ],
  },
});
