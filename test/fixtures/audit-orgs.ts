/**
 * The eleven adversarial organisations of the ADR-120 independent audit (docs/ADR-120_INDEPENDENT_AUDIT.md),
 * kept as permanent fixtures for ADR-123 — each reproduces one audit finding. Raw accepted records under
 * committed batches (the shape a real commit leaves); every figure comes only from the real
 * `calculation.run` job through the queue. Commit times are FIXED (`COMMITTED_AT`), never `now()`.
 */
import { adminSql, clientFor, createAuthUser } from '../integration/setup';
import { COMMITTED_AT } from './adr120-orgs';

const q = (s: string): string => s.replace(/'/g, "''");

export function acct(org: string, category: string): string {
  return adminSql(`select id from public.accounts where organization_id = '${org}' and standard_category = '${category}'
    order by is_system desc, id limit 1`).split('\n')[0]!.trim();
}

export interface Move { readonly date: string; readonly amount: string }

/** One committed statement batch and its transactions. Returns the batch id. */
export function statement(org: string, bank: string, o: {
  start: string; end: string; committedAt?: string; opening?: string | null; closing?: string | null; moves: readonly Move[]; tag: string;
}): string {
  const values = o.moves.length === 0 ? '' : o.moves.map((m) => `('${m.date}'::date, ${m.amount}::numeric)`).join(',');
  return adminSql(`do $$ declare v_doc uuid; v_b uuid; v_row uuid; v_id uuid; r record; n int := 0; begin
    insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
      values ('${org}', '${org}/audit/${q(o.tag)}-' || gen_random_uuid(), '${q(o.tag)}.csv', 'text/csv', 10, digest(gen_random_uuid()::text, 'sha256'), 'ready', 'bank_statement') returning id into v_doc;
    insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method,
        period_start, period_end, committed_at, bank_account_id, statement_opening_balance, statement_closing_balance)
      values ('${org}', v_doc, 'bank_statement', 'bank_transactions', 'committed', 'csv', '${o.start}', '${o.end}',
        '${o.committedAt ?? COMMITTED_AT}'::timestamptz, '${bank}', ${o.opening ?? 'null'}, ${o.closing ?? 'null'}) returning id into v_b;
    ${values === '' ? '' : `for r in select * from (values ${values}) v(d, a) loop
      n := n + 1;
      insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
        values ('${org}', v_b, n, 'r' || n, '{}'::jsonb, '{}'::jsonb, 'committed') returning id into v_row;
      insert into public.bank_transactions (organization_id, bank_account_id, transaction_date, amount, currency, description_raw,
          description_normalized, period_id, category_source, record_status, assurance_level, duplicate_reviewed, source_document_id,
          import_batch_id, import_row_id, source_ref, is_transfer, transfer_kind)
        values ('${org}', '${bank}', r.d, r.a, 'GBP', 'mv ' || n || ' ' || v_b, 'mv ' || n || ' ' || v_b,
          '00000000-0000-0000-0000-000000000000', 'none', 'accepted', 'verified', true, v_doc, v_b, v_row, 'b' || n, false, 'none') returning id into v_id;
      insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id)
        values ('${org}', 'bank_transactions', v_id, 'accepted', v_b);
    end loop;`}
    perform set_config('audit.last', v_b::text, false);
  end $$; select current_setting('audit.last');`).trim();
}

export function bankAccount(org: string, opening: string | null, openingDate: string | null, name = 'Main'): string {
  return adminSql(`insert into public.bank_accounts (organization_id, name, bank_name, account_type, opening_balance, opening_balance_date, is_active)
    values ('${org}', '${name}', 'Test Bank', 'current', ${opening ?? 'null'}, ${openingDate ? `'${openingDate}'` : 'null'}, true) returning id`).split('\n')[0]!.trim();
}

export function counterparty(org: string, name: string, kind: 'customer' | 'supplier', category: string | null = null): string {
  return adminSql(`insert into public.counterparties (organization_id, name, kind, default_expense_category)
    values ('${org}', '${q(name)}', '${kind}', ${category ? `'${category}'` : 'null'}) returning id`).split('\n')[0]!.trim();
}

