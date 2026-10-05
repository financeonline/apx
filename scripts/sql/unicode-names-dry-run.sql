-- MOTION — DRY RUN (read-only): what a Unicode-aware name key would change. Writes nothing.
-- Step 0C release blocker: `app.normalize_name` keeps only [a-z0-9], so names differing only in
-- letters outside A–Z share a key, and a name in another script has the key ''.
--
-- Run against any database with:  psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/sql/unicode-names-dry-run.sql
-- Every statement reads; the only object created is a TEMPORARY view, inside a transaction that is
-- always ROLLED BACK, so nothing persists. (READ ONLY would refuse even the temporary view.)

begin;

-- The proposed key: NFKC, lower-case, every run of non-letters/non-digits (any script) to one space.
create temp view v2 as
select 'counterparties' as tbl, c.organization_id, c.id, c.name, c.normalized_name as v1,
       btrim(regexp_replace(lower(normalize(c.name, NFKC)), '[^[:alnum:]]+', ' ', 'g')) as v2, c.merged_into_id
  from public.counterparties c
union all
select 'accounts', a.organization_id, a.id, a.name, a.normalized_name,
       btrim(regexp_replace(lower(normalize(a.name, NFKC)), '[^[:alnum:]]+', ' ', 'g')), null
  from public.accounts a;

\echo '1. Rows whose stored key is EMPTY (a name the current key cannot hold)'
select tbl, organization_id, id, name from v2 where v1 = '' order by 1, 2, 4;

\echo '2. Rows whose stored key DROPS letters (v1 <> the v2 key with non-ASCII removed) — at risk of collision'
select tbl, organization_id, id, name, v1, v2 from v2
 where v2 <> v1 and v1 <> '' order by 1, 2, 4;

\echo '3. Would the new key COLLIDE where the old one did not? (must be empty before migrating)'
select tbl, organization_id, v2, count(*) as rows, string_agg(name, ' | ' order by name) as names
  from v2 group by 1, 2, 3 having count(*) > 1 order by 1, 2, 3;

\echo '4. Invoice rows ALREADY booked to a counterparty whose name differs in letters (a past silent merge)'
select ir.organization_id, ir.batch_id, ir.row_number,
       coalesce(ir.mapped_data ->> 'customer', ir.mapped_data ->> 'supplier', ir.mapped_data ->> 'counterparty') as file_name,
       c.name as booked_to
  from public.import_rows ir
  join public.import_batches b on b.organization_id = ir.organization_id and b.id = ir.batch_id and b.target_table = 'invoices'
  join public.counterparties c on c.organization_id = ir.organization_id and c.id = (ir.mapped_data ->> 'counterparty_id')::uuid
 where ir.status = 'committed'
   and btrim(regexp_replace(lower(normalize(coalesce(ir.mapped_data ->> 'customer', ir.mapped_data ->> 'supplier', ir.mapped_data ->> 'counterparty', ''), NFKC)), '[^[:alnum:]]+', ' ', 'g'))
       <> btrim(regexp_replace(lower(normalize(c.name, NFKC)), '[^[:alnum:]]+', ' ', 'g'))
 order by 1, 2, 3;

\echo '5. Summary'
select tbl, count(*) filter (where v1 = '') as empty_key,
       count(*) filter (where v2 <> v1 and v1 <> '') as letters_dropped,
       count(*) as total
  from v2 group by 1 order by 1;

rollback;
