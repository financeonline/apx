-- MOTION — Step 0D · Unicode identity for names (ADR-136).
--
-- `app.normalize_name` kept only [a-z0-9]: "Müller GmbH" and "Möller GmbH" were one key, and a name
-- in Arabic, Japanese, Greek or Cyrillic was the key '' — so only the first such name an
-- organisation ever had could exist. It is the uniqueness key of accounts, counterparties, products,
-- marketing channels and campaigns, and the key every import matches on.
--
-- The matching rule (ADR-136), in order:
--   1. NFKC: compatibility forms are one name ("Ａｃｍｅ" = "Acme", "ﬁ" = "fi", half-width katakana =
--      full-width), and a precomposed accent equals the same accent written as a combining mark.
--   2. Lower case by Unicode's simple mapping (pg_c_utf8: the same in every environment, no ICU, no
--      OS locale), and final sigma 'ς' read as 'σ', so case never separates a name in any script.
--   3. Every run of whitespace, punctuation, symbols and control characters becomes one space, and
--      the ends are trimmed.
--   Everything else is significant: every letter in every script, every accent and combining mark,
--   every digit (٣ and 3 are different characters). So "Müller" ≠ "Muller" ≠ "Möller", and Cyrillic
--   "Асме" ≠ Latin "Acme".
-- For a name of ASCII characters the key is byte-for-byte the old one (pgTAP 21 checks all 128).
--
-- Existing rows are re-keyed below. Where the NEW key would make two existing records one name — a
-- collision the old key hid, e.g. "İzmir" (old key "zmir") and "Izmir" — nothing is merged and
-- nothing is guessed: EVERY record of the group is HELD, keeping its name and its history, with
-- the key '<key> [held <id>]', which no import key can equal (a key never contains '['). While a
-- held record of a name exists, an import refuses that name (IMP-CP-019 / IMP-ACCT-019) and a new
-- record of it is refused here; a person resolves the group by renaming or merging records, and
-- re-saving a record's name re-derives its key once no other held record shares it.
--
-- Read-only collision report to run BEFORE this migration: scripts/sql/unicode-names-dry-run.sql.

create or replace function app.normalize_name(p_name text)
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select btrim(regexp_replace(
           replace(lower(normalize(p_name, nfkc) collate pg_catalog.pg_c_utf8), 'ς', 'σ'),
           '[[:space:][:punct:][:cntrl:]]+', ' ', 'g'));
$$;

comment on function app.normalize_name(text) is
  'The identity key of a name (ADR-136): NFKC, simple lower case (pg_c_utf8) with final sigma folded, '
  'whitespace/punctuation/symbol/control runs to one space, trimmed. Every letter, mark and digit in '
  'every script is significant. Mirrored exactly by storedNameKey() in TypeScript.';

-- A held record's key: never equal to any import key, unique per record.
create function app.held_name_key(p_key text, p_id uuid)
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select p_key || ' [held ' || p_id::text || ']';
$$;

create or replace function app.derive_normalized_name() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_key  text := app.normalize_name(new.name);
  v_held text;
begin
  /*
   * A name whose records await an identity decision (held by 20261006000001) is not available to
   * a NEW or renamed record until no OTHER held, unmerged record of it is left: taking the key
   * would make this record "the" one and decide the question nobody has answered.
   */
  execute format(
    'select t.name from %I.%I t
      where t.organization_id = $1 and t.id <> $2 and t.normalized_name like $3 %s
      limit 1',
    tg_table_schema, tg_table_name,
    case when tg_table_name = 'counterparties' then 'and t.merged_into_id is null' else '' end)
    into v_held
    using new.organization_id, new.id, v_key || ' [held %';
  if v_held is not null then
    raise exception 'CONFLICT: "%" shares its name with "%", and they await a decision about whether they are the same; rename or merge them first', new.name, v_held
      using errcode = '23505';
  end if;

  -- Always derived, never taken from the caller (ADR-052.8).
  new.normalized_name := v_key;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Re-key every existing row. Two phases, so no row ever takes a key another row is about to
-- leave (the unique constraints are not deferrable): changing rows are parked on a per-row
-- placeholder first, then given their final key.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t      text;
  r      record;
  v_held integer;
begin
  foreach t in array array['accounts', 'counterparties', 'products', 'marketing_channels', 'campaigns'] loop
    -- Audit U-2: a counterparty MERGED into another before the upgrade is already decided — the
    -- merge was the decision. It still collides with its survivor (they share the new key) and so is
    -- parked on a held key of its own, but it does not make the SURVIVOR undecided: a group whose
    -- only active member is that survivor gives the survivor its plain key. Holding the survivor
    -- refused every later import naming the customer the user had already de-duplicated.
    execute format(
      'create temporary table name_rekey on commit drop as
       select x.id, x.organization_id, x.name, x.normalized_name as old_key,
              app.normalize_name(x.name) as new_key,
              count(*) over (partition by x.organization_id, app.normalize_name(x.name)) as group_size,
              %s as is_active,
              count(*) filter (where %s) over (partition by x.organization_id, app.normalize_name(x.name)) as active_size
         from public.%I x',
      case when t = 'counterparties' then 'x.merged_into_id is null' else 'true' end,
      case when t = 'counterparties' then 'x.merged_into_id is null' else 'true' end,
      t);
    -- A record is held when it shares the new key with another, unless it is the one active record
    -- of its group (the survivor of a merge made before the upgrade).
    alter table name_rekey add column held boolean;
    update name_rekey set held = group_size > 1 and not (is_active and active_size = 1);

    execute format(
      'update public.%I x set normalized_name = ''[rekey '' || x.id::text || '']''
         from name_rekey k
        where k.id = x.id and (k.old_key <> k.new_key or k.group_size > 1)', t);

    execute format(
      'update public.%I x
          set normalized_name = case when k.held then app.held_name_key(k.new_key, x.id) else k.new_key end
         from name_rekey k
        where k.id = x.id and x.normalized_name = ''[rekey '' || x.id::text || '']''', t);

    -- Every held record is on the audit trail with the names it collided with.
    v_held := 0;
    for r in
      select k.organization_id, k.id, k.name, k.old_key, k.new_key,
             (select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) order by o.name)
                from name_rekey o
               where o.organization_id = k.organization_id and o.new_key = k.new_key and o.id <> k.id) as shares_with
        from name_rekey k where k.held
    loop
      perform app.audit(r.organization_id, 'name_identity.held', t, r.id,
                        jsonb_build_object('normalized_name', r.old_key),
                        jsonb_build_object('normalized_name', app.held_name_key(r.new_key, r.id)),
                        jsonb_build_object('name', r.name, 'key', r.new_key, 'shares_with', r.shares_with,
                                           'migration', '20261006000001'));
      v_held := v_held + 1;
    end loop;
    if v_held > 0 then
      raise notice 'unicode name keys: % record(s) of % held for an identity decision', v_held, t;
    end if;

    drop table name_rekey;
  end loop;
end $$;

alter function app.held_name_key(text, uuid) owner to motion_definer;
revoke all on function app.held_name_key(text, uuid) from public, authenticated, anon;
