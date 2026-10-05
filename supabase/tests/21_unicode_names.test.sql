-- MOTION — pgTAP · Unicode identity for names (ADR-136, migration 20261006000001).
-- The matching rules are the same table as test/unit/name-key.test.ts; parity with the TypeScript
-- key over every code point is test/integration/unicode-names.test.ts. Re-keying EXISTING rows is
-- exercised on a seeded baseline database by the upgrade job (scripts/sql/unicode-names-seed.sql).
begin;
create extension if not exists pgtap;
select plan(23);

-- ---- The rules --------------------------------------------------------------------------------

select is(
  (select count(*)::int from generate_series(1, 127) cp
    where app.normalize_name('a' || chr(cp) || 'b')
          <> btrim(regexp_replace(lower(btrim('a' || chr(cp) || 'b')), '[^a-z0-9]+', ' ', 'g'))),
  0, 'for every ASCII character the key is the old [a-z0-9] key, byte for byte');

select is(
  (select string_agg(rule, ', ') from (values
     ('case, Latin', 'Acme Ltd', 'ACME LTD'),
     ('punctuation and spacing', 'Acme & Co.', 'acme  co'),
     ('case, accented', 'Müller GmbH', 'MÜLLER GMBH'),
     ('combining accent', 'Müller', 'Mu' || chr(776) || 'ller'),
     ('full-width', 'Ａｃｍｅ', 'Acme'),
     ('ligature', 'ﬁnance', 'finance'),
     ('half-width katakana', 'ｶﾌﾞｼｷｶﾞｲｼｬ', 'カブシキガイシャ'),
     ('Greek, final sigma', 'ΟΔΟΣ Α.Ε.', 'οδος α.ε.'),
     ('Cyrillic', 'ООО «Ромашка»', 'ооо ромашка'),
     ('dotted capital I', 'İzmir', 'izmir'),
     ('Japanese middle dot', 'Tokyo・Trading', 'Tokyo Trading')) v(rule, a, b)
    where app.normalize_name(a) <> app.normalize_name(b) or app.normalize_name(a) = ''),
  null, 'every pair that is ONE name has one non-empty key');

select is(
  (select string_agg(rule, ', ') from (values
     ('different accented letter', 'Müller GmbH', 'Möller GmbH'),
     ('accent against none', 'Müller GmbH', 'Muller GmbH'),
     ('é against e', 'Café Sales', 'Cafe Sales'),
     ('Cyrillic look-alike', 'Асме', 'Acme'),
     ('Japanese', '株式会社トヨタ', '株式会社ホンダ'),
     ('Arabic', 'شركة الأمل', 'شركة النور'),
     ('Arabic-Indic digits', 'متجر ٣', 'متجر ٤'),
     ('Arabic-Indic against ASCII digit', 'Unit ٣', 'Unit 3'),
     ('lone combining mark', 'q' || chr(771) || 'x', 'qx'),
     ('ß against ss', 'Straße', 'Strasse'),
     ('joined against apart', 'Acme Co', 'AcmeCo')) v(rule, a, b)
    where app.normalize_name(a) = app.normalize_name(b)),
  null, 'every pair that is TWO names has two keys');

select results_eq(
  $$ select app.normalize_name(n) from unnest(array['株式会社トヨタ', 'شركة الأمل', 'ΟΔΟΣ Α.Ε.', 'ООО «Ромашка»', '★ — ★']) with ordinality u(n, i) order by i $$,
  $$ values ('株式会社トヨタ'), ('شركة الأمل'), ('οδοσ α ε'), ('ооо ромашка'), ('') $$,
  'every script keeps its letters; a name of symbols alone is the empty key');

select is(app.held_name_key('izmir ltd', '0b000000-0000-4000-8000-000000000001'),
          'izmir ltd [held 0b000000-0000-4000-8000-000000000001]', 'the held key names its record');
select ok(not has_function_privilege('authenticated', 'app.held_name_key(text, uuid)', 'execute'),
          'app.held_name_key is not callable by a signed-in user');

-- ---- Records ----------------------------------------------------------------------------------

insert into public.organizations (id, slug, name) values
  ('f2100000-0000-0000-0000-0000000000a1', 'pgt-un-a', 'PGT Unicode A'),
  ('f2100000-0000-0000-0000-0000000000b2', 'pgt-un-b', 'PGT Unicode B');

-- Under the old key every one of these was '' — only the first could ever exist.
select lives_ok($$
  insert into public.counterparties (organization_id, name) values
    ('f2100000-0000-0000-0000-0000000000a1', '株式会社トヨタ'),
    ('f2100000-0000-0000-0000-0000000000a1', 'شركة الأمل'),
    ('f2100000-0000-0000-0000-0000000000a1', 'ΟΔΟΣ Α.Ε.'),
    ('f2100000-0000-0000-0000-0000000000a1', 'ООО «Ромашка»'),
    ('f2100000-0000-0000-0000-0000000000a1', 'Müller GmbH') $$,
  'customers in Japanese, Arabic, Greek, Cyrillic and accented Latin are five customers in one organisation');

select results_eq(
  $$ select name, normalized_name from public.counterparties
      where organization_id = 'f2100000-0000-0000-0000-0000000000a1' order by normalized_name $$,
  $$ values ('Müller GmbH', 'müller gmbh'), ('ΟΔΟΣ Α.Ε.', 'οδοσ α ε'), ('ООО «Ромашка»', 'ооо ромашка'),
            ('شركة الأمل', 'شركة الأمل'), ('株式会社トヨタ', '株式会社トヨタ') $$,
  'display names are kept exactly as given; the key is derived beside them');

