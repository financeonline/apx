-- MOTION — pgTAP · public.role_permissions parity with RBAC_MATRIX.md §2.1.
-- Contract: TEST_STRATEGY.md §2 ("Matrix exhaustiveness", "Deny-by-default"), ADR-003.
--
-- role_permissions is the generated mirror of ROLE_MATRIX; app.has_permission() reads nothing else,
-- so a drift here silently changes authorisation everywhere. The first assertion is the full
-- 141-pair set comparison transcribed from the markdown table (ADR-172 added the accountant and
-- third_party columns); the rest are the named
-- representative pairs the strategy calls out, so a failure names the exact cell that drifted.

begin;
create extension if not exists pgtap;

select plan(116);

-- ---------------------------------------------------------------------------
-- 1. Full parity: the table equals RBAC_MATRIX.md §2.1, cell for cell.
-- ---------------------------------------------------------------------------
select set_eq(
  $$ select role || '|' || permission from public.role_permissions $$,
  $$ values
     -- super_admin: every permission (34)
     ('super_admin|dashboard.view'),('super_admin|financials.view'),('super_admin|financials.edit'),
     ('super_admin|imports.create'),('super_admin|imports.review'),('super_admin|banking.view'),
     ('super_admin|banking.reconcile'),('super_admin|customers.view'),('super_admin|customers.edit'),
     ('super_admin|reports.view'),('super_admin|reports.generate'),('super_admin|ai.use'),
     ('super_admin|actions.view'),('super_admin|actions.create'),('super_admin|actions.assign'),
     ('super_admin|actions.update_own'),('super_admin|alerts.manage'),('super_admin|intelligence.recompute'),
     ('super_admin|users.view'),('super_admin|users.invite'),('super_admin|users.manage'),
     ('super_admin|assignments.view'),('super_admin|assignments.manage'),('super_admin|documents.view'),
     ('super_admin|data.export'),('super_admin|audit.view'),('super_admin|settings.manage'),
     ('super_admin|billing.manage'),('super_admin|org.delete'),('super_admin|system.manage'),
     ('super_admin|platform.orgs.manage'),('super_admin|platform.users.manage'),
     ('super_admin|platform.ai_feedback.review'),('super_admin|platform.jobs.view'),
     -- employee (22): no governance, no settings, no audit, no billing
     ('employee|dashboard.view'),('employee|financials.view'),('employee|financials.edit'),
     ('employee|imports.create'),('employee|imports.review'),('employee|banking.view'),
     ('employee|banking.reconcile'),('employee|customers.view'),('employee|customers.edit'),
     ('employee|reports.view'),('employee|reports.generate'),('employee|ai.use'),
     ('employee|actions.view'),('employee|actions.create'),('employee|actions.assign'),
     ('employee|actions.update_own'),('employee|alerts.manage'),('employee|intelligence.recompute'),
     ('employee|assignments.view'),('employee|documents.view'),('employee|data.export'),
     ('employee|platform.ai_feedback.review'),
     -- owner (29): everything tenant-side, nothing under /platform
     ('owner|dashboard.view'),('owner|financials.view'),('owner|financials.edit'),
     ('owner|imports.create'),('owner|imports.review'),('owner|banking.view'),
     ('owner|banking.reconcile'),('owner|customers.view'),('owner|customers.edit'),
     ('owner|reports.view'),('owner|reports.generate'),('owner|ai.use'),
     ('owner|actions.view'),('owner|actions.create'),('owner|actions.assign'),
     ('owner|actions.update_own'),('owner|alerts.manage'),('owner|intelligence.recompute'),
     ('owner|users.view'),('owner|users.invite'),('owner|users.manage'),
     ('owner|assignments.view'),('owner|assignments.manage'),('owner|documents.view'),
     ('owner|data.export'),('owner|audit.view'),('owner|settings.manage'),
     ('owner|billing.manage'),('owner|org.delete'),
     -- admin (26): owner minus assignments.manage, billing.manage, org.delete
     ('admin|dashboard.view'),('admin|financials.view'),('admin|financials.edit'),
     ('admin|imports.create'),('admin|imports.review'),('admin|banking.view'),
     ('admin|banking.reconcile'),('admin|customers.view'),('admin|customers.edit'),
     ('admin|reports.view'),('admin|reports.generate'),('admin|ai.use'),
     ('admin|actions.view'),('admin|actions.create'),('admin|actions.assign'),
     ('admin|actions.update_own'),('admin|alerts.manage'),('admin|intelligence.recompute'),
     ('admin|users.view'),('admin|users.invite'),('admin|users.manage'),
     ('admin|assignments.view'),('admin|documents.view'),('admin|data.export'),
     ('admin|audit.view'),('admin|settings.manage'),
     -- accountant (18, ADR-172): data capture and compliance; no AI, team, settings or assigning
     ('accountant|dashboard.view'),('accountant|financials.view'),('accountant|financials.edit'),
     ('accountant|imports.create'),('accountant|imports.review'),('accountant|banking.view'),
     ('accountant|banking.reconcile'),('accountant|customers.view'),('accountant|customers.edit'),
     ('accountant|reports.view'),('accountant|reports.generate'),('accountant|actions.view'),
     ('accountant|actions.create'),('accountant|actions.update_own'),('accountant|alerts.manage'),
     ('accountant|intelligence.recompute'),('accountant|documents.view'),('accountant|data.export'),
     -- client (9): read-only plus own actions and alert acknowledgement
     ('client|dashboard.view'),('client|financials.view'),('client|banking.view'),
     ('client|customers.view'),('client|reports.view'),('client|ai.use'),
     ('client|actions.view'),('client|actions.update_own'),('client|alerts.manage'),
     -- third_party (2, ADR-172): the overview and the reports, nothing beneath them
     ('third_party|dashboard.view'),('third_party|reports.view'),
     -- suspended_member (1): frozen Home only (ADR-044.4)
     ('suspended_member|dashboard.view')
  $$,
  'role_permissions equals RBAC_MATRIX.md §2.1 cell for cell (141 pairs)');

