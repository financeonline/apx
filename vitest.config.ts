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
      /*
       * TEST_STRATEGY.md §1 gates coverage on the code where a silent error is most expensive: the
       * permission core, the pure tenancy resolution, and — from Phase 4 — the calculation engine
       * and the banking rules. IMPLEMENTATION_PLAN.md Phase 6's exit gate is ≥95% on
       * `financial-engine/domain`, and the same standard applies to the banking rules that feed it,
       * because a wrong transfer classification is a wrong cash figure.
       */
      include: [
        'src/core/permissions/**',
        'src/core/money/**',
        'src/modules/tenancy/domain/**',
        'src/modules/financial-engine/domain/**',
        'src/modules/banking/domain/**',
        'src/modules/health/domain/**',
        'src/modules/alerts/domain/**',
      ],
      thresholds: {
        /*
         * Per-directory, so the gate is a statement about each area rather than an average that a
         * well-covered module can carry a poorly-covered one through.
         *
         * `financial-engine/domain` carries IMPLEMENTATION_PLAN.md Phase 6's stated exit gate of
         * ≥95%, met on every metric.
         *
         * `banking/domain` is at 100% statements, lines and functions. Its branch figure is held at
         * 88 because the residue is unreachable by construction rather than untested: comparator
         * tails that only fire for two identical uuids, and defensive fallbacks kept deliberately
         * (`?? 'transfer'` cannot be reached because `transferKindFor` never returns `none` for two
         * real accounts, but deleting the fallback would make a future change silently produce a
         * null category). Chasing those to 95 would mean deleting guards for a number.
         */
        'src/modules/financial-engine/domain/**': {
          lines: 95, branches: 95, functions: 95, statements: 95,
        },
        'src/modules/banking/domain/**': {
          lines: 95, branches: 88, functions: 95, statements: 95,
        },
        /*
         * The health engine is a calculation engine and is gated like one: it produces the single
         * most prominent number in the product, and a wrong band is a wrong claim about somebody's
         * business. Branches sit at 90 rather than 95 because the residue is defensive — the
         * unreachable catch-all in `bandOf` (asserted by a test that constructs a broken rule), and
         * null guards on values the database's own types make impossible.
         */
        'src/modules/health/domain/**': {
          lines: 95, branches: 90, functions: 95, statements: 95,
        },
        /*
         * The condition rules health counts. Their branch figure is held at 85: most of the residue
         * is the `?? null` and optional-chaining tails on values that arrive from `numeric` columns
         * and therefore cannot be unreadable in production — the guards are kept because a rule that
         * throws would take a whole calculation run down with it, and deleting them to chase a
         * number would be trading a real protection for a percentage.
         */
        'src/modules/alerts/domain/**': {
          lines: 95, branches: 85, functions: 95, statements: 95,
        },
        'src/core/permissions/**': { lines: 90, branches: 95, functions: 50, statements: 90 },
        'src/core/money/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
        'src/modules/tenancy/domain/**': { lines: 95, branches: 95, functions: 95, statements: 95 },
      },
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
          name: 'eval',
          include: ['test/eval/**/*.test.ts'],
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