export interface Inv {
  readonly type: 'sales' | 'sales_credit_note' | 'purchase' | 'purchase_credit_note';
  readonly party: string; readonly number: string; readonly issue: string; readonly due: string | null;
  readonly subtotal: string; readonly tax: string; readonly total: string; readonly paid: string;
  readonly paidDate: string | null; readonly status: 'open' | 'partially_paid' | 'paid' | 'void';
}

export function invoiceBatch(org: string, o: {
  importType: 'sales_invoices' | 'purchase_invoices'; start: string; end: string; listKind: 'full' | 'open_items';
  committedAt?: string; invoices: readonly Inv[]; tag: string;
}): string {
  const values = o.invoices.map((r) => `('${r.type}', '${r.party}'::uuid, '${q(r.number)}', '${r.issue}'::date, ${r.due ? `'${r.due}'::date` : 'null::date'},
    ${r.subtotal}::numeric, ${r.tax}::numeric, ${r.total}::numeric, ${r.paid}::numeric, ${r.paidDate ? `'${r.paidDate}'::date` : 'null::date'}, '${r.status}')`).join(',');
  return adminSql(`do $$ declare v_doc uuid; v_b uuid; v_row uuid; v_id uuid; r record; n int := 0; begin
    insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
      values ('${org}', '${org}/audit/${q(o.tag)}-' || gen_random_uuid(), '${q(o.tag)}.csv', 'text/csv', 10, digest(gen_random_uuid()::text, 'sha256'), 'ready', 'invoice') returning id into v_doc;
    insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method,
        period_start, period_end, committed_at, invoice_list_kind)
      values ('${org}', v_doc, '${o.importType}', 'invoices', 'committed', 'csv', '${o.start}', '${o.end}',
        '${o.committedAt ?? COMMITTED_AT}'::timestamptz, '${o.listKind}') returning id into v_b;
    for r in select * from (values ${values}) v(t, p, num, iss, due, sub, tax, tot, paid, pd, st) loop
      n := n + 1;
      insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
        values ('${org}', v_b, n, 'r' || n, '{}'::jsonb, '{}'::jsonb, 'committed') returning id into v_row;
      insert into public.invoices (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
          subtotal, tax_amount, total_amount, amount_paid, paid_date, status, record_status, assurance_level,
          source_document_id, import_batch_id, import_row_id, source_ref)
        values ('${org}', r.t::public.invoice_type_enum, r.p, r.num, r.iss, r.due, '00000000-0000-0000-0000-000000000000',
          r.sub, r.tax, r.tot, r.paid, r.pd, r.st::public.invoice_status_enum, 'accepted', 'verified', v_doc, v_b, v_row, 'i' || n || v_b) returning id into v_id;
      insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id)
        values ('${org}', 'invoices', v_id, 'accepted', v_b);
    end loop;
    perform set_config('audit.last', v_b::text, false);
  end $$; select current_setting('audit.last');`).trim();
}

export interface GlLine { readonly date: string; readonly category: string; readonly direction: 'debit' | 'credit'; readonly amount: string; readonly opening?: boolean }

export function glBatch(org: string, o: { start: string; end: string; lines: readonly GlLine[]; tag: string }): string {
  const values = o.lines.map((l) => `('${l.date}'::date, '${acct(org, l.category)}'::uuid, '${l.direction}', ${l.amount}::numeric, ${l.opening === true})`).join(',');
  return adminSql(`do $$ declare v_doc uuid; v_b uuid; v_row uuid; v_id uuid; r record; n int := 0; begin
    insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
      values ('${org}', '${org}/audit/${q(o.tag)}-' || gen_random_uuid(), '${q(o.tag)}.csv', 'text/csv', 10, digest(gen_random_uuid()::text, 'sha256'), 'ready', 'general_ledger') returning id into v_doc;
    insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method,
        period_start, period_end, committed_at)
      values ('${org}', v_doc, 'general_ledger', 'ledger_entries', 'committed', 'csv', '${o.start}', '${o.end}', '${COMMITTED_AT}') returning id into v_b;
    for r in select * from (values ${values}) v(d, a, dir, amt, op) loop
      n := n + 1;
      insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
        values ('${org}', v_b, n, 'r' || n, '{}'::jsonb, '{}'::jsonb, 'committed') returning id into v_row;
      insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status,
          source_document_id, import_batch_id, import_row_id, source_ref, is_opening_balance)
        values ('${org}', r.d, r.a, r.dir::public.entry_direction_enum, r.amt, '00000000-0000-0000-0000-000000000000', 'accepted', v_doc, v_b, v_row, 'g' || n || v_b, r.op) returning id into v_id;
      insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id)
        values ('${org}', 'ledger_entries', v_id, 'accepted', v_b);
    end loop;
    perform set_config('audit.last', v_b::text, false);
  end $$; select current_setting('audit.last');`).trim();
}

