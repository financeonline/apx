import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Decimal } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { resolveDescriptor } from '@/modules/evidence';
import { drainJobs } from '@/modules/jobs';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * Every leaf descriptor an organisation produces must reconcile to the figure it sits behind
 * (ADR-109).
 *
 * Phase 14 fixed this invariant four times in four places: the amount basis (ADR-105), voided
 * invoices (ADR-107), merged counterparties (ADR-108), and `other_income` (ADR-109). Each fix was
 * correct and local, and each time the next audit found another family where the same invariant was
 * broken, because nothing checked the families no one had thought to test.
 *
 * This is that check. It does not name metrics. It seeds three organisations on the three P&L bases,
 * reads EVERY row of `metric_current` whose snapshot carries a leaf descriptor, resolves each
 * descriptor through the real evidence service under the owner's RLS, and asserts that the sum of
 * what comes back equals the figure. A new figure with a new descriptor joins this test by existing;
 * a descriptor that selects the wrong population fails it without anyone having predicted the shape
 * of the mistake.
 *
 * The fixture deliberately includes rows the figures exclude — voided invoices, a credit note, an
 * uncategorised payment, a matched transfer pair and an unpaired transfer candidate, ledger accounts
 * with entries on both sides, and contacts on payables, receivables and bank lines — so that a
 * descriptor which is merely too broad, or totalled in the wrong sign, is caught rather than flattered.
 *
 * The bank rows that carry a category are categorised by the USER. The banking pass re-derives `rule`
 * categories, and with no rule to match it cleared them, so every bank P&L and counterparty line in
 * this fixture used to be a zero — which is how HIGH-3 and the negative bank expense drill-down both
 * sat behind a green sweep (ADR-110). No family is exempt: HIGH-3 is closed.
 */
const RUN = `sw${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.sweep.itest`;
const one = (s: string) => adminSql(`with q as (${s}) select * from q`).trim();
let owner: string; let owner2: string;
const ownerOf = new Map<string, string>();
const whose = (o: string) => ownerOf.get(o) ?? owner;
const orgs: Array<{ id: string; label: string }> = [];

const ctxFor = (org: string): AccessContext => ({
  userId: whose(org), orgId: org, orgSlug: 'x', effectiveRole: 'owner', permissions: permissionsFor('owner'),
  actorType: 'user', db: clientFor(whose(org)), requestId: RUN, now: () => new Date('2026-09-15T00:00:00Z'), organizationStatus: 'active',
});
async function createOrg(name: string, who: string): Promise<string> {
  const r = await clientFor(who).schema('api').rpc('create_organization', { p_name: name });
  if (r.error) throw new Error(r.error.message);
  const id = r.data as unknown as string; ownerOf.set(id, who); return id;
}
const cp = (org: string, name: string, kind: string, cat: string | null = null) =>
  one(`insert into public.counterparties (organization_id, name, kind, default_expense_category) values ('${org}','${name}','${kind}',${cat === null ? 'null' : `'${cat}'`}) returning id`);
