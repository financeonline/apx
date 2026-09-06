-- MOTION — Evidence UI · A category's history starts when the row does.
-- Contract: EVIDENCE_MODEL.md §3 ("for bank rows the category … come from `category_history`; for
-- accounts from `account_category_history`"), §8.7; TEST_STRATEGY.md §9 (F-C-07); ADR-034.
--
-- Both history tables were written ONLY by the re-categorisation functions, which close the open
-- interval and open a new one. Nothing ever opened the FIRST interval, so both tables were empty
-- until somebody re-categorised something — and after that first re-categorisation the only
-- interval on record began at the moment of the change.
--
-- The consequence is precisely the guarantee §8.7 makes and F-C-07 tests. Resolving a descriptor
-- as-of a run that happened BEFORE the change finds no interval covering that instant:
--
--   * for an account, `valueInForceAt` returns null and the evidence shows no category at all;
--   * for a bank row, the resolver falls back to the row's CURRENT category — so an old bundle
--     silently reports the new categorisation as though it had always been so, which is worse than
--     showing nothing, because it is confidently wrong.
--
-- Either way the answer to "what was this when you told me the figure" was unrecoverable, which is
-- the one thing the history tables exist to answer.

-- ---------------------------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------------------------
create function app.open_account_category_history() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.account_category_history
         (organization_id, account_id, standard_category, valid_from, changed_by)
  values (new.organization_id, new.id, new.standard_category, new.created_at, app.uid());
  return new;
end $$;

alter function app.open_account_category_history() owner to motion_definer;
revoke all on function app.open_account_category_history() from public, authenticated, anon;

create trigger open_category_history after insert on public.accounts
  for each row execute function app.open_account_category_history();

-- ---------------------------------------------------------------------------------------------
-- Bank transactions
-- ---------------------------------------------------------------------------------------------
create function app.open_bank_category_history() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.category_history
         (organization_id, bank_transaction_id, category_account_id, is_transfer,
          transfer_kind, source, valid_from, changed_by)
  values (new.organization_id, new.id, new.category_account_id, new.is_transfer,
          new.transfer_kind, new.category_source, new.created_at, app.uid());
  return new;
end $$;

alter function app.open_bank_category_history() owner to motion_definer;
revoke all on function app.open_bank_category_history() from public, authenticated, anon;

create trigger open_category_history after insert on public.bank_transactions
  for each row execute function app.open_bank_category_history();

-- ---------------------------------------------------------------------------------------------
-- The rows that already exist
-- ---------------------------------------------------------------------------------------------
-- Backfilled from `created_at` with the current value, which is the honest reconstruction: for
-- anything never re-categorised it is exactly right, and for anything that HAS been the later
-- interval already exists and wins from its own `valid_from`. Only rows with no open interval are
-- touched, so this cannot duplicate one.
insert into public.account_category_history
       (organization_id, account_id, standard_category, valid_from)
select a.organization_id, a.id, a.standard_category, a.created_at
  from public.accounts a
 where not exists (
   select 1 from public.account_category_history h
    where h.organization_id = a.organization_id and h.account_id = a.id);

insert into public.category_history
       (organization_id, bank_transaction_id, category_account_id, is_transfer,
        transfer_kind, source, valid_from)
select t.organization_id, t.id, t.category_account_id, t.is_transfer,
       t.transfer_kind, t.category_source, t.created_at
  from public.bank_transactions t
 where not exists (
   select 1 from public.category_history h
    where h.organization_id = t.organization_id and h.bank_transaction_id = t.id);