export function balanceBatch(org: string, o: {
  importType: 'trial_balance' | 'balance_sheet'; basis: 'cumulative' | 'movement'; start: string; end: string;
  rows: ReadonlyArray<readonly [string, string]>; tag: string;
  /** N-1: record the reviewer's IMP-TB-016 attestation that the report lists every account. */
  complete?: boolean;
}): string {
  const confirmations = o.complete === true
    ? `jsonb_build_object('IMP-TB-016', jsonb_build_object('by', null, 'at', now(), 'value', jsonb_build_object('report_complete', 'complete')))`
    : `'{}'::jsonb`;
  const values = o.rows.map(([category, value]) => `('${acct(org, category)}'::uuid, ${value}::numeric)`).join(',');
  return adminSql(`do $$ declare v_doc uuid; v_b uuid; v_row uuid; v_id uuid; r record; n int := 0; begin
    insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
      values ('${org}', '${org}/audit/${q(o.tag)}-' || gen_random_uuid(), '${q(o.tag)}.csv', 'text/csv', 10, digest(gen_random_uuid()::text, 'sha256'), 'ready', '${o.importType}') returning id into v_doc;
    insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method,
        period_start, period_end, committed_at, balance_basis, confirmations)
      values ('${org}', v_doc, '${o.importType}', 'period_balances', 'committed', 'csv', '${o.start}', '${o.end}', '${COMMITTED_AT}', '${o.basis}', ${confirmations}) returning id into v_b;
    for r in select * from (values ${values}) v(a, val) loop
      n := n + 1;
      insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
        values ('${org}', v_b, n, 'r' || n, '{}'::jsonb, '{}'::jsonb, 'committed') returning id into v_row;
      insert into public.period_balances (organization_id, period_start, period_id, account_id, closing_balance,
          balance_kind, balance_basis, source_document_id, import_batch_id, import_row_id, source_ref, record_status)
        values ('${org}', '${o.start}', '00000000-0000-0000-0000-000000000000', r.a, r.val,
          '${o.importType}'::public.balance_kind_enum, '${o.basis}'::public.balance_basis_enum, v_doc, v_b, v_row, 'p' || n || v_b, 'accepted') returning id into v_id;
      insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id)
        values ('${org}', 'period_balances', v_id, 'accepted', v_b);
    end loop;
    perform set_config('audit.last', v_b::text, false);
  end $$; select current_setting('audit.last');`).trim();
}

