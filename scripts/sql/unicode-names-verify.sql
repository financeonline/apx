-- MOTION — TEST ONLY. Run AFTER migration 20261006000001 on a database seeded by
-- scripts/sql/unicode-names-seed.sql. Every check RAISES on failure, so psql -v ON_ERROR_STOP=1
-- fails the upgrade job. All writes are rolled back.

begin;

\echo 'After the migration: every seeded record, its name and its key'
select e.tbl, e.name, coalesce(c.normalized_name, a.normalized_name) as key_now, b.normalized_name as baseline_key, e.held
  from unicode_seed.expected e
  join unicode_seed.before b on b.id = e.id
  left join public.counterparties c on e.tbl = 'counterparties' and c.id = e.id
  left join public.accounts a on e.tbl = 'accounts' and a.id = e.id
 order by e.tbl, e.held, e.name;

do $$
declare
  v_bad text;
  v_n   integer;
begin
  -- 1. No record lost, created or merged by the migration; every display name exactly as it was.
  select string_agg(b.name, ', ') into v_bad
    from unicode_seed.before b
    left join (select 'counterparties' as tbl, id, name, merged_into_id from public.counterparties
               union all select 'accounts', id, name, null from public.accounts) x on x.tbl = b.tbl and x.id = b.id
   where x.id is null or x.name <> b.name or x.merged_into_id is distinct from b.merged_into_id;
  if v_bad is not null then raise exception 'records lost, renamed or re-merged: %', v_bad; end if;

  -- 2. Every record not in a collision has exactly its expected Unicode key.
  select string_agg(e.name || ' -> ' || coalesce(c.normalized_name, a.normalized_name), ', ') into v_bad
    from unicode_seed.expected e
    left join public.counterparties c on e.tbl = 'counterparties' and c.id = e.id
    left join public.accounts a on e.tbl = 'accounts' and a.id = e.id
   where not e.held and coalesce(c.normalized_name, a.normalized_name) is distinct from e.key;
  if v_bad is not null then raise exception 'wrong keys: %', v_bad; end if;

  -- 3. Every record of a known collision is HELD, with its own held key, and audited.
  select string_agg(e.name || ' -> ' || coalesce(c.normalized_name, a.normalized_name), ', ') into v_bad
    from unicode_seed.expected e
    left join public.counterparties c on e.tbl = 'counterparties' and c.id = e.id
    left join public.accounts a on e.tbl = 'accounts' and a.id = e.id
   where e.held and coalesce(c.normalized_name, a.normalized_name)
                    is distinct from app.held_name_key(app.normalize_name(e.name), e.id);
  if v_bad is not null then raise exception 'collisions not held: %', v_bad; end if;

  select count(*) into v_n from unicode_seed.expected e
   where e.held and exists (select 1 from public.audit_events l
                             where l.action = 'name_identity.held' and l.target_id = e.id);
  if v_n <> (select count(*) from unicode_seed.expected where held) then
    raise exception 'held records audited: % of %', v_n, (select count(*) from unicode_seed.expected where held);
  end if;

  -- 4. The past silent merge is still reported (the report query, under the new key) — and untouched.
  select count(*) into v_n
    from public.import_rows ir
    join public.counterparties c on c.organization_id = ir.organization_id and c.id = (ir.mapped_data ->> 'counterparty_id')::uuid
   where ir.batch_id = 'e9b00000-0000-4000-8000-000000000001' and ir.status = 'committed'
     and app.normalize_name(ir.mapped_data ->> 'customer') <> app.normalize_name(c.name);
  if v_n <> 1 then raise exception 'the past silent merge (Möller booked to Müller) is reported % times, not once', v_n; end if;

  -- 5. Behaviour afterwards.
  begin
    insert into public.counterparties (organization_id, name) values ('e9000000-0000-4000-8000-0000000000e1', 'IZMIR LTD');
    raise exception 'Izmir Ltd in capitals became a second customer';
  exception when unique_violation then null;
  end;
  begin
    insert into public.counterparties (organization_id, name) values ('e9000000-0000-4000-8000-0000000000e1', 'CAFÉ NORD');
    raise exception 'the survivor of a merge was duplicated by its own name in capitals';
  exception when unique_violation then null;
  end;
  -- U-2: the survivor of a pre-upgrade merge is not held, so imports naming it are not refused.
  if (select normalized_name from public.counterparties where id = 'e9c00000-0000-4000-8000-000000000008') <> 'café nord' then
    raise exception 'the survivor of a merge made before the upgrade is held';
  end if;
  begin
    insert into public.accounts (organization_id, name, account_type, standard_category) values ('e9000000-0000-4000-8000-0000000000e1', 'UMSÄTZE', 'income', 'revenue');
    raise exception 'a held account name was created again';
  exception when unique_violation then null;
  end;
  -- D-3: "İzmir Ltd" and "Izmir Ltd" are two customers; a third spelling of the dotted one is not new.
  begin
    insert into public.counterparties (organization_id, name) values ('e9000000-0000-4000-8000-0000000000e1', 'İZMIR LTD');
    raise exception 'the dotted-I name in capitals became a third customer';
  exception when unique_violation then null;
  end;
  begin
    insert into public.counterparties (organization_id, name) values ('e9000000-0000-4000-8000-0000000000e1', 'MÜLLER GMBH');
    raise exception 'the same name in capitals became a second customer';
  exception when unique_violation then null;
  end;
  -- Names the old key could not hold now can be added beside the existing ones.
  insert into public.counterparties (organization_id, name) values
    ('e9000000-0000-4000-8000-0000000000e1', 'Möller GmbH'),
    ('e9000000-0000-4000-8000-0000000000e1', '株式会社ホンダ'),
    ('e9000000-0000-4000-8000-0000000000e2', 'شركة النور'),
    ('e9000000-0000-4000-8000-0000000000e3', 'Ελληνική Εταιρεία'),
    ('e9000000-0000-4000-8000-0000000000e4', 'АО «Василёк»');
  -- Renaming one record of a held group, then re-saving the other, resolves it.
  update public.counterparties set name = 'Izmir Ltd (Ankara)' where id = 'e9c00000-0000-4000-8000-000000000005';
  update public.counterparties set name = name where id = 'e9c00000-0000-4000-8000-000000000004';
  if (select normalized_name from public.counterparties where id = 'e9c00000-0000-4000-8000-000000000004') <> 'izmir ltd' then
    raise exception 'resolving a held group did not give the remaining record its key';
  end if;

  raise notice 'unicode-names-verify: all checks passed';
end $$;

rollback;
