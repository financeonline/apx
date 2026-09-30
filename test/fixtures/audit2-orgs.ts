/**
 * The nine adversarial organisations of the SECOND independent audit of ADR-120
 * (docs/ADR-120_SECOND_INDEPENDENT_AUDIT.md), kept as permanent fixtures for ADR-124 — each reproduces
 * one finding (N-1 … N-8, P-2). They were written by the auditor, not by the implementer, and their
 * data shapes are preserved exactly: only the header, the names and the imports changed on the move
 * out of the audit's scratch directory.
 *
 * Raw accepted records under committed batches (the shape a real commit leaves); every figure comes
 * only from a real `calculation.run` job through the queue. Commit times are fixed, never `now()`.
 *
 *   GAPGL     N-1  statements June + August, JULY MISSING, a GL spanning June–August (ledger "covers" July)
 *   PARTJUL   N-1  a July statement that ends on the 15th
 *   NEWACCT   N-3  account A typed + unbalanced CSVs; account B opens in August (a joiner)
 *   BSLIST    N-4  monthly balance sheets + one sales list committed DURING August
 *   LEDGER3   N-5  a second GL export whose opening journal is dated 15 July (mid-month)
 *   UNRECON   N-8  June uploaded twice; only the superseded upload was unreconciled
 *   CNFUTURE  N-7  an overdue invoice and a credit note not yet due ("500 %")
 *   MIDTYPED  N-2  a typed opening plus a first month split across two statements
 *   CYCLE     P-2  statements that run from the 5th to the 4th
 */
import { adminSql, clientFor, createAuthUser } from '../integration/setup';
import { balanceBatch, bankAccount, counterparty, glBatch, invoiceBatch, month, statement } from './audit-orgs';

export type Audit2Key = 'GAPGL' | 'PARTJUL' | 'NEWACCT' | 'BSLIST' | 'LEDGER3' | 'UNRECON' | 'CNFUTURE' | 'MIDTYPED' | 'CYCLE';

/** Seeds the probe organisations (two per owner, like the other fixtures). */
export async function seedAudit2Orgs(tag: string, keys: readonly Audit2Key[]): Promise<Partial<Record<Audit2Key, string>>> {
  const out: Partial<Record<Audit2Key, string>> = {};
  let n = 0;
  let owner = '';
  for (const key of keys) {
    if (n % 2 === 0) owner = createAuthUser(`aud2-${n}@${tag}.adr124.itest`);
    n += 1;
    const r = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `ADR124 ${key} ${tag}` });
    if (r.error) throw new Error(r.error.message);
    const org = r.data as unknown as string;
    out[key] = org;
    seedOne(key, org);
  }
  return out;
}

const imp007 = (raw: string): void => {
  const batch = raw.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)!;
  adminSql(`update public.import_batches set batch_issues = '[{"code":"IMP-BAL-007","severity":"warning","message":"balances not read"}]'::jsonb where id = '${batch}'`);
};

