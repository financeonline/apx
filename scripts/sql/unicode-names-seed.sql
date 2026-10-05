-- MOTION — TEST DATA ONLY. Seeds names in five scripts, with known collisions, on a database still
-- at the BASELINE schema (before 20261006000001), so the migration is proven on rows the old key
-- wrote. Used by the upgrade job of .github/workflows/validate-step0.yml; never run it anywhere else.
--
-- Under the old key ([a-z0-9] only) a name in Arabic, Japanese, Greek or Cyrillic is '' — one per
-- organisation per table — which is why those names are spread over five organisations.
--
-- `unicode_seed.expected` records what the migration must leave behind:
--   key        the new key, or NULL for a record that must be HELD (verified by its format)
--   held_with  how many records share the held name

begin;

create schema unicode_seed;
create table unicode_seed.expected (
  tbl text not null, id uuid not null, name text not null, key text, held boolean not null default false
);

insert into public.organizations (id, slug, name) values
  ('e9000000-0000-4000-8000-0000000000e1', 'unicode-seed-latin', 'Unicode seed · Latin and Japanese'),
  ('e9000000-0000-4000-8000-0000000000e2', 'unicode-seed-arabic', 'Unicode seed · Arabic'),
  ('e9000000-0000-4000-8000-0000000000e3', 'unicode-seed-greek', 'Unicode seed · Greek'),
  ('e9000000-0000-4000-8000-0000000000e4', 'unicode-seed-cyrillic', 'Unicode seed · Cyrillic'),
  ('e9000000-0000-4000-8000-0000000000e5', 'unicode-seed-lookalike', 'Unicode seed · look-alikes');

with c(id, org, name, kind, key, held) as (values
  -- Japanese, and accented Latin that the old key told apart only by luck.
  ('e9c00000-0000-4000-8000-000000000001'::uuid, 'e9000000-0000-4000-8000-0000000000e1'::uuid, '株式会社トヨタ', 'customer', '株式会社トヨタ', false),
  ('e9c00000-0000-4000-8000-000000000002', 'e9000000-0000-4000-8000-0000000000e1', 'Müller GmbH',   'customer', 'müller gmbh', false),
  ('e9c00000-0000-4000-8000-000000000003', 'e9000000-0000-4000-8000-0000000000e1', 'Muller GmbH',   'customer', 'muller gmbh', false),
  -- KNOWN COLLISIONS: the old key kept these apart only because it dropped the letter that differs.
  ('e9c00000-0000-4000-8000-000000000004', 'e9000000-0000-4000-8000-0000000000e1', 'İzmir Ltd',     'supplier', null, true),
  ('e9c00000-0000-4000-8000-000000000005', 'e9000000-0000-4000-8000-0000000000e1', 'Izmir Ltd',     'supplier', null, true),
  ('e9c00000-0000-4000-8000-000000000006', 'e9000000-0000-4000-8000-0000000000e1', 'Ａｃｍｅ Trading', 'customer', null, true),
  ('e9c00000-0000-4000-8000-000000000007', 'e9000000-0000-4000-8000-0000000000e1', 'Acme Trading',  'customer', null, true),
  ('e9c00000-0000-4000-8000-000000000008', 'e9000000-0000-4000-8000-0000000000e1', 'Istanbul Co',   'customer', null, true),
  ('e9c00000-0000-4000-8000-000000000009', 'e9000000-0000-4000-8000-0000000000e1', 'İstanbul Co',   'customer', null, true),
  -- Arabic, Greek, Cyrillic: each was '' under the old key.
  ('e9c00000-0000-4000-8000-000000000011', 'e9000000-0000-4000-8000-0000000000e2', 'شركة الأمل',    'customer', 'شركة الأمل', false),
  ('e9c00000-0000-4000-8000-000000000021', 'e9000000-0000-4000-8000-0000000000e3', 'ΟΔΟΣ Α.Ε.',     'customer', 'οδοσ α ε', false),
  ('e9c00000-0000-4000-8000-000000000031', 'e9000000-0000-4000-8000-0000000000e4', 'ООО «Ромашка»', 'supplier', 'ооо ромашка', false),
  -- A Cyrillic name that LOOKS like a Latin one: two records, then and now.
  ('e9c00000-0000-4000-8000-000000000041', 'e9000000-0000-4000-8000-0000000000e5', 'Асме',          'customer', 'асме', false),
  ('e9c00000-0000-4000-8000-000000000042', 'e9000000-0000-4000-8000-0000000000e5', 'Acme',          'customer', 'acme', false)
), ins as (
  insert into public.counterparties (id, organization_id, name, kind)
  select id, org, name, kind::public.counterparty_kind_enum from c returning id
)
insert into unicode_seed.expected (tbl, id, name, key, held)
select 'counterparties', id, name, key, held from c;

