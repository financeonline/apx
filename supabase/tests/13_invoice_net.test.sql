-- MOTION — pgTAP · the one net-of-tax rule (ADR-103).
-- Contract: FINANCIAL_ENGINE.md §3 ("net of tax per row: `subtotal`, else `total_amount − tax_amount`,
-- else `total_amount`; a `subtotal` of 0 with `total_amount > 0` counts as absent"); ADR-047.5.
--
-- The rule lived in three places and agreed in two. These cases are the table the TypeScript mirror
-- (`financial-engine/domain/sign.ts#invoiceNetOfTax`, `test/unit/engine-sign.test.ts`) is tested
-- against, so a change on either side that is not made on both fails here.
begin;
create extension if not exists pgtap;
select plan(16);

-- ---- the rule itself ----------------------------------------------------------------------
select is(app.invoice_net(1000.00, 200.00, 1200.00), 1000.00::numeric,
          'a stated subtotal is the net, whatever the other columns say');
select is(app.invoice_net(1000.00, null, 1000.00), 1000.00::numeric,
          'a stated subtotal with no tax column is still the net');
select is(app.invoice_net(null, 200.00, 1200.00), 1000.00::numeric,
          'no subtotal, tax present: total less tax');
select is(app.invoice_net(null, null, 1200.00), 1200.00::numeric,
          'no subtotal and no tax: the total stands in for the net');
select is(app.invoice_net(0, 210.00, 1260.00), 1050.00::numeric,
          'a subtotal of 0 beside a positive total is ABSENT, not zero');
select is(app.invoice_net(0, null, 1260.00), 1260.00::numeric,
          'a subtotal of 0 with no tax falls through to the total');
select is(app.invoice_net(0, 0, 0), 0::numeric,
          'a genuinely zero invoice is zero, not a fallback');
select is(app.invoice_net(-500.00, -100.00, -600.00), -500.00::numeric,
          'a negatively stored row keeps its stated subtotal (the sign lives in the type, ADR-047.5)');

-- ---- the VAT-fallback flag: true exactly when the total stood in for a net ------------------
select is(app.invoice_net_is_vat_fallback(1000.00, 200.00, 1200.00), false,
          'a stated subtotal is not a fallback');
select is(app.invoice_net_is_vat_fallback(null, 200.00, 1200.00), false,
          'removing a stated tax is not a fallback');
select is(app.invoice_net_is_vat_fallback(null, null, 1200.00), true,
          'no subtotal and no tax IS the fallback');
select is(app.invoice_net_is_vat_fallback(0, null, 1260.00), true,
          'a blank-as-zero subtotal with no tax is the fallback');

-- ---- one rule, one definition ----------------------------------------------------------------
select has_function('app', 'invoice_net', array['numeric', 'numeric', 'numeric'],
                    'app.invoice_net is the single authoritative rule');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'api', 'api_server')
      and p.proname in ('aggregate_periods', 'set_invoice_lines', 'product_period_summary')
      and p.prosrc ~ 'total_amount\s*-\s*tax_amount'),
  0,
  'no invoice reader carries its own copy of the rule');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'aggregate_periods'
      and p.prosrc ~ 'app\.invoice_net\('),
  1,
  'the aggregate takes the net from the rule');

-- ---- the aggregate carries the VAT-fallback count the figure needs (§3) ---------------------
select is(
  (select count(*)::int from information_schema.routines r
     join information_schema.parameters c on c.specific_name = r.specific_name
    where r.routine_schema = 'app' and r.routine_name = 'aggregate_periods'
      and c.parameter_name = 'fallback_rows'),
  1,
  'app.aggregate_periods returns fallback_rows');

select * from finish();
rollback;
