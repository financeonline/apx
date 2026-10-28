/**
 * MOTION local ESLint rules.
 *
 * These are not style rules. Each one mechanically enforces a rule the architecture
 * relies on for security or correctness (SERVICE_ARCHITECTURE.md §8, TEST_STRATEGY.md §1).
 * A violation is a CI failure, not a warning.
 */

/*
 * Where the Firebase Admin SDK may be used (FIRESTORE_DATA_MODEL.md §2).
 *
 * The Admin SDK bypasses the security rules, so the code holding it IS the tenant boundary: the
 * database layer (`src/db`, which holds every read policy and every write function), its two entry
 * points (`src/core/db`, `src/core/storage`), the request gatekeeper and the session route that
 * turn a Firebase ID token into a session cookie. Tests and scripts are outside production.
 */
const ADMIN_SDK_PATHS = [
  'src/db/',
  'src/core/db/',
  'src/core/storage/',
  'src/proxy.ts',
  'src/app/auth/',
];

const norm = (f) => f.replaceAll('\\', '/');
const inAnyOf = (filename, list) => list.some((p) => norm(filename).includes(p));
const isOutsideProduction = (filename) => /(^|\/)(test|e2e|scripts)\//.test(norm(filename));

/** ADR-013/ADR-043: `firebase-admin` and `@/db/firestore` only where the boundary lives. */
const noAdminSdkOutsideSanctionedFiles = {
  meta: {
    type: 'problem',
    docs: { description: 'The Firebase Admin SDK may only be imported by the database layer' },
    schema: [],
    messages: {
      forbidden:
        "'{{source}}' bypasses the security rules; only src/db, src/core/db, src/core/storage, src/proxy.ts and src/app/auth may import it (FIRESTORE_DATA_MODEL.md §2).",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (inAnyOf(filename, ADMIN_SDK_PATHS) || isOutsideProduction(filename)) return {};
    return {
      ImportDeclaration(node) {
        // A type-only import (`import type { Query }`) is erased at build time: it reaches nothing.
        if (node.importKind === 'type') return;
        const source = String(node.source.value);
        if (source === 'firebase-admin' || source.startsWith('firebase-admin/') || source === '@/db/firestore') {
          context.report({ node, messageId: 'forbidden', data: { source } });
        }
      },
    };
  },
};

/**
 * ADR-026: application code never reads or writes Firestore directly. A module reads through
 * `src/db/rls.ts` (which applies the table's policy) and writes through `callApi` (an `api.*`
 * function that re-checks the caller). Reaching for the raw instance on a handle —
 * `ctx.db.fs.collection(...)`, `db.fs.doc(...)`, `scope.db.fs.runTransaction(...)` — skips both.
 */
const RAW_FIRESTORE = new Set([
  'collection', 'collectionGroup', 'doc', 'getAll', 'runTransaction', 'batch', 'bulkWriter', 'recursiveDelete',
]);
const noDirectTableWrite = {
  meta: {
    type: 'problem',
    docs: { description: 'Firestore is reached only through src/db (read policies and api.* functions)' },
    schema: [{ type: 'object', properties: { allow: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      forbidden:
        "'.fs.{{method}}' reaches Firestore around its checks. Read with orgRows/orgRowById (src/db/rls.ts) and write with callApi (an api.* function) (ADR-026, FIRESTORE_DATA_MODEL.md §2).",
    },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? [];
    const filename = context.filename ?? context.getFilename();
    if (inAnyOf(filename, allow) || inAnyOf(filename, ADMIN_SDK_PATHS)) return {};
    return {
      MemberExpression(node) {
        if (node.property?.type !== 'Identifier' || !RAW_FIRESTORE.has(node.property.name)) return;
        const obj = node.object;
        const viaFs = obj?.type === 'MemberExpression' && obj.property?.type === 'Identifier' && obj.property.name === 'fs';
        if (viaFs) context.report({ node, messageId: 'forbidden', data: { method: node.property.name } });
      },
    };
  },
};

/** ADR-043: `api_server.*` is reachable only through core/db/server-rpc.ts. */
const noApiServerOutsideServerRpc = {
  meta: {
    type: 'problem',
    docs: { description: 'api_server.* functions are called only from core/db/server-rpc.ts' },
    schema: [],
    messages: {
      forbidden:
        'api_server.* is server-only and must be called through the wrappers in core/db/server-rpc.ts (ADR-043).',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (norm(filename).endsWith('src/core/db/server-rpc.ts') || norm(filename).includes('src/db/')) return {};
    return {
      ImportDeclaration(node) {
        const source = String(node.source.value);
        if (source === '@/db/api_server' || source.startsWith('@/db/api_server/')) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
    };
  },
};

/** ADR-006: money crosses the wire as a string and is parsed with Decimal, never parseFloat/Number. */
const noMoneyParsefloat = {
  meta: {
    type: 'problem',
    docs: { description: 'Money values are parsed with Decimal, never parseFloat/Number' },
    schema: [],
    messages: {
      forbidden:
        "'{{fn}}' on a money field loses precision. Parse money with Decimal at the data-access boundary (ADR-006).",
    },
  },
  create(context) {
    const MONEY = /(amount|balance|total|value|subtotal|tax|price|cost|revenue|profit|cash|paid)/i;
    return {
      CallExpression(node) {
        const name =
          node.callee?.type === 'Identifier'
            ? node.callee.name
            : node.callee?.type === 'MemberExpression' && node.callee.property?.type === 'Identifier'
              ? node.callee.property.name
              : null;
        if (name !== 'parseFloat' && name !== 'Number') return;
        const arg = node.arguments[0];
        if (!arg) return;
        const text = context.sourceCode.getText(arg);
        if (MONEY.test(text)) context.report({ node, messageId: 'forbidden', data: { fn: name } });
      },
    };
  },
};

/** SERVICE_ARCHITECTURE.md §8.1: components render view models; they never do money arithmetic. */
const noArithmeticInComponents = {
  meta: {
    type: 'problem',
    docs: { description: 'No money arithmetic inside src/app components' },
    schema: [],
    messages: {
      forbidden:
        'Money arithmetic in a component. Services return formatted view models; components render them (SERVICE_ARCHITECTURE.md §8).',
    },
  },
  create(context) {
    const filename = norm(context.filename ?? context.getFilename());
    if (!filename.includes('/src/app/')) return {};
    const MONEY = /(amount|balance|total|subtotal|revenue|profit|cash|payable|receivable|price|cost)/i;
    return {
      BinaryExpression(node) {
        if (!['+', '-', '*', '/'].includes(node.operator)) return;
        const left = context.sourceCode.getText(node.left);
        const right = context.sourceCode.getText(node.right);
        if (MONEY.test(left) || MONEY.test(right)) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
    };
  },
};

/** ADR-022: modules expose index.ts only; deep imports are build errors. */
const noDeepModuleImport = {
  meta: {
    type: 'problem',
    docs: { description: 'Import modules through their index barrel only' },
    schema: [],
    messages: {
      deep:
        "Deep import '{{path}}'. Import a module through its public index (ADR-022).",
    },
  },
  create(context) {
    const filename = norm(context.filename ?? context.getFilename());
    const check = (node, value) => {
      if (typeof value !== 'string') return;
      const m = value.match(/^@\/modules\/([^/]+)\/(.+)$/);
      if (!m) return;
      const [, mod, rest] = m;
      // Inside the same module, deep paths are fine.
      if (filename.includes(`/src/modules/${mod}/`)) return;
      if (rest === 'index' || rest === 'index.ts') return;
      context.report({ node, messageId: 'deep', data: { path: value } });
    };
    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
    };
  },
};

/**
 * ADR-003 / R2-A-07: code never branches on role names; it asks can(ctx, permission).
 * A `role === 'client'` branch silently widens access for suspended_member.
 */
const noRoleNameLiterals = {
  meta: {
    type: 'problem',
    docs: { description: 'Do not compare against role name literals outside the permission core' },
    schema: [{ type: 'object', properties: { allow: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      forbidden:
        "Comparing against role name '{{name}}'. Test can(ctx, permission) instead — a role-name branch widens access for suspended_member (ADR-003, R2-A-07).",
    },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? [];
    const filename = context.filename ?? context.getFilename();
    if (inAnyOf(filename, allow) || allow.some((p) => norm(filename).includes(p))) return {};
    // ADR-172 adds the two company roles `accountant` and `third_party`: a `role === 'third_party'`
    // branch is exactly the widening this rule exists to stop.
    const ROLES = new Set(['owner', 'admin', 'accountant', 'client', 'third_party', 'employee', 'super_admin', 'suspended_member']);
    return {
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        for (const side of [node.left, node.right]) {
          if (side.type === 'Literal' && typeof side.value === 'string' && ROLES.has(side.value)) {
            const other = side === node.left ? node.right : node.left;
            const otherText = context.sourceCode.getText(other);
            // R2-A-07 is about the EFFECTIVE role, whose value set includes `suspended_member`:
            // a `<> 'client'` branch there silently widens a suspended client's access.
            // `platform_role` is a different enum (super_admin | employee) with no such value, and
            // middleware legitimately routes families by it, so it is not in scope.
            const isEffectiveRole =
              /\beffectiveRole\b/.test(otherText) ||
              (/\brole\b/.test(otherText) && !/platform_role/.test(otherText));
            if (isEffectiveRole) {
              context.report({ node, messageId: 'forbidden', data: { name: side.value } });
            }
          }
        }
      },
    };
  },
};

export default {
  rules: {
    'no-admin-sdk-outside-sanctioned-files': noAdminSdkOutsideSanctionedFiles,
    'no-direct-table-write': noDirectTableWrite,
    'no-api-server-outside-server-rpc': noApiServerOutsideServerRpc,
    'no-money-parsefloat': noMoneyParsefloat,
    'no-arithmetic-in-components': noArithmeticInComponents,
    'no-deep-module-import': noDeepModuleImport,
    'no-role-name-literals': noRoleNameLiterals,
  },
};
