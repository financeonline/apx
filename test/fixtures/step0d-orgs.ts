import { adminSql, clientFor, createAuthUser } from '../integration/setup';

/**
 * Step 0D's additions to the engine comparison: AI-read statements, opening cash carried out of
 * them, mixed assurance across accounts, and customer identity under Unicode names.
 *
 * SELF-CONTAINED on purpose: the comparison job copies this file (and its test) into the BASELINE
 * worktree, so both engines compute the same seeded data. It uses only `../integration/setup`, which
 * the baseline has, and SQL the baseline schema accepts.
 *
 * Customers are resolved the way `api.create_import_counterparties` resolves them: insert on the
 * organisation's name key, then look the record up by `app.normalize_name`. Each database therefore
 * applies ITS OWN key — the baseline's [a-z0-9] key merges "Müller" with "Möller" and every
 * non-Latin name into one, the branch's Unicode key does not — which is the identity change the
 * comparison must show.
 */

export type Step0dKey = 'AICARRY' | 'AIATTEST' | 'AIMIXED' | 'UNICODE';
export const STEP0D_KEYS: readonly Step0dKey[] = ['AICARRY', 'AIATTEST', 'AIMIXED', 'UNICODE'];

const COMMITTED_AT = '2026-09-10T10:00:00Z';
const q = (s: string): string => s.replace(/'/g, "''");

type Extraction = 'csv' | 'pdf_text' | 'pdf_claude';

export function bankAccount(org: string, name: string): string {
  return adminSql(`insert into public.bank_accounts (organization_id, name, bank_name, account_type, is_active)
    values ('${org}', '${q(name)}', 'Test Bank', 'current', true) returning id`).split('\n')[0]!.trim();
}

/**
 * A committed statement and its rows. `extraction` and the rows' assurance are what commit writes
 * (`statementRecordAssurance`): AI-read rows `inferred`; an unreconciled text PDF `calculated`
 * (IMP-BAL-006 on the batch); CSV `verified`.
 */
export function statement(org: string, bank: string, o: {
  start: string; end: string; extraction: Extraction; unreconciled?: boolean;
  opening?: string; closing?: string; moves: ReadonlyArray<readonly [string, string]>; tag: string;
}): string {
  const rowAssurance = o.extraction === 'pdf_claude' ? 'inferred' : o.unreconciled ? 'calculated' : 'verified';
  const issues = o.unreconciled ? `'[{"code":"IMP-BAL-006","severity":"warning","message":"does not reconcile"}]'::jsonb` : `'[]'::jsonb`;
  const values = o.moves.map(([d, a]) => `('${d}'::date, ${a}::numeric)`).join(',');
  return adminSql(`do $$ declare v_doc uuid; v_b uuid; v_row uuid; v_id uuid; r record; n int := 0; begin
    insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
      values ('${org}', '${org}/step0d/${o.tag}-' || gen_random_uuid(), '${o.tag}.${o.extraction === 'csv' ? 'csv' : 'pdf'}',
              '${o.extraction === 'csv' ? 'text/csv' : 'application/pdf'}', 10, digest(gen_random_uuid()::text, 'sha256'), 'ready', 'bank_statement')
      returning id into v_doc;
    insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method,
        period_start, period_end, committed_at, bank_account_id, statement_opening_balance, statement_closing_balance, batch_issues)
      values ('${org}', v_doc, 'bank_statement', 'bank_transactions', 'committed', '${o.extraction}', '${o.start}', '${o.end}',
        '${COMMITTED_AT}'::timestamptz, '${bank}', ${o.opening ?? 'null'}, ${o.closing ?? 'null'}, ${issues}) returning id into v_b;
    for r in select * from (values ${values}) v(d, a) loop
      n := n + 1;
      insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
        values ('${org}', v_b, n, 'r' || n, '{}'::jsonb, '{}'::jsonb, 'committed') returning id into v_row;
      insert into public.bank_transactions (organization_id, bank_account_id, transaction_date, amount, currency, description_raw,
          description_normalized, period_id, category_source, record_status, assurance_level, duplicate_reviewed, source_document_id,
          import_batch_id, import_row_id, source_ref, is_transfer, transfer_kind)
        values ('${org}', '${bank}', r.d, r.a, 'GBP', 'mv ' || n || ' ' || v_b, 'mv ' || n || ' ' || v_b,
          '00000000-0000-0000-0000-000000000000', 'none', 'accepted', '${rowAssurance}', true, v_doc, v_b, v_row, 'b' || n, false, 'none')
        returning id into v_id;
      insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id)
        values ('${org}', 'bank_transactions', v_id, 'accepted', v_b);
    end loop;
    perform set_config('step0d.last', v_b::text, false);
  end $$; select current_setting('step0d.last');`).split('\n').at(-1)!.trim();
}

/** A customer, resolved by the organisation's own name key, exactly as an invoice import resolves one. */
function customer(org: string, name: string): string {
  return adminSql(`
    insert into public.counterparties (organization_id, name, kind) values ('${org}', '${q(name)}', 'customer')
      on conflict (organization_id, normalized_name) do nothing;
    select id from public.counterparties
     where organization_id = '${org}' and normalized_name = app.normalize_name('${q(name)}');`).split('\n').at(-1)!.trim();
}

/** A full sales list for June–August, one July invoice per name; the name decides the customer. */
function salesList(org: string, sales: ReadonlyArray<readonly [string, string]>): void {
  const rows = sales.map(([name, total], i) => {
    const id = customer(org, name);
    return `('${id}'::uuid, 'S-${i + 1}', ${total}::numeric)`;
  }).join(',');
  adminSql(`do $$ declare v_doc uuid; v_b uuid; v_row uuid; v_id uuid; r record; n int := 0; begin
    insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
      values ('${org}', '${org}/step0d/sales-' || gen_random_uuid(), 'sales.csv', 'text/csv', 10, digest(gen_random_uuid()::text, 'sha256'), 'ready', 'invoice')
      returning id into v_doc;
    insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method,
        period_start, period_end, committed_at, invoice_list_kind)
      values ('${org}', v_doc, 'sales_invoices', 'invoices', 'committed', 'csv', '2026-06-01', '2026-08-31', '${COMMITTED_AT}'::timestamptz, 'full')
      returning id into v_b;
    for r in select * from (values ${rows}) v(p, num, tot) loop
      n := n + 1;
      insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
        values ('${org}', v_b, n, 'r' || n, '{}'::jsonb, '{}'::jsonb, 'committed') returning id into v_row;
      insert into public.invoices (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id,
          subtotal, tax_amount, total_amount, amount_paid, paid_date, status, record_status, assurance_level,
          source_document_id, import_batch_id, import_row_id, source_ref)
        values ('${org}', 'sales', r.p, r.num, '2026-07-10', '2026-08-09', '00000000-0000-0000-0000-000000000000',
          r.tot, 0, r.tot, 0, null, 'open', 'accepted', 'verified', v_doc, v_b, v_row, 'i' || n || v_b) returning id into v_id;
      insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id)
        values ('${org}', 'invoices', v_id, 'accepted', v_b);
    end loop;
  end $$;`);
}

function seedOne(key: Step0dKey, org: string): void {
  switch (key) {
    case 'AICARRY': {
      // June CSV (printed 10,000 → 9,000); July READ BY AI; August CSV with no printed balance.
      // Truth: Jun 9,000 · Jul 8,500 · Aug 8,700. August's opening and closing are carried through July.
      const main = bankAccount(org, 'Main');
      statement(org, main, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '10000', closing: '9000', moves: [['2026-06-10', '-1000']], tag: 'ac-jun' });
      statement(org, main, { start: '2026-07-01', end: '2026-07-31', extraction: 'pdf_claude', moves: [['2026-07-03', '2000'], ['2026-07-18', '-2500']], tag: 'ac-jul' });
      statement(org, main, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', moves: [['2026-08-05', '3000'], ['2026-08-20', '-2800']], tag: 'ac-aug' });
      break;
    }
    case 'AIATTEST': {
      // As AICARRY, but August's CSV prints its opening (8,500), which agrees with the chain.
      const main = bankAccount(org, 'Main');
      statement(org, main, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '10000', closing: '9000', moves: [['2026-06-10', '-1000']], tag: 'at-jun' });
      statement(org, main, { start: '2026-07-01', end: '2026-07-31', extraction: 'pdf_claude', moves: [['2026-07-03', '2000'], ['2026-07-18', '-2500']], tag: 'at-jul' });
      statement(org, main, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', opening: '8500', moves: [['2026-08-05', '3000'], ['2026-08-20', '-2800']], tag: 'at-aug' });
      break;
    }
    case 'AIMIXED': {
      // Two accounts. Main: July read by AI. Reserve: July an UNRECONCILED text PDF. August CSV on both.
      const main = bankAccount(org, 'Main');
      const reserve = bankAccount(org, 'Reserve');
      statement(org, main, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '5000', moves: [['2026-06-12', '-400']], tag: 'am-m-jun' });
      statement(org, main, { start: '2026-07-01', end: '2026-07-31', extraction: 'pdf_claude', moves: [['2026-07-12', '-300']], tag: 'am-m-jul' });
      statement(org, main, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', moves: [['2026-08-12', '1200']], tag: 'am-m-aug' });
      statement(org, reserve, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '2000', moves: [['2026-06-15', '100']], tag: 'am-r-jun' });
      statement(org, reserve, { start: '2026-07-01', end: '2026-07-31', extraction: 'pdf_text', unreconciled: true, moves: [['2026-07-15', '100']], tag: 'am-r-jul' });
      statement(org, reserve, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', moves: [['2026-08-15', '100']], tag: 'am-r-aug' });
      break;
    }
    case 'UNICODE': {
      // One July invoice per name. Under the baseline key the five non-Latin names are ONE customer
      // (key '') and Möller is Müller; under the Unicode key there are nine customers — the Greek
      // name in two cases is one, and so are "İzmir Ltd" and "Izmir Ltd" (İ lower-cases to i).
      salesList(org, [
        ['Müller GmbH', '5000'], ['Möller GmbH', '3000'], ['Muller GmbH', '1000'],
        ['株式会社トヨタ', '4000'], ['شركة الأمل', '3500'], ['ΟΔΟΣ Α.Ε.', '1500'], ['οδος α.ε.', '1500'],
        ['ООО «Ромашка»', '2000'], ['İzmir Ltd', '800'], ['Izmir Ltd', '700'],
      ]);
      break;
    }
  }
}

export async function seedStep0dOrgs(tag: string): Promise<Record<Step0dKey, string>> {
  const owner = createAuthUser(`s0d@${tag}.step0d.itest`);
  const out = {} as Record<Step0dKey, string>;
  for (const key of STEP0D_KEYS) {
    const r = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `STEP0D ${key} ${tag}` });
    if (r.error) throw new Error(r.error.message);
    out[key] = r.data as unknown as string;
    seedOne(key, out[key]);
  }
  return out;
}

/** Who the organisation's invoices are booked to: `name|invoices|total`, by name. */
export function identityDump(org: string): string[] {
  return adminSql(`select c.name || '|' || count(i.id) || '|' || coalesce(sum(i.total_amount), 0)::numeric(14, 2)
      from public.counterparties c left join public.invoices i on i.counterparty_id = c.id and i.organization_id = c.organization_id
     where c.organization_id = '${org}' group by c.name order by c.name`).split('\n').filter(Boolean);
}
