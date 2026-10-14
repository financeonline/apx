/**
 * MOTION local ESLint rules.
 *
 * These are not style rules. Each one mechanically enforces a rule the architecture
 * relies on for security or correctness (SERVICE_ARCHITECTURE.md §8, TEST_STRATEGY.md §1).
 * A violation is a CI failure, not a warning.
 */

/*
 * The three REQUEST-PATH files permitted to hold the service role (ADR-013, ADR-043), plus the
 * integration harness.
 *
 * The harness is on the list for the same reason it already holds `SUPABASE_JWT_SECRET` — the most
 * dangerous secret in the repository — which it needs in order to mint the user tokens every
 * isolation test runs under. What this rule protects against is the service role reaching a browser
 * bundle or a request path, and a file that only ever runs against a local database under `vitest`
 * is neither. Object storage is the one thing `adminSql` cannot reach, so TEST_STRATEGY.md §4
 * case 5 has nowhere else to stand.
 */
const SERVICE_ROLE_FILES = [
  'src/core/db/service-client.ts',
  'src/core/db/server-rpc.ts',
  'src/core/storage/signer.ts',
  'test/integration/setup.ts',
];

const norm = (f) => f.replaceAll('\\', '/');
const inAnyOf = (filename, list) => list.some((p) => norm(filename).endsWith(p));

/** ADR-013/ADR-038.1/ADR-043: the service-role key exists in exactly three files. */
const noServiceRoleOutsideSanctionedFiles = {
  meta: {
    type: 'problem',
    docs: { description: 'SUPABASE_SERVICE_ROLE_KEY may only be read in the three sanctioned files' },
    schema: [],
    messages: {
      forbidden:
        'SUPABASE_SERVICE_ROLE_KEY is readable only in core/db/service-client.ts, core/db/server-rpc.ts and core/storage/signer.ts (ADR-013, ADR-043).',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (inAnyOf(filename, SERVICE_ROLE_FILES)) return {};
    return {
      Literal(node) {
        if (typeof node.value === 'string' && node.value.includes('SUPABASE_SERVICE_ROLE_KEY')) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
      Identifier(node) {
        if (node.name === 'SUPABASE_SERVICE_ROLE_KEY') {
          context.report({ node, messageId: 'forbidden' });
        }
      },
    };
  },
};

/**
 * ADR-026: no table writes from application code. Writes go through rpc('api.*').
 * Flags .insert()/.update()/.delete()/.upsert() chained off a supabase query builder.
 */
const noDirectTableWrite = {
  meta: {
    type: 'problem',
    docs: { description: 'Mutations must go through api.* RPC functions, never table writes' },
    schema: [{ type: 'object', properties: { allow: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      forbidden:
        "'{{method}}' writes a table directly. Every mutation is an api.* SECURITY DEFINER function called with rpc() (ADR-026, DATABASE_ARCHITECTURE.md §14).",
    },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? [];
    const filename = context.filename ?? context.getFilename();
    if (inAnyOf(filename, allow)) return {};
    const WRITE = new Set(['insert', 'update', 'upsert', 'delete']);
    return {
      MemberExpression(node) {
        if (node.property?.type !== 'Identifier' || !WRITE.has(node.property.name)) return;
        if (node.parent?.type !== 'CallExpression' || node.parent.callee !== node) return;
        // Only flag when it hangs off a `.from(...)` chain, i.e. a PostgREST query builder.
        let cur = node.object;
        while (cur && cur.type === 'CallExpression') cur = cur.callee;
        while (cur && cur.type === 'MemberExpression') {
          if (cur.property?.type === 'Identifier' && cur.property.name === 'from') {
            context.report({ node, messageId: 'forbidden', data: { method: node.property.name } });
            return;
          }
          cur = cur.object;
          while (cur && cur.type === 'CallExpression') cur = cur.callee;
        }
      },
    };
  },
};

/** ADR-043: api_server.* is reachable only through core/db/server-rpc.ts. */
const noApiServerOutsideServerRpc = {
  meta: {
    type: 'problem',
    docs: { description: 'api_server.* functions are called only from core/db/server-rpc.ts' },
    schema: [],
    messages: {
      forbidden:
        "api_server.* is service-role only and must be called through serverRpc() in core/db/server-rpc.ts (ADR-043).",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (norm(filename).endsWith('src/core/db/server-rpc.ts')) return {};
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        // Both spellings: a qualified name 'api_server.fn' and the supabase-js
        // `.schema('api_server').rpc(...)` calling convention.
        const isQualified = node.value.startsWith('api_server.');
        const isSchemaArg =
          node.value === 'api_server' &&
          node.parent?.type === 'CallExpression' &&
          node.parent.callee?.type === 'MemberExpression' &&
          node.parent.callee.property?.type === 'Identifier' &&
          node.parent.callee.property.name === 'schema';
        if (isQualified || isSchemaArg) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
    };
  },
};

/** ADR-013/TENANCY_MODEL.md §7: every service-role query filters by organization_id. */
const noUnscopedServiceQuery = {
  meta: {
    type: 'problem',
    docs: { description: 'Service-role queries must be organization-scoped' },
    schema: [],
    messages: {
      unscoped:
        "Service-role query on '{{table}}' has no .eq('organization_id', …) in its chain. Use withOrgScope and scope every query (ADR-013).",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    // Only meaningful where a service client can exist.
    if (!/src\/(core\/db|modules\/[^/]+\/(data|jobs))\//.test(norm(filename))) return {};
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type !== 'MemberExpression') return;
        if (callee.property?.type !== 'Identifier' || callee.property.name !== 'from') return;
        const receiver = callee.object;
        const receiverName =
          receiver?.type === 'Identifier' ? receiver.name : receiver?.property?.name ?? '';
        if (!/service|admin|scoped/i.test(String(receiverName))) return;
        const table = node.arguments[0]?.type === 'Literal' ? String(node.arguments[0].value) : 'table';
        // `public.organizations` is the one table whose OWN primary key is the organization id, so
        // `.eq('id', orgId)` scopes it exactly as `.eq('organization_id', …)` scopes every other
        // table. Naming it here rather than loosening the rule keeps the exemption to one table.
        const scopeColumns = table === 'organizations'
          ? ['organization_id', 'id']
          : ['organization_id'];
        // Walk up the chain looking for the scope filter.
        let cur = node.parent;
        let scoped = false;
        while (cur && (cur.type === 'MemberExpression' || cur.type === 'CallExpression' || cur.type === 'AwaitExpression')) {
          if (
            cur.type === 'CallExpression' &&
            cur.callee?.type === 'MemberExpression' &&
            cur.callee.property?.type === 'Identifier' &&
            ['eq', 'match', 'in'].includes(cur.callee.property.name) &&
            cur.arguments[0]?.type === 'Literal' &&
            scopeColumns.includes(String(cur.arguments[0].value))
          ) {
            scoped = true;
            break;
          }
          cur = cur.parent;
        }
        if (!scoped) context.report({ node, messageId: 'unscoped', data: { table } });
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
    'no-service-role-outside-sanctioned-files': noServiceRoleOutsideSanctionedFiles,
    'no-direct-table-write': noDirectTableWrite,
    'no-api-server-outside-server-rpc': noApiServerOutsideServerRpc,
    'no-unscoped-service-query': noUnscopedServiceQuery,
    'no-money-parsefloat': noMoneyParsefloat,
    'no-arithmetic-in-components': noArithmeticInComponents,
    'no-deep-module-import': noDeepModuleImport,
    'no-role-name-literals': noRoleNameLiterals,
  },
};