-- ---------------------------------------------------------------------------
-- 2. Cardinality per role — a fast locator when the set comparison above fails.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.role_permissions where role = 'super_admin'), 34,
          'super_admin holds all 34 permissions');
select is((select count(*)::int from public.role_permissions where role = 'employee'), 22,
          'employee holds 22 permissions');
select is((select count(*)::int from public.role_permissions where role = 'owner'), 29,
          'owner holds 29 permissions');
select is((select count(*)::int from public.role_permissions where role = 'admin'), 26,
          'admin holds 26 permissions');
select is((select count(*)::int from public.role_permissions where role = 'client'), 9,
          'client holds 9 permissions');
select is((select count(*)::int from public.role_permissions where role = 'accountant'), 18,
          'accountant holds 18 permissions (ADR-172)');
select is((select count(*)::int from public.role_permissions where role = 'third_party'), 2,
          'third_party holds 2 permissions (ADR-172)');
select is((select count(*)::int from public.role_permissions where role = 'suspended_member'), 1,
          'suspended_member holds 1 permission');

select is((select count(distinct permission)::int from public.role_permissions), 34,
          'the permission universe is exactly 34 strings');

-- Deny-by-default: an unknown/absent role resolves to nothing at all.
select is((select count(*)::int from public.role_permissions where role = 'none'), 0,
          'the role `none` holds no permission (deny-by-default)');

-- ---------------------------------------------------------------------------
-- 3. The representative cells named in TEST_STRATEGY.md §2, one assertion each.
-- ---------------------------------------------------------------------------
select is(
  exists (select 1 from public.role_permissions rp
           where rp.role = e.role and rp.permission = e.perm),
  e.granted,
  format('%s %s %s', e.role, case when e.granted then 'HAS' else 'has NO' end, e.perm))
