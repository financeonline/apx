-- MOTION — READ-ONLY collision report for the Unicode name key (ADR-136, migration 20261006000001).
-- Run it BEFORE that migration, and keep its output with the release record:
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/sql/unicode-names-dry-run.sql
--
-- It writes nothing. The one object it creates is a TEMPORARY function (pg_temp.name_key), inside a
-- transaction that is always ROLLED BACK. Its body is the migration's `app.normalize_name`, character
-- for character; test/integration/unicode-names.test.ts fails if the two ever differ.
--
-- Run AFTER the migration, the same report lists the records still held for a decision (section 3)
-- and nothing else changes.

begin;

create function pg_temp.name_key(p_name text)
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select btrim(regexp_replace(
           replace(lower(normalize(p_name, nfkc) collate pg_catalog.pg_c_utf8), 'ς', 'σ'),
           '[[:space:][:punct:][:cntrl:]]+', ' ', 'g'));
$$;

create temporary view name_plan as
with base as (
  select 'accounts' as tbl, organization_id, id, name, normalized_name, null::uuid as merged_into_id from public.accounts
  union all
  select 'counterparties', organization_id, id, name, normalized_name, merged_into_id from public.counterparties
  union all
  select 'products', organization_id, id, name, normalized_name, null from public.products
  union all
  select 'marketing_channels', organization_id, id, name, normalized_name, null from public.marketing_channels
  union all
  select 'campaigns', organization_id, id, name, normalized_name, null from public.campaigns
)
select b.*, pg_temp.name_key(b.name) as new_key,
       b.normalized_name like '% [held %]' as already_held,
       count(*) over (partition by b.tbl, b.organization_id, pg_temp.name_key(b.name)) as group_size
  from base b;

\echo '1. Summary, per table: what the migration would do'
select tbl,
       count(*)                                                                   as records,
       count(*) filter (where normalized_name <> new_key and not already_held and group_size = 1) as rekeyed,
       count(*) filter (where normalized_name = '' and new_key <> '')             as gains_a_key,
       count(*) filter (where group_size > 1)                                     as to_be_held,
       count(distinct (organization_id, new_key)) filter (where group_size > 1)   as collision_groups,
       count(*) filter (where new_key = '')                                       as empty_key
  from name_plan group by tbl order by tbl;

\echo '2. Records whose key changes (no collision): old key -> new key. Names are never changed.'
select tbl, organization_id, id, name, normalized_name as old_key, new_key
  from name_plan
 where normalized_name <> new_key and not already_held and group_size = 1
 order by tbl, organization_id, name;

\echo '3. COLLISIONS: records the new key calls one name. Every record listed is HELD (kept, never merged)'
\echo '   until a person renames or merges them; imports of the name are refused meanwhile.'
select tbl, organization_id, new_key,
       count(*) as records,
       string_agg(name || ' (' || id::text || case when merged_into_id is not null then ', merged away' else '' end || ')',
                  ' | ' order by name) as records_held
  from name_plan where group_size > 1
 group by tbl, organization_id, new_key
 order by tbl, organization_id, new_key;

\echo '4. Records whose new key is EMPTY (the name is only punctuation or symbols)'
select tbl, organization_id, id, name from name_plan where new_key = '' order by 1, 2, 4;

\echo '5. PAST SILENT MERGES: committed invoice rows booked to a customer or supplier whose name is a'
\echo '   different name under the new key. Not changed by the migration: each needs a person to decide.'
select ir.organization_id, ir.batch_id, ir.row_number,
       coalesce(ir.mapped_data ->> 'customer', ir.mapped_data ->> 'supplier', ir.mapped_data ->> 'counterparty') as name_in_file,
       c.name as booked_to, c.id as counterparty_id
  from public.import_rows ir
  join public.import_batches b on b.organization_id = ir.organization_id and b.id = ir.batch_id and b.target_table = 'invoices'
  join public.counterparties c on c.organization_id = ir.organization_id and c.id = (ir.mapped_data ->> 'counterparty_id')::uuid
 where ir.status = 'committed'
   and pg_temp.name_key(coalesce(ir.mapped_data ->> 'customer', ir.mapped_data ->> 'supplier', ir.mapped_data ->> 'counterparty', ''))
       <> pg_temp.name_key(c.name)
 order by 1, 2, 3;

rollback;