function seedOne(key: Audit2Key, org: string): void {
  switch (key) {
    case 'GAPGL': {
      // GAP (June + August statements, JULY MISSING) but a GL spans June–August, so the cash family is
      // "covered" by the ledger in July. The GL's cash account shows July's −5,000.
      // Truth: Jun 9,000 · Jul 4,000 · Aug 3,500. AR 2,000 / AP 1,000 throughout (opening journal).
      const bank = bankAccount(org, null, null);
      statement(org, bank, { ...month('2026-06'), opening: '10000', closing: '9000', moves: [{ date: '2026-06-10', amount: '-1000' }], tag: 'gg-jun' });
      statement(org, bank, { ...month('2026-08'), opening: '4000', closing: '3500', moves: [{ date: '2026-08-10', amount: '-500' }], tag: 'gg-aug' });
      glBatch(org, { start: '2026-06-01', end: '2026-08-31', tag: 'gg-gl', lines: [
        { date: '2026-06-01', category: 'receivables', direction: 'debit', amount: '2000', opening: true },
        { date: '2026-06-01', category: 'payables', direction: 'credit', amount: '1000', opening: true },
        { date: '2026-06-01', category: 'equity', direction: 'credit', amount: '1000', opening: true },
        { date: '2026-06-10', category: 'cost_of_sales', direction: 'debit', amount: '1000' },
        { date: '2026-06-10', category: 'cash', direction: 'credit', amount: '1000' },
        { date: '2026-07-15', category: 'cost_of_sales', direction: 'debit', amount: '5000' },
        { date: '2026-07-15', category: 'cash', direction: 'credit', amount: '5000' },
        { date: '2026-08-10', category: 'cost_of_sales', direction: 'debit', amount: '500' },
        { date: '2026-08-10', category: 'cash', direction: 'credit', amount: '500' },
      ] });
      break;
    }
    case 'PARTJUL': {
      // July's statement ends on the 15th (the 20th's −3,000 was never uploaded).
      // Truth: Jun 9,000 · Jul 4,000 · Aug 3,500.
      const bank = bankAccount(org, null, null);
      statement(org, bank, { ...month('2026-06'), opening: '10000', closing: '9000', moves: [{ date: '2026-06-10', amount: '-1000' }], tag: 'pj-jun' });
      statement(org, bank, { start: '2026-07-01', end: '2026-07-15', opening: '9000', closing: '7000', moves: [{ date: '2026-07-05', amount: '-2000' }], tag: 'pj-jul' });
      statement(org, bank, { ...month('2026-08'), opening: '4000', closing: '3500', moves: [{ date: '2026-08-10', amount: '-500' }], tag: 'pj-aug' });
      break;
    }
    case 'NEWACCT': {
      // Account A: typed 10,000 at 2026-02-28, CSV statements March–August with NO printed balances
      // (IMP-BAL-007), −500 a month. Account B opened in August: typed 2,000 at 2026-07-31, August +100.
      // Truth: A Mar 9,500 … Aug 7,000; B Aug 2,100; total Aug 9,100.
      const a = bankAccount(org, '10000', '2026-02-28', 'Main');
      for (const ym of ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']) {
        imp007(statement(org, a, { ...month(ym), moves: [{ date: `${ym}-10`, amount: '-500' }], tag: `na-${ym}` }));
      }
      const b = bankAccount(org, '2000', '2026-07-31', 'Savings');
      imp007(statement(org, b, { ...month('2026-08'), moves: [{ date: '2026-08-12', amount: '100' }], tag: 'na-b-aug' }));
      break;
    }
    case 'BSLIST': {
      // Monthly cumulative balance sheets June–August state receivables 3,000 at each month end. ONE sales list,
      // declared 1 June – 3 August and committed 3 August (mid-month), shows X-1 5,000 open (it was paid 20 Aug —
      // the list could not know). No later list. Truth at 31 Aug: 3,000 (the balance sheet).
      for (const ym of ['2026-06', '2026-07', '2026-08']) {
        balanceBatch(org, { importType: 'balance_sheet', basis: 'cumulative', ...month(ym), tag: `bl-${ym}`,
          rows: [['receivables', '3000'], ['payables', '-1000']] });
      }
      const c = counterparty(org, 'BsList Ltd', 'customer');
      invoiceBatch(org, { importType: 'sales_invoices', start: '2026-06-01', end: '2026-08-03', listKind: 'full', committedAt: '2026-08-03T12:00:00Z', tag: 'bl-s',
        invoices: [{ type: 'sales', party: c, number: 'X-1', issue: '2026-07-10', due: '2026-08-09', subtotal: '5000', tax: '0', total: '5000', paid: '0', paidDate: null, status: 'open' }] });
      break;
    }
    case 'LEDGER3': {
      // Two GL exports split MID-MONTH: A 1 Jun – 14 Jul (opening journal 1 Jun), B 15 Jul – 31 Aug with an
      // IMP-GL-011 export-start opening journal dated 15 Jul restating receivables at 7,000 (which already
      // includes A's 5 July sale). Truth: Jun 6,000 · Jul 7,000 · Aug 5,000.
      glBatch(org, { start: '2026-06-01', end: '2026-07-14', tag: 'l3-a', lines: [
        { date: '2026-06-01', category: 'receivables', direction: 'debit', amount: '5000', opening: true },
        { date: '2026-06-01', category: 'equity', direction: 'credit', amount: '5000', opening: true },
        { date: '2026-06-05', category: 'receivables', direction: 'debit', amount: '1000' },
        { date: '2026-06-05', category: 'revenue', direction: 'credit', amount: '1000' },
        { date: '2026-07-05', category: 'receivables', direction: 'debit', amount: '1000' },
        { date: '2026-07-05', category: 'revenue', direction: 'credit', amount: '1000' },
      ] });
      glBatch(org, { start: '2026-07-15', end: '2026-08-31', tag: 'l3-b', lines: [
        { date: '2026-07-15', category: 'receivables', direction: 'debit', amount: '7000', opening: true },
        { date: '2026-07-15', category: 'equity', direction: 'credit', amount: '7000', opening: true },
        { date: '2026-08-10', category: 'cash', direction: 'debit', amount: '2000' },
        { date: '2026-08-10', category: 'receivables', direction: 'credit', amount: '2000' },
      ] });
      break;
    }
    case 'CNFUTURE': {
      // A credit note not yet due offsets an overdue invoice: Aug receivables 1,000 − 800 = 200; overdue 1,000
      // (the credit note is not past due). The alert's "share" is 1,000 / 200 = 500%.
      const c = counterparty(org, 'CnFut Ltd', 'customer');
      invoiceBatch(org, { importType: 'sales_invoices', start: '2026-06-01', end: '2026-08-31', listKind: 'full', tag: 'cnf', invoices: [
        { type: 'sales', party: c, number: 'O-1', issue: '2026-07-01', due: '2026-08-01', subtotal: '1000', tax: '0', total: '1000', paid: '0', paidDate: null, status: 'open' },
        { type: 'sales_credit_note', party: c, number: 'CN-9', issue: '2026-08-20', due: '2026-09-30', subtotal: '800', tax: '0', total: '800', paid: '0', paidDate: null, status: 'open' },
      ] });
      break;
    }
    case 'MIDTYPED': {
      // MIDSTART (audit F-2) with the one thing most accounts have: a TYPED opening balance (10,000 at 31 May).
      // S1 1–20 Jun (−4,000 on 06-10), S2 21 Jun–31 Jul (−1,000 on 06-25, +500 on 07-10), S3 Aug (+100), printed
      // openings 10,000 / 6,000 / 5,500 and S3's printed closing 5,600.
      // Truth: Jun 5,000 · Jul 5,500 · Aug 5,600.
      const bank = bankAccount(org, '10000', '2026-05-31');
      statement(org, bank, { start: '2026-06-01', end: '2026-06-20', opening: '10000', closing: '6000', moves: [{ date: '2026-06-10', amount: '-4000' }], tag: 'mt-s1' });
      statement(org, bank, { start: '2026-06-21', end: '2026-07-31', opening: '6000', closing: '5500', moves: [{ date: '2026-06-25', amount: '-1000' }, { date: '2026-07-10', amount: '500' }], tag: 'mt-s2' });
      statement(org, bank, { ...month('2026-08'), opening: '5500', closing: '5600', moves: [{ date: '2026-08-10', amount: '100' }], tag: 'mt-s3' });
      break;
    }
    case 'CYCLE': {
      // A bank whose statements run 5th → 4th (typed 10,000 at 30 April); −1,000 on the 10th of every month.
      // Truth: May 9,000 · Jun 8,000 · Jul 7,000 · Aug 6,000.
      const bank = bankAccount(org, '10000', '2026-04-30');
      const cycles: Array<[string, string, string]> = [['2026-05-05', '2026-06-04', '2026-05-10'], ['2026-06-05', '2026-07-04', '2026-06-10'],
        ['2026-07-05', '2026-08-04', '2026-07-10'], ['2026-08-05', '2026-09-04', '2026-08-10']];
      let bal = 10000;
      for (const [start, end, d] of cycles) {
        statement(org, bank, { start, end, opening: String(bal), closing: String(bal - 1000), moves: [{ date: d, amount: '-1000' }], tag: `cy-${start}` });
        bal -= 1000;
      }
      break;
    }
    case 'UNRECON': {
      // June statement uploaded twice: first without balances (IMP-BAL-007, no rows kept), then re-uploaded
      // with printed balances that reconcile. July and August clean. Only the superseded upload was unreconciled.
      const bank = bankAccount(org, '1000', '2026-05-31');
      imp007(statement(org, bank, { ...month('2026-06'), committedAt: '2026-07-02T09:00:00Z', moves: [], tag: 'ur-jun-1' }));
      statement(org, bank, { ...month('2026-06'), committedAt: '2026-07-03T09:00:00Z', opening: '1000', closing: '900', moves: [{ date: '2026-06-10', amount: '-100' }], tag: 'ur-jun-2' });
      statement(org, bank, { ...month('2026-07'), opening: '900', closing: '800', moves: [{ date: '2026-07-10', amount: '-100' }], tag: 'ur-jul' });
      statement(org, bank, { ...month('2026-08'), opening: '800', closing: '700', moves: [{ date: '2026-08-10', amount: '-100' }], tag: 'ur-aug' });
      break;
    }
  }
}