from (values
  -- employee: no member list, no invitations, no governance, no audit, no settings, no billing
  ('employee', 'users.view',                   false),
  ('employee', 'users.invite',                 false),
  ('employee', 'users.manage',                 false),
  ('employee', 'audit.view',                   false),
  ('employee', 'settings.manage',              false),
  ('employee', 'billing.manage',               false),
  ('employee', 'org.delete',                   false),
  ('employee', 'system.manage',                false),
  ('employee', 'platform.orgs.manage',         false),
  ('employee', 'platform.users.manage',        false),
  ('employee', 'platform.jobs.view',           false),
  ('employee', 'dashboard.view',               true),
  ('employee', 'financials.edit',              true),
  ('employee', 'imports.create',               true),
  ('employee', 'imports.review',               true),
  ('employee', 'intelligence.recompute',       true),
  ('employee', 'assignments.view',             true),
  ('employee', 'documents.view',               true),
  ('employee', 'data.export',                  true),
  ('employee', 'platform.ai_feedback.review',  true),
  -- client: read-only tenant; no writes, no documents, no export, no audit
  ('client',   'financials.edit',              false),
  ('client',   'imports.create',               false),
  ('client',   'imports.review',               false),
  ('client',   'documents.view',               false),
  ('client',   'data.export',                  false),
  ('client',   'audit.view',                   false),
  ('client',   'banking.reconcile',            false),
  ('client',   'customers.edit',               false),
  ('client',   'reports.generate',             false),
  ('client',   'settings.manage',              false),
  ('client',   'users.view',                   false),
  ('client',   'actions.create',               false),
  ('client',   'actions.assign',               false),
  ('client',   'intelligence.recompute',       false),
  ('client',   'assignments.view',             false),
  ('client',   'dashboard.view',               true),
  ('client',   'financials.view',              true),
  ('client',   'banking.view',                 true),
  ('client',   'customers.view',               true),
  ('client',   'reports.view',                 true),
  ('client',   'ai.use',                       true),
  ('client',   'actions.view',                 true),
  ('client',   'actions.update_own',           true),
  ('client',   'alerts.manage',                true),
  -- admin: full tenant operations, but no billing, no deletion, nothing platform-side
  ('admin',    'billing.manage',               false),
  ('admin',    'org.delete',                   false),
  ('admin',    'system.manage',                false),
  ('admin',    'assignments.manage',           false),
  ('admin',    'platform.orgs.manage',         false),
  ('admin',    'platform.users.manage',        false),
  ('admin',    'platform.ai_feedback.review',  false),
  ('admin',    'platform.jobs.view',           false),
  ('admin',    'users.view',                   true),
  ('admin',    'users.invite',                 true),
  ('admin',    'users.manage',                 true),
  ('admin',    'audit.view',                   true),
  ('admin',    'settings.manage',              true),
  ('admin',    'assignments.view',             true),
  ('admin',    'documents.view',               true),
  ('admin',    'data.export',                  true),
  -- owner: everything tenant-side, nothing under /platform
  ('owner',    'system.manage',                false),
  ('owner',    'platform.orgs.manage',         false),
  ('owner',    'platform.users.manage',        false),
  ('owner',    'platform.ai_feedback.review',  false),
  ('owner',    'platform.jobs.view',           false),
  ('owner',    'billing.manage',               true),
  ('owner',    'org.delete',                   true),
  ('owner',    'assignments.manage',           true),
  ('owner',    'users.manage',                 true),
  ('owner',    'audit.view',                   true),
  ('owner',    'settings.manage',              true),
  -- suspended_member: frozen Home and nothing else (ADR-044.4)
  ('suspended_member', 'dashboard.view',       true),
  ('suspended_member', 'financials.view',      false),
  ('suspended_member', 'reports.view',         false),
  ('suspended_member', 'ai.use',               false),
  ('suspended_member', 'actions.view',         false),
  ('suspended_member', 'users.view',           false),
  ('suspended_member', 'audit.view',           false),
  -- accountant (ADR-172): brings the data in and keeps it right; no AI, team, settings or assigning
  ('accountant', 'ai.use',                     false),
  ('accountant', 'users.view',                 false),
  ('accountant', 'users.invite',               false),
  ('accountant', 'users.manage',               false),
  ('accountant', 'assignments.view',           false),
  ('accountant', 'audit.view',                 false),
  ('accountant', 'settings.manage',            false),
  ('accountant', 'billing.manage',             false),
  ('accountant', 'org.delete',                 false),
  ('accountant', 'actions.assign',             false),
  ('accountant', 'imports.create',             true),
  ('accountant', 'imports.review',             true),
  ('accountant', 'documents.view',             true),
  ('accountant', 'financials.edit',            true),
  -- third_party (ADR-172): the overview and the reports, nothing beneath them
  ('third_party', 'dashboard.view',            true),
  ('third_party', 'reports.view',              true),
  ('third_party', 'financials.view',           false),
  ('third_party', 'banking.view',              false),
  ('third_party', 'customers.view',            false),
  ('third_party', 'documents.view',            false),
  ('third_party', 'ai.use',                    false),
  ('third_party', 'actions.view',              false),
  ('third_party', 'alerts.manage',             false),
  ('third_party', 'imports.create',            false),
  ('third_party', 'data.export',               false),
  ('third_party', 'users.view',                false),
  ('third_party', 'settings.manage',           false)
) as e(role, perm, granted);

select * from finish();
rollback;