-- "İstanbul Co" was merged into "Istanbul Co" before the upgrade: both are still held (the merged one
-- keeps its key slot), but only the surviving record blocks the name afterwards.
update public.counterparties set merged_into_id = 'e9c00000-0000-4000-8000-000000000008'
 where id = 'e9c00000-0000-4000-8000-000000000009';

with a(id, org, name, type, key, held) as (values
  ('e9a00000-0000-4000-8000-000000000001'::uuid, 'e9000000-0000-4000-8000-0000000000e1'::uuid, 'Ventes Café', 'income', 'ventes café', false),
  ('e9a00000-0000-4000-8000-000000000002', 'e9000000-0000-4000-8000-0000000000e1', 'Ventes Cafe', 'income', 'ventes cafe', false),
  -- KNOWN COLLISION: the same word, precomposed and with a combining diaeresis.
  ('e9a00000-0000-4000-8000-000000000003', 'e9000000-0000-4000-8000-0000000000e1', 'Umsätze', 'income', null, true),
  ('e9a00000-0000-4000-8000-000000000004', 'e9000000-0000-4000-8000-0000000000e1', 'Umsa' || chr(776) || 'tze', 'income', null, true),
  ('e9a00000-0000-4000-8000-000000000011', 'e9000000-0000-4000-8000-0000000000e2', 'المبيعات', 'income', 'المبيعات', false),
  ('e9a00000-0000-4000-8000-000000000021', 'e9000000-0000-4000-8000-0000000000e3', 'Πωλήσεις', 'income', 'πωλήσεισ', false),
  ('e9a00000-0000-4000-8000-000000000031', 'e9000000-0000-4000-8000-0000000000e4', 'Выручка', 'income', 'выручка', false),
  ('e9a00000-0000-4000-8000-000000000041', 'e9000000-0000-4000-8000-0000000000e1', '売上高', 'income', '売上高', false)
), ins as (
  insert into public.accounts (id, organization_id, name, account_type, standard_category, source)
  select id, org, name, type::public.account_type_enum, 'revenue', 'imported' from a returning id
)
insert into unicode_seed.expected (tbl, id, name, key, held)
select 'accounts', id, name, key, held from a;

-- A PAST SILENT MERGE: an invoice row naming "Möller GmbH" that the old key booked to "Müller GmbH".
insert into public.source_documents (id, organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
values ('e9d00000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-0000000000e1', 'seed/u.csv', 'u.csv', 'text/csv', 1, decode('e901', 'hex'), 'ready', 'invoice');
insert into public.import_batches (id, organization_id, source_document_id, import_type, target_table, status, period_start, period_end)
values ('e9b00000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-0000000000e1', 'e9d00000-0000-4000-8000-000000000001',
        'sales_invoices', 'invoices', 'validating', '2026-08-01', '2026-08-31');
insert into public.import_rows (organization_id, batch_id, row_number, raw_data, mapped_data, status)
values ('e9000000-0000-4000-8000-0000000000e1', 'e9b00000-0000-4000-8000-000000000001', 2,
        '{"Customer": "Möller GmbH"}',
        '{"customer": "Möller GmbH", "counterparty_id": "e9c00000-0000-4000-8000-000000000002"}', 'committed');

-- What the baseline key made of them: every non-Latin name '', and the collisions apart.
create table unicode_seed.before as
select 'counterparties' as tbl, id, name, normalized_name, merged_into_id from public.counterparties
 where organization_id::text like 'e9000000-%'
union all
select 'accounts', id, name, normalized_name, null from public.accounts
 where id::text like 'e9a00000-%';

commit;

select tbl, name, normalized_name as baseline_key from unicode_seed.before order by tbl, name;
