-- MOTION — pgTAP · Team/Client Management (ADR-144), migration 20261012000001. Behaviour — who may
-- do what, who is told — is in test/integration/engagement.test.ts.
begin;
create extension if not exists pgtap;
select plan(9);

select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
            where oid in ('public.notifications'::regclass, 'public.action_comments'::regclass,
                          'public.engagement_items'::regclass, 'public.engagement_events'::regclass)),
          'the four engagement tables force row level security');
select ok(not has_table_privilege('authenticated', 'public.notifications', 'insert')
          and not has_table_privilege('authenticated', 'public.notifications', 'update'),
          'nobody writes a notification directly — only the server');
select ok(not has_table_privilege('authenticated', 'public.engagement_items', 'insert'),
          'nobody writes an engagement item directly');
select ok(position('user_id = ( SELECT app.uid()' in (select pg_get_expr(polqual, polrelid) from pg_policy
            where polname = 'notifications_select')) > 0, 'a notification is readable only by its recipient');
select ok(exists (select 1 from pg_trigger where tgname = 'append_only_guard' and tgrelid = 'public.action_comments'::regclass),
          'comments are append-only');
select ok(exists (select 1 from pg_trigger where tgname = 'append_only_guard' and tgrelid = 'public.engagement_events'::regclass),
          'item history is append-only');
select ok(position('p_user is not distinct from p_actor' in pg_get_functiondef('app.notify(uuid, uuid, uuid, text, text, text, text, text)'::regprocedure)) > 0,
          'nobody is notified of their own doing');
select ok(position('has_permission_of(p_user, p_org, p_permission)' in pg_get_functiondef('app.notify(uuid, uuid, uuid, text, text, text, text, text)'::regprocedure)) > 0,
          'nobody is notified of something they may not open');
select ok(position('''notifications''' in pg_get_functiondef('api_server.purge_organization(uuid, uuid)'::regprocedure)) > 0,
          'the purge deletes the inbox and the engagement records');

select * from finish();
rollback;