/** Months helper: YYYY-MM → { start, end }. */
export function month(ym: string): { start: string; end: string } {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${String(last).padStart(2, '0')}` };
}
export function monthsFrom(ym: string, count: number): string[] {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const t = y * 12 + (m - 1) + i;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  });
}

export type AuditKey =
  | 'GAP' | 'MIDSTART' | 'LEDGER2' | 'TBBS' | 'MOVTB' | 'CURRENT' | 'CREDITHEAVY' | 'PARTIALPD' | 'LONG' | 'BIGINV' | 'BSREV';

/** Seeds the adversarial organisations. */
export async function seedAuditOrgs(tag: string, keys: readonly AuditKey[]): Promise<Partial<Record<AuditKey, string>>> {
  const out: Partial<Record<AuditKey, string>> = {};
  let n = 0;
  let owner = '';
  for (const key of keys) {
    if (n % 2 === 0) owner = createAuthUser(`aud-${n}@${tag}.adr123.itest`);
    n += 1;
    const r = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `ADR123 ${key} ${tag}` });
    if (r.error) throw new Error(r.error.message);
    const org = r.data as unknown as string;
    out[key] = org;
    seedOne(key, org);
  }
  return out;
}

function seedOne(key: AuditKey, org: string): void {
  switch (key) {
    case 'GAP': {
      // Statements for June and August; JULY'S STATEMENT IS MISSING. August's statement prints its own
      // opening of 4,000.00 (so the truth is on file). Nothing typed on the account.
      // June: printed opening 10,000, −1,000 → 9,000. Truth: July −5,000 (unknown to MOTION) → Aug open 4,000; Aug −500 → 3,500.
      const bank = bankAccount(org, null, null);
      statement(org, bank, { ...month('2026-06'), opening: '10000', moves: [{ date: '2026-06-10', amount: '-1000' }], tag: 'gap-jun' });
      statement(org, bank, { ...month('2026-08'), opening: '4000', closing: '3500', moves: [{ date: '2026-08-10', amount: '-500' }], tag: 'gap-aug' });
      break;
    }
    case 'MIDSTART': {
      // S1 1–20 June (printed opening 10,000; −4,000 on 06-10); S2 21 June–31 July (−1,000 on 06-25, +500 on 07-10);
      // S3 August (+100). Truth: 1 July = 5,000 → July close 5,500 → August 5,600.
      const bank = bankAccount(org, null, null);
      statement(org, bank, { start: '2026-06-01', end: '2026-06-20', opening: '10000', moves: [{ date: '2026-06-10', amount: '-4000' }], tag: 'ms-s1' });
      statement(org, bank, { start: '2026-06-21', end: '2026-07-31', opening: '6000', moves: [{ date: '2026-06-25', amount: '-1000' }, { date: '2026-07-10', amount: '500' }], tag: 'ms-s2' });
      statement(org, bank, { ...month('2026-08'), opening: '5500', moves: [{ date: '2026-08-10', amount: '100' }], tag: 'ms-s3' });
      break;
    }
    case 'LEDGER2': {
      // Two annual GL exports, EACH with its own opening journal (IMP-GL-011 at fiscal-year start / export start).
      // Export A (June): opening Dr receivables 5,000 / Cr equity 5,000; June sale Dr recv 1,000 / Cr revenue 1,000.
      // Export B (July–Aug): opening (restated at 1 July) Dr receivables 6,000 / Cr equity 6,000;
      //   July sale Dr recv 1,000 / Cr revenue; August receipt Dr cash 2,000 / Cr recv 2,000.
      // Truth: June 6,000 · July 7,000 · August 5,000.
      glBatch(org, { ...month('2026-06'), tag: 'l2-a', lines: [
        { date: '2026-06-01', category: 'receivables', direction: 'debit', amount: '5000', opening: true },
        { date: '2026-06-01', category: 'equity', direction: 'credit', amount: '5000', opening: true },
        { date: '2026-06-05', category: 'receivables', direction: 'debit', amount: '1000' },
        { date: '2026-06-05', category: 'revenue', direction: 'credit', amount: '1000' },
      ] });
      glBatch(org, { start: '2026-07-01', end: '2026-08-31', tag: 'l2-b', lines: [
        { date: '2026-07-01', category: 'receivables', direction: 'debit', amount: '6000', opening: true },
        { date: '2026-07-01', category: 'equity', direction: 'credit', amount: '6000', opening: true },
        { date: '2026-07-05', category: 'receivables', direction: 'debit', amount: '1000' },
        { date: '2026-07-05', category: 'revenue', direction: 'credit', amount: '1000' },
        { date: '2026-08-15', category: 'cash', direction: 'debit', amount: '2000' },
        { date: '2026-08-15', category: 'receivables', direction: 'credit', amount: '2000' },
      ] });
      break;
    }
    case 'TBBS': {
      // A cumulative trial balance AND a cumulative balance sheet for August, both listing receivables 9,000.
      balanceBatch(org, { importType: 'trial_balance', basis: 'cumulative', ...month('2026-08'), tag: 'tbbs-tb',
        rows: [['receivables', '9000'], ['payables', '-4000'], ['revenue', '-5000'], ['cost_of_sales', '2000']] });
      balanceBatch(org, { importType: 'balance_sheet', basis: 'cumulative', ...month('2026-08'), tag: 'tbbs-bs',
        rows: [['receivables', '9000'], ['payables', '-4000']] });
      break;
    }
    case 'MOVTB': {
      // A MOVEMENT-basis trial balance and a CUMULATIVE balance sheet for August. The balance sheet states 9,000.
      balanceBatch(org, { importType: 'trial_balance', basis: 'movement', ...month('2026-08'), tag: 'mov-tb',
        rows: [['receivables', '1000'], ['revenue', '-1000']] });
      balanceBatch(org, { importType: 'balance_sheet', basis: 'cumulative', ...month('2026-08'), tag: 'mov-bs',
        rows: [['receivables', '9000'], ['payables', '-4000']] });
      break;
    }
    case 'CURRENT': {
      // Realistic commit timing: a sales list committed 2026-09-10 (before the run's as-of 2026-09-15),
      // declared 1 June – 10 September (min/max dates of the file).
      const c = counterparty(org, 'Cur Ltd', 'customer');
      invoiceBatch(org, { importType: 'sales_invoices', start: '2026-06-01', end: '2026-09-10', listKind: 'full', committedAt: '2026-09-10T10:00:00Z', tag: 'cur',
        invoices: [
          { type: 'sales', party: c, number: 'C-1', issue: '2026-07-01', due: '2026-07-31', subtotal: '1000', tax: '0', total: '1000', paid: '0', paidDate: null, status: 'open' },
          { type: 'sales', party: c, number: 'C-2', issue: '2026-09-02', due: '2026-10-02', subtotal: '500', tax: '0', total: '500', paid: '0', paidDate: null, status: 'open' },
        ] });
      break;
    }
    case 'CREDITHEAVY': {
      const c = counterparty(org, 'Cred Ltd', 'customer');
      invoiceBatch(org, { importType: 'sales_invoices', ...{ start: '2026-06-01', end: '2026-08-31' }, listKind: 'full', tag: 'ch', invoices: [
        { type: 'sales', party: c, number: 'H-1', issue: '2026-06-05', due: '2026-07-05', subtotal: '1000', tax: '0', total: '1000', paid: '0', paidDate: null, status: 'open' },
        { type: 'sales', party: c, number: 'H-2', issue: '2026-07-05', due: '2026-08-05', subtotal: '800', tax: '0', total: '800', paid: '0', paidDate: null, status: 'open' },
        { type: 'sales_credit_note', party: c, number: 'HC-1', issue: '2026-08-10', due: '2026-08-10', subtotal: '2500', tax: '0', total: '2500', paid: '0', paidDate: null, status: 'open' },
      ] });
      break;
    }
    case 'PARTIALPD': {
      // An invoice part-paid with the payment's date recorded (paid_date set, balance still due).
      // PD-1: total 1,000, 400 paid on 07-15, due 07-10 → July-end receivables 600, overdue 600.
      // PD-2: total 500 paid EXACTLY on 07-31 (the as-of date) → 0 at July end.
      const c = counterparty(org, 'Part Ltd', 'customer');
      invoiceBatch(org, { importType: 'sales_invoices', start: '2026-06-01', end: '2026-08-31', listKind: 'full', tag: 'pd', invoices: [
        { type: 'sales', party: c, number: 'PD-1', issue: '2026-06-20', due: '2026-07-10', subtotal: '1000', tax: '0', total: '1000', paid: '400', paidDate: '2026-07-15', status: 'partially_paid' },
        { type: 'sales', party: c, number: 'PD-2', issue: '2026-07-01', due: '2026-07-20', subtotal: '500', tax: '0', total: '500', paid: '500', paidDate: '2026-07-31', status: 'paid' },
      ] });
      break;
    }
    case 'LONG': {
      // 15 months (June 2025 – August 2026) of statements + sales invoices: crosses a 12-period chunk boundary.
      // Opening 50,000 typed at 2025-05-31; each month +3,000 in, −4,000 out. Sales: one invoice per month,
      // 1,200 gross, due in 30 days, paid 45 days after issue (so some overdue at each month end).
      const bank = bankAccount(org, '50000', '2025-05-31');
      const months = monthsFrom('2025-06', 15);
      for (const ym of months) {
        statement(org, bank, { ...month(ym), moves: [{ date: `${ym}-05`, amount: '3000' }, { date: `${ym}-20`, amount: '-4000' }], tag: `long-${ym}` });
      }
      const c = counterparty(org, 'Long Ltd', 'customer');
      const s = counterparty(org, 'Long Supplies', 'supplier', 'cost_of_sales');
      const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
      invoiceBatch(org, { importType: 'sales_invoices', start: '2025-06-01', end: '2026-08-31', listKind: 'full', tag: 'long-s', invoices:
        months.map((ym, i) => {
          const issue = `${ym}-10`; const paidDate = addDays(issue, 45); const paid = paidDate <= '2026-09-15';
          return { type: 'sales' as const, party: c, number: `L-${i}`, issue, due: addDays(issue, 30), subtotal: String(1000 + i * 50), tax: String(200 + i * 10),
            total: String(1200 + i * 60), paid: paid ? String(1200 + i * 60) : '0', paidDate: paid ? paidDate : null, status: paid ? 'paid' as const : 'open' as const };
        }) });
      invoiceBatch(org, { importType: 'purchase_invoices', start: '2025-06-01', end: '2026-08-31', listKind: 'full', tag: 'long-p', invoices:
        months.map((ym, i) => {
          const issue = `${ym}-12`; const paidDate = addDays(issue, 20);
          return { type: 'purchase' as const, party: s, number: `LP-${i}`, issue, due: addDays(issue, 30), subtotal: '500', tax: '100',
            total: '600', paid: '600', paidDate, status: 'paid' as const };
        }) });
      break;
    }
    case 'BSREV': {
      // Monthly cumulative balance sheets (receivables 3,000) March–August, no TB/GL/bank, plus ONE sales
      // list declared for March only, committed 5 April. Revenue after March is unknown (no source).
      for (const ym of monthsFrom('2026-03', 6)) {
        balanceBatch(org, { importType: 'balance_sheet', basis: 'cumulative', ...month(ym), tag: `bsr-${ym}`,
          rows: [['receivables', '3000'], ['payables', '-1000']] });
      }
      const c = counterparty(org, 'BsRev Ltd', 'customer');
      invoiceBatch(org, { importType: 'sales_invoices', ...month('2026-03'), listKind: 'full', committedAt: '2026-04-05T09:00:00Z', tag: 'bsr-s',
        invoices: [{ type: 'sales', party: c, number: 'R-1', issue: '2026-03-10', due: '2026-04-10', subtotal: '3000', tax: '0', total: '3000', paid: '3000', paidDate: '2026-04-08', status: 'paid' }] });
      break;
    }
    case 'BIGINV': {
      // 1,050 open sales invoices, each to its own customer, 10.00 gross, issued 07-01, due 07-15:
      // receivables Aug = 10,500.00, all overdue. Plus a statement so cash is known.
      adminSql(`do $$ declare v_doc uuid; v_b uuid; v_row uuid; v_id uuid; v_c uuid; i int; begin
        insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
          values ('${org}', '${org}/audit/big-' || gen_random_uuid(), 'big.csv', 'text/csv', 10, digest(gen_random_uuid()::text, 'sha256'), 'ready', 'invoice') returning id into v_doc;
        insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method,
            period_start, period_end, committed_at, invoice_list_kind)
          values ('${org}', v_doc, 'sales_invoices', 'invoices', 'committed', 'csv', '2026-06-01', '2026-08-31', '${COMMITTED_AT}', 'full') returning id into v_b;
        for i in 1..1050 loop
          insert into public.counterparties (organization_id, name, kind) values ('${org}', 'Cust ' || i, 'customer') returning id into v_c;
          insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
            values ('${org}', v_b, i, 'r' || i, '{}'::jsonb, '{}'::jsonb, 'committed') returning id into v_row;
          insert into public.invoices (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
              subtotal, tax_amount, total_amount, amount_paid, paid_date, status, record_status, assurance_level,
              source_document_id, import_batch_id, import_row_id, source_ref)
            values ('${org}', 'sales', v_c, 'B-' || i, '2026-07-01', '2026-07-15', '00000000-0000-0000-0000-000000000000',
              10, 0, 10, 0, null, 'open', 'accepted', 'verified', v_doc, v_b, v_row, 'bi' || i) returning id into v_id;
          insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id)
            values ('${org}', 'invoices', v_id, 'accepted', v_b);
        end loop;
      end $$;`);
      const bank = bankAccount(org, '1000', '2026-05-31');
      for (const ym of ['2026-06', '2026-07', '2026-08']) statement(org, bank, { ...month(ym), moves: [{ date: `${ym}-11`, amount: '-10' }], tag: `big-${ym}` });
      break;
    }
  }
}