const acct = (org: string, cat: string) => one(`select id from public.accounts where organization_id='${org}' and standard_category='${cat}' and is_system limit 1`);
async function calc(org: string) {
  const j = adminSql(`insert into public.jobs (organization_id, job_type, payload, max_attempts) values ('${org}','calculation.run','{"trigger":"recalc_manual","as_of":"2026-09-15"}'::jsonb,3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, j)).toBe('succeeded');
}

beforeAll(async () => {
  owner = createAuthUser(`o1@${DOMAIN}`); owner2 = createAuthUser(`o2@${DOMAIN}`);

  // ---------- INVOICE basis ----------
  const iOrg = await createOrg(`SW inv ${RUN}`, owner); orgs.push({ id: iOrg, label: 'invoice' });
  const c1 = cp(iOrg, 'Cust One', 'customer'); const c2 = cp(iOrg, 'Cust Two', 'customer');
  const s1 = cp(iOrg, 'Stock', 'supplier', 'cost_of_sales');
  const s2 = cp(iOrg, 'Ads', 'supplier', 'marketing');
  const s3 = cp(iOrg, 'Bank Chg', 'supplier', 'interest_expense');
  const inv = (t: string, c: string, n: string, sub: string, st = 'open') => {
    const tax = new Decimal(sub).times('0.2').toFixed(2);
    return one(`insert into public.invoices (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, due_date, period_id, subtotal, tax_amount, total_amount, amount_paid, status, record_status, assurance_level)
      values ('${iOrg}','${t}','${c}','${n}','2026-08-10','2026-09-09','00000000-0000-0000-0000-000000000000',${sub},${tax},${new Decimal(sub).plus(tax).toFixed(2)},0,'${st}','accepted','verified') returning id`);
  };
  inv('sales', c1, 'S1', '14000.00'); inv('sales', c2, 'S2', '6000.00');
  inv('sales_credit_note', c1, 'CN1', '1500.00');
  inv('sales', c1, 'SV', '9999.00', 'void');
  inv('purchase', s1, 'P1', '3200.00'); inv('purchase', s2, 'P2', '1100.00'); inv('purchase', s3, 'P3', '260.00');
  inv('purchase', s1, 'PV', '7777.00', 'void');
  adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event) select organization_id,'invoices',id,'accepted' from public.invoices where organization_id='${iOrg}'`);
  const idoc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind) values ('${iOrg}','${iOrg}/i.csv','i.csv','text/csv',10,digest('${iOrg}i','sha256'),'ready','invoice') returning id`);
  adminSql(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at, invoice_list_kind, confirmations) values ('${iOrg}','${idoc}','sales_invoices','invoices','committed','csv','2026-08-01','2026-08-31',now(),'full', '{"IMP-INV-013": {"by": null, "at": "2026-09-01T00:00:00Z", "value": {"opening": "complete"}}}'::jsonb)`);
  // FU-12: costs need a full purchase list (ADR-126).
  adminSql(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at, invoice_list_kind, confirmations) values ('${iOrg}','${idoc}','purchase_invoices','invoices','committed','csv','2026-08-01','2026-08-31',now(),'full', '{"IMP-INV-013": {"by": null, "at": "2026-09-01T00:00:00Z", "value": {"opening": "complete"}}}'::jsonb)`);
  await calc(iOrg);

  // ---------- LEDGER basis ----------
  const lOrg = await createOrg(`SW led ${RUN}`, owner2); orgs.push({ id: lOrg, label: 'ledger' });
  const lc = cp(lOrg, 'L Cust', 'customer'); const ls = cp(lOrg, 'L Supp', 'supplier');
  const ldoc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind) values ('${lOrg}','${lOrg}/g.csv','g.csv','text/csv',10,digest('${lOrg}g','sha256'),'ready','general_ledger') returning id`);
  const lb = one(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at) values ('${lOrg}','${ldoc}','general_ledger','ledger_entries','committed','csv','2026-08-01','2026-08-31',now()) returning id`);
  let n = 0;
  const entry = (cat: string, dir: string, amt: string, party: string | null) => {
    n += 1;
    const row = one(`insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status) values ('${lOrg}','${lb}',${n},'r${n}','{}'::jsonb,'{}'::jsonb,'committed') returning id`);
    const e = one(`insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status, source_document_id, import_batch_id, import_row_id, source_ref, counterparty_id) values ('${lOrg}','2026-08-15','${acct(lOrg, cat)}','${dir}',${amt},'00000000-0000-0000-0000-000000000000','accepted','${ldoc}','${lb}','${row}','r${n}',${party === null ? 'null' : `'${party}'`}) returning id`);
    adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id) values ('${lOrg}','ledger_entries','${e}','accepted','${lb}')`);
  };
  entry('revenue', 'credit', '18000.00', lc); entry('revenue', 'credit', '2400.00', null);
  entry('cost_of_sales', 'debit', '5200.00', ls); entry('marketing', 'debit', '900.00', ls);
  entry('payroll', 'debit', '4300.00', null); entry('interest_expense', 'debit', '150.00', null);
  entry('other_income', 'credit', '700.00', null);
  // Both sides of one account, and a contact on the settling lines of its own journals, as a
  // general-ledger export prints it: a refund, a supplier credit, and the payables and bank legs.
  // Without these every ledger account was one-sided and HIGH-5 and HIGH-6 passed unseen (ADR-111).
  entry('revenue', 'debit', '600.00', lc); entry('cost_of_sales', 'credit', '250.00', ls);
  entry('payables', 'credit', '5200.00', ls); entry('payables', 'debit', '5200.00', ls); entry('cash', 'credit', '5200.00', ls);
  entry('receivables', 'debit', '18000.00', lc);
  await calc(lOrg);

  // ---------- BANK basis, with a transfer pair and an UNPAIRED transfer candidate ----------
  const bOrg = await createOrg(`SW bank ${RUN}`, owner2); orgs.push({ id: bOrg, label: 'bank' });
  const bc = cp(bOrg, 'B Cust', 'customer'); const bs = cp(bOrg, 'B Supp', 'supplier');
  const mk = (name: string, type: string, open: string) => one(`insert into public.bank_accounts (organization_id, name, bank_name, account_type, opening_balance, opening_balance_date, is_active) values ('${bOrg}','${name}','Test Bank','${type}',${open},'2026-08-01',true) returning id`);
  const main = mk('Main', 'current', '5000.00'); const savings = mk('Savings', 'savings', '1000.00');
  const bdoc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind) values ('${bOrg}','${bOrg}/b.csv','b.csv','text/csv',10,digest('${bOrg}b','sha256'),'ready','bank_statement') returning id`);
  const bb = one(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at, bank_account_id) values ('${bOrg}','${bdoc}','bank_statement','bank_transactions','committed','csv','2026-08-01','2026-08-31',now(),'${main}') returning id`);
  let m = 0;
  const tx = (bank: string, amt: string, desc: string, cat: string | null, kind = 'none') => {
    m += 1;
    const row = one(`insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status) values ('${bOrg}','${bb}',${m},'t${m}','{}'::jsonb,'{}'::jsonb,'committed') returning id`);
    const t = one(`insert into public.bank_transactions (organization_id, bank_account_id, transaction_date, amount, currency, description_raw, description_normalized, period_id, category_source, record_status, assurance_level, duplicate_reviewed, source_document_id, import_batch_id, import_row_id, source_ref, counterparty_id, category_account_id, is_transfer, transfer_kind)
      values ('${bOrg}','${bank}','2026-08-16',${amt},'GBP','${desc}','${desc}','00000000-0000-0000-0000-000000000000','${cat === null ? 'none' : 'user'}','accepted','verified',false,'${bdoc}','${bb}','${row}','t${m}',${cat === 'revenue' ? `'${bc}'` : `'${bs}'`},${cat === null ? 'null' : `'${acct(bOrg, cat)}'`},${kind !== 'none'},'${kind}') returning id`);
    adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id) values ('${bOrg}','bank_transactions','${t}','accepted','${bb}')`);
    return t;
  };
  tx(main, '12000.00', 'CUSTOMER RECEIPT', 'revenue');
  tx(main, '-3400.00', 'SUPPLIER PAYMENT', 'cost_of_sales');
  tx(main, '-800.00', 'ADVERTISING', 'marketing');
  // A matched pair between own accounts: both legs should be excluded from inflows/outflows.
  tx(main, '-2000.00', 'TRANSFER TO SAVINGS', null, 'cash_transfer');
  tx(savings, '2000.00', 'TRANSFER FROM MAIN', null, 'cash_transfer');
  // An UNPAIRED transfer candidate: flagged, but with no matching leg it is still money out.
  tx(main, '-650.00', 'TRANSFER TO ELSEWHERE', null, 'cash_transfer');
  await calc(bOrg);
}, 900_000);

afterAll(() => {
  adminSql(`delete from public.organizations where id in (${orgs.map((o) => `'${o.id}'`).join(',')}); delete from auth.users where email like '%@${DOMAIN}';`);
});


describe('every leaf descriptor reconciles to its figure (ADR-109)', () => {
  it('walks every leaf descriptor three organisations produce', async () => {
    let checked = 0; const mismatches: string[] = [];
    for (const { id: org, label } of orgs) {
      const rows = adminSql(`select c.metric_key || '|' || coalesce(c.dimension_id::text,'-') || '|' || c.dimension_type || '|' || coalesce(s.value::text,'NULL') || '|' || s.unit || '|' || s.basis || '|' || s.evidence_query::text
        from public.metric_current c join public.metric_snapshots s on s.id=c.snapshot_id
        where c.organization_id='${org}' and s.evidence_query is not null and s.evidence_query->>'kind'='leaf'
        order by c.metric_key, c.dimension_id`).split('\n').filter(Boolean);
      for (const line of rows) {
        const [key, dim, dimType, value, unit, basis, ...rest] = line.trim().split('|');
        const descriptor = (JSON.parse(rest.join('|')) as { descriptor: unknown }).descriptor;
        const sel = await resolveDescriptor(ctxFor(org), descriptor);
        checked += 1;
        const fig = value === 'NULL' ? 'NULL' : new Decimal(value!).toFixed(2);
        const tot = sel.total === null ? 'NULL' : new Decimal(sel.total).toFixed(2);
        const ok = fig === tot;
        const note = `${label} ${key}${dim === '-' ? '' : `[${dimType}]`} unit=${unit} basis=${basis} figure=${fig} evidence=${tot} rows=${sel.count}`;
        if (!ok) mismatches.push(note);
      }
    }
    console.log(`SWEEP checked ${checked}, mismatches ${mismatches.length}`);
    // A sweep that checked nothing would pass silently, so the fixture's own output is asserted too.
    expect(checked, 'the fixture must produce leaf descriptors to check').toBeGreaterThan(40);
    expect(mismatches, `figure != Σ evidence:\n${mismatches.join('\n')}`).toEqual([]);
  });
});
