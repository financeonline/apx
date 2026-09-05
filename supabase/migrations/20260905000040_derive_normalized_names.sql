-- MOTION — Phase 5 (plan Phase 7) · `normalized_name` is derived, not supplied.
-- Contract: DATABASE_ARCHITECTURE.md §3 (`accounts`, `counterparties`); IMPORT_ENGINE.md §6.5, §6.6.
--
-- `normalized_name` is a pure function of `name`, and it is the column uniqueness depends on: it is
-- what makes "Bank  Charges", "bank charges" and "Bank Charges." one account rather than three, and
-- one customer rather than three. Requiring every writer to compute it is how two writers come to
-- compute it differently — and a divergence there does not fail loudly, it silently splits an
-- account's history in half.
--
-- The seeding routine and `api.confirm_account_mapping` already derive it correctly. A trigger makes
-- that the only possibility rather than a convention every future writer has to remember. Found
-- when a test inserted an account without it and hit the NOT NULL constraint — a constraint that
-- was protecting the right invariant in the wrong place.

create function app.derive_normalized_name() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Always derived, never taken from the caller: a supplied value that disagreed with the name
  -- would defeat the uniqueness the column exists to enforce.
  new.normalized_name := app.normalize_name(new.name);
  return new;
end $$;

create trigger derive_normalized_name
  before insert or update of name on public.accounts
  for each row execute function app.derive_normalized_name();

create trigger derive_normalized_name
  before insert or update of name on public.counterparties
  for each row execute function app.derive_normalized_name();

alter function app.derive_normalized_name() owner to motion_definer;
revoke all on function app.derive_normalized_name() from public;

comment on column public.accounts.normalized_name is
  'Derived from `name` by app.normalize_name(); never supplied by a caller. It is the uniqueness '
  'key, so two writers computing it differently would split one account into two.';
