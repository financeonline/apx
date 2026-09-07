-- MOTION — Calculation engine · The instant a chunk aggregates as of comes from the database.
-- Contract: FINANCIAL_ENGINE.md §2.4 step 4 ("aggregated_at = transaction_timestamp()");
-- EVIDENCE_MODEL.md §3 and §11; ADR-046.2, ADR-047.7, ADR-063.
--
-- `app.aggregate_periods` selects rows with `created_at <= p_aggregated_at`, and `created_at` is
-- stamped by Postgres. The run loop pinned that cutoff with the WORKER's `new Date()`, which makes
-- the comparison one between two clocks: whenever the database's is the further ahead — it is, by
-- tens of milliseconds, on any host running Postgres in a container — rows committed BEFORE the run
-- was queued fall the wrong side of the cutoff and the run computes without them. Nothing raises.
-- The figures are simply short, and a metric whose shape depends on whether an account carried rows
-- (§3.1's `no_cost_of_sales_accounts`) changes shape from one run to the next.
--
-- §2.4 step 4 always said `transaction_timestamp()` — a DATABASE function. This is the surface that
-- makes the written contract implementable from a worker that reaches Postgres over PostgREST.

create function api_server.aggregation_instant()
returns timestamptz
language plpgsql security definer set search_path = '' as $$
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  -- `transaction_timestamp()`, not `clock_timestamp()`: §2.4 step 4 names it, and a chunk's pin
  -- should be the instant its transaction began rather than a moving reading.
  return transaction_timestamp();
end $$;

alter function api_server.aggregation_instant() owner to motion_definer;
revoke all on function api_server.aggregation_instant() from public, authenticated, anon;
grant execute on function api_server.aggregation_instant() to service_role;