select throws_ok($$
  insert into public.counterparties (organization_id, name) values ('f2100000-0000-0000-0000-0000000000a1', 'MÜLLER GMBH') $$,
  '23505', null, 'the same name in capitals is the same customer (unique)');
select throws_ok($$
  insert into public.counterparties (organization_id, name) values ('f2100000-0000-0000-0000-0000000000a1', 'οδος α.ε.') $$,
  '23505', null, 'the same Greek name in lower case, with its final sigma, is the same customer');
select lives_ok($$
  insert into public.counterparties (organization_id, name) values ('f2100000-0000-0000-0000-0000000000a1', 'Möller GmbH') $$,
  'Möller GmbH is a different customer from Müller GmbH');
select lives_ok($$
  insert into public.counterparties (organization_id, name) values ('f2100000-0000-0000-0000-0000000000b2', 'Müller GmbH') $$,
  'another organisation may have its own Müller GmbH');

-- ---- Held records: the state the migration leaves a collision in ------------------------------

insert into public.counterparties (id, organization_id, name) values
  ('c2100000-0000-0000-0000-000000000001', 'f2100000-0000-0000-0000-0000000000a1', 'İzmir Trading'),
  ('c2100000-0000-0000-0000-000000000002', 'f2100000-0000-0000-0000-0000000000a1', 'Izmir Trading Co');
update public.counterparties set normalized_name = app.held_name_key('izmir trading', id)
 where id = 'c2100000-0000-0000-0000-000000000001';
update public.counterparties set normalized_name = app.held_name_key('izmir trading', 'c2100000-0000-0000-0000-000000000003')
 where id = 'c2100000-0000-0000-0000-000000000002';
-- (The second record's key is set as if it had been named "Izmir Trading" too; only the key matters here.)

select throws_like($$
  insert into public.counterparties (organization_id, name) values ('f2100000-0000-0000-0000-0000000000a1', 'IZMIR TRADING') $$,
  '%await a decision%', 'a new record of a held name is refused: creating it would decide which one it is');
select throws_like($$
  update public.counterparties set name = 'Izmir Trading' where id = 'c2100000-0000-0000-0000-000000000002' $$,
  '%await a decision%', 'nor may a held record take the name while another held record of it remains');
select lives_ok($$
  update public.counterparties set name = 'Izmir Trading Export' where id = 'c2100000-0000-0000-0000-000000000002' $$,
  'renaming one record of the group is allowed');
select is((select normalized_name from public.counterparties where id = 'c2100000-0000-0000-0000-000000000002'),
          'izmir trading export', 'and the renamed record takes its own key');
select lives_ok($$
  update public.counterparties set name = name where id = 'c2100000-0000-0000-0000-000000000001' $$,
  're-saving the last held record of the name resolves it');
select is((select normalized_name from public.counterparties where id = 'c2100000-0000-0000-0000-000000000001'),
          'izmir trading', 'which then holds the plain key');

-- A held record merged into another no longer blocks its name: the merge was the decision.
insert into public.counterparties (id, organization_id, name) values
  ('c2100000-0000-0000-0000-000000000011', 'f2100000-0000-0000-0000-0000000000a1', 'Ａｌｐｈａ'),
  ('c2100000-0000-0000-0000-000000000012', 'f2100000-0000-0000-0000-0000000000a1', 'Beta Holdings');
update public.counterparties set normalized_name = app.held_name_key('alpha', id), merged_into_id = 'c2100000-0000-0000-0000-000000000012'
 where id = 'c2100000-0000-0000-0000-000000000011';
select lives_ok($$
  insert into public.counterparties (organization_id, name) values ('f2100000-0000-0000-0000-0000000000a1', 'Alpha') $$,
  'a merged-away held record does not block its name');

-- Accounts follow the same rule (the trigger is shared).
insert into public.accounts (id, organization_id, name, account_type) values
  ('a2100000-0000-0000-0000-000000000001', 'f2100000-0000-0000-0000-0000000000a1', 'Ventes Café', 'income'),
  ('a2100000-0000-0000-0000-000000000002', 'f2100000-0000-0000-0000-0000000000a1', 'Ventes Cafe', 'income');
select is((select count(*)::int from public.accounts where organization_id = 'f2100000-0000-0000-0000-0000000000a1'
             and id in ('a2100000-0000-0000-0000-000000000001', 'a2100000-0000-0000-0000-000000000002')),
          2, 'accounts "Ventes Café" and "Ventes Cafe" are two accounts');
insert into public.accounts (id, organization_id, name, account_type) values
  ('a2100000-0000-0000-0000-000000000003', 'f2100000-0000-0000-0000-0000000000a1', 'Выручка', 'income');
update public.accounts set normalized_name = app.held_name_key('выручка', id)
 where id = 'a2100000-0000-0000-0000-000000000003';
select throws_like($$
  insert into public.accounts (organization_id, name, account_type) values ('f2100000-0000-0000-0000-0000000000a1', 'ВЫРУЧКА', 'income') $$,
  '%await a decision%', 'a held account name is refused for a new account too');
select lives_ok($$
  insert into public.accounts (organization_id, name, account_type) values ('f2100000-0000-0000-0000-0000000000a1', 'Выручка от продаж', 'income') $$,
  'a different Cyrillic account name is created');
select is((select normalized_name from public.accounts where name = 'Выручка от продаж'),
          'выручка от продаж', 'with a Cyrillic key');

select * from finish();
rollback;
