/**
 * ADR-122 FU-12 — permanent organisations for "with only a SALES full list covering a month, the
 * invoice-basis P&L states every cost 0.00, so gross/operating/net profit = revenue and every margin
 * 100%". It is the cost-side twin of FU-1 (ADR-125), and the rule is the same: a source that does not
 * cover a period must never manufacture a financial zero for it. On the INVOICE P&L basis, the cost
 * side of month P is stated only when committed FULL PURCHASE lists establish P under FU-1's rules —
 * effective range = declared start → min(declared end, commit date); lists that meet combine; a
 * completed month needs every day covered; the current month (the run's as-of 2026-09-15 falls in
 * September) is covered TO DATE (`partial_month`). Otherwise every expense-side figure — and every
 * figure derived from one — is NULL with `no_source_covers_period`, and the supplier family states
 * nothing. Revenue, the customer family and AR/AP coverage are unchanged.
 *
 * Raw accepted records under committed batches (the shape a real commit leaves), built with the
 * audit builders; every figure the test reads comes only from a real `calculation.run` job through
 * the queue. Commit times are FIXED (`COMMITTED_AT` = 2026-09-10T10:00Z unless stated), never
 * `now()`. Every invoice is net = gross (tax 0), open and unpaid, due 30 days after issue. Periods
 * Jan 2026 – Aug 2027 are materialised explicitly, so the months asserted exist whatever the wall
 * clock says when the suite runs.
 *
 * What engine 4.0.0 stated is noted as "was": with the sales list establishing the month, every
 * expense category a purchase list did not reach was a covered 0.00 (or, with no cost-of-sales
 * supplier at all, cost of sales NULL `no_cost_of_sales_accounts` and gross profit = revenue).
 *
 *   SALESONLY    full sales list 1 Jun – 31 Aug (2,000 a month), NO purchase list
 *                  → revenue 2,000 (invoices); cost of sales, operating expenses, other/interest/tax
 *                    expense, gross/operating/net profit, every margin and contribution NULL
 *                    `no_source_covers_period`; no supplier figures (was: gross = operating = net
 *                    profit 2,000, net margin 100%, supplier "Unattributed" 0.00)
 *   BOTH         full sales list 1 Jun – 31 Aug (2,000 a month) + full purchase list 1 Jun – 31 Aug:
 *                Stock Co (cost_of_sales) 800 and Office Co (operating_expense) 300 a month
 *                  → revenue 2,000 · cost of sales 800 · gross 1,200 · opex 300 · operating 900 ·
 *                    net 900 · net margin 0.45 · contribution 1,200 (0.6); unchanged by FU-12
 *   PURCHSHORT   full sales list 1 Jun – 31 Aug (2,000 a month); full purchase list declared
 *                1 Jun – 20 Jul, committed 2026-07-20: Stock Co 800 on 06-12 and 800 on 07-10
 *                  → June costs stated (800, gross 1,200, net 1,200); July and August costs and
 *                    profit NULL (was: July 800 of a part-seen month; August 0.00)
 *   ZEROCOST     full sales list 1 Jun – 31 Aug (2,000 a month); full purchase list 1 Jun – 31 Aug
 *                with Stock Co (cost_of_sales) 800 on 06-12 and 08-12 and NO July purchase
 *                  → July cost of sales 0.00 STATED with nothing missing — a genuine zero — so
 *                    gross = net profit = 2,000 legitimately (margin 1.0)
 *   CURRENTCOST  full sales list AND full purchase list, each declared 1 Jun – 10 Sep and committed
 *                2026-09-10: sales Jun 1,000 · Jul 1,200 · Aug 1,500 · 5 Sep 700; Stock Co
 *                (cost_of_sales) Jun 400 · Jul 500 · Aug 600 · 6 Sep 200
 *                  → August whole (gross 900); September TO DATE: revenue 700, cost of sales 200,
 *                    gross 500, all `partial_month`; October NULL
 *   SUPPLIERS    full sales list 1 Jun – 31 Aug (2,000 a month, one customer); full purchase list
 *                1 Jun – 31 Jul: Anchor Supplies (cost_of_sales) Jun 600 · Jul 300, Bolt Services
 *                (operating_expense) Jun 200 · Jul 100; plus a purchase OPEN-ITEMS list declared
 *                1 – 31 Aug: Anchor 500 on 08-12, unpaid (an aged-creditors list never covers costs)
 *                  → Jun/Jul supplier top-1 share 0.75; August: no supplier spend stated, supplier
 *                    concentration NULL (was 1.0 of 500, or of 0.00), costs NULL, payables days NULL;
 *                    customer concentration still 1.0 (the customer family is unchanged)
 *   STALE        seeded like SALESONLY; the test then plants what engine 4.0.0 wrote (July net profit
 *                2,000 = revenue) and the engine-upgrade sweep recomputes it to NULL
 */
import { adminSql, clientFor, createAuthUser } from '../integration/setup';
import { counterparty, invoiceBatch, type Inv } from './audit-orgs';
import { COMMITTED_AT } from './adr120-orgs';

export const FU12_KEYS = ['SALESONLY', 'BOTH', 'PURCHSHORT', 'ZEROCOST', 'CURRENTCOST', 'SUPPLIERS', 'STALE'] as const;
export type Fu12Key = (typeof FU12_KEYS)[number];

/** Seeds the FU-12 organisations (two per owner, like the other fixtures; `create_organization` is throttled per person). */
export async function seedFu12Orgs(tag: string, keys: readonly Fu12Key[]): Promise<Partial<Record<Fu12Key, string>>> {
  const out: Partial<Record<Fu12Key, string>> = {};
  let n = 0;
  let owner = '';
  for (const key of keys) {
    if (n % 2 === 0) owner = createAuthUser(`fu12-${n}@${tag}.fu12.itest`);
    n += 1;
    const r = await clientFor(owner).schema('api').rpc('create_organization', { p_name: `FU12 ${key} ${tag}` });
    if (r.error) throw new Error(r.error.message);
    const org = r.data as unknown as string;
    out[key] = org;
    // The months the test reads, whatever month the suite happens to run in (create_organization
    // materialises twelve months either side of now(), which drifts).
    adminSql(`select app.ensure_periods('${org}', '2026-01-01', '2027-08-31')`);
    seedOne(key, org);
  }
  return out;
}

const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface Line { readonly issue: string; readonly amount: string; readonly party: string }

/** One invoice per line: net = gross (tax 0), unpaid, open, due 30 days after issue. */
function lines(type: Inv['type'], items: readonly Line[], prefix: string): Inv[] {
  if (items.length === 0) throw new Error('an invoice batch needs at least one invoice (the builder cannot write an empty VALUES list)');
  return items.map((l, i) => ({
    type, party: l.party, number: `${prefix}-${i + 1}`, issue: l.issue, due: addDays(l.issue, 30),
    subtotal: l.amount, tax: '0', total: l.amount, paid: '0', paidDate: null, status: 'open',
  }));
}

interface ListOptions {
  readonly start: string;
  readonly end: string;
  readonly committedAt?: string;
  readonly listKind?: 'full' | 'open_items';
  readonly tag: string;
  readonly items: readonly Line[];
}

/** A committed FULL SALES list over a declared range. */
function salesList(org: string, o: ListOptions): void {
  invoiceBatch(org, {
    importType: 'sales_invoices', start: o.start, end: o.end, listKind: o.listKind ?? 'full', committedAt: o.committedAt ?? COMMITTED_AT,
    tag: o.tag, invoices: lines('sales', o.items, o.tag),
  });
}

/** A committed PURCHASE list (full unless stated) over a declared range. */
function purchaseList(org: string, o: ListOptions): void {
  invoiceBatch(org, {
    importType: 'purchase_invoices', start: o.start, end: o.end, listKind: o.listKind ?? 'full', committedAt: o.committedAt ?? COMMITTED_AT,
    tag: o.tag, invoices: lines('purchase', o.items, o.tag),
  });
}

/** 2,000 of sales on the 10th of June, July and August, under one full list 1 Jun – 31 Aug. */
function summerSales(org: string, name: string, tag: string): void {
  const c = counterparty(org, name, 'customer');
  salesList(org, { start: '2026-06-01', end: '2026-08-31', tag, items: [
    { issue: '2026-06-10', amount: '2000', party: c },
    { issue: '2026-07-10', amount: '2000', party: c },
    { issue: '2026-08-10', amount: '2000', party: c },
  ] });
}

function seedOne(key: Fu12Key, org: string): void {
  switch (key) {
    case 'SALESONLY':
      summerSales(org, 'Sales Only Ltd', 'so');
      break;
    case 'STALE':
      summerSales(org, 'Stale Ltd', 'stale');
      break;
    case 'BOTH': {
      summerSales(org, 'Both Ltd', 'both-s');
      const stock = counterparty(org, 'Stock Co', 'supplier', 'cost_of_sales');
      const office = counterparty(org, 'Office Co', 'supplier', 'operating_expense');
      purchaseList(org, { start: '2026-06-01', end: '2026-08-31', tag: 'both-p', items: [
        { issue: '2026-06-12', amount: '800', party: stock },
        { issue: '2026-06-15', amount: '300', party: office },
        { issue: '2026-07-12', amount: '800', party: stock },
        { issue: '2026-07-15', amount: '300', party: office },
        { issue: '2026-08-12', amount: '800', party: stock },
        { issue: '2026-08-15', amount: '300', party: office },
      ] });
      break;
    }
    case 'PURCHSHORT': {
      summerSales(org, 'Short Ltd', 'ps-s');
      const stock = counterparty(org, 'Stock Co', 'supplier', 'cost_of_sales');
      purchaseList(org, { start: '2026-06-01', end: '2026-07-20', committedAt: '2026-07-20T12:00:00Z', tag: 'ps-p', items: [
        { issue: '2026-06-12', amount: '800', party: stock },
        { issue: '2026-07-10', amount: '800', party: stock },
      ] });
      break;
    }
    case 'ZEROCOST': {
      summerSales(org, 'Zero Cost Ltd', 'zc-s');
      const stock = counterparty(org, 'Stock Co', 'supplier', 'cost_of_sales');
      purchaseList(org, { start: '2026-06-01', end: '2026-08-31', tag: 'zc-p', items: [
        { issue: '2026-06-12', amount: '800', party: stock },
        { issue: '2026-08-12', amount: '800', party: stock },
      ] });
      break;
    }
    case 'CURRENTCOST': {
      const c = counterparty(org, 'Current Cost Ltd', 'customer');
      salesList(org, { start: '2026-06-01', end: '2026-09-10', committedAt: '2026-09-10T10:00:00Z', tag: 'cc-s', items: [
        { issue: '2026-06-10', amount: '1000', party: c },
        { issue: '2026-07-10', amount: '1200', party: c },
        { issue: '2026-08-10', amount: '1500', party: c },
        { issue: '2026-09-05', amount: '700', party: c },
      ] });
      const stock = counterparty(org, 'Stock Co', 'supplier', 'cost_of_sales');
      purchaseList(org, { start: '2026-06-01', end: '2026-09-10', committedAt: '2026-09-10T10:00:00Z', tag: 'cc-p', items: [
        { issue: '2026-06-12', amount: '400', party: stock },
        { issue: '2026-07-12', amount: '500', party: stock },
        { issue: '2026-08-12', amount: '600', party: stock },
        { issue: '2026-09-06', amount: '200', party: stock },
      ] });
      break;
    }
    case 'SUPPLIERS': {
      summerSales(org, 'Supplied Ltd', 'sup-s');
      const anchor = counterparty(org, 'Anchor Supplies', 'supplier', 'cost_of_sales');
      const bolt = counterparty(org, 'Bolt Services', 'supplier', 'operating_expense');
      purchaseList(org, { start: '2026-06-01', end: '2026-07-31', tag: 'sup-p', items: [
        { issue: '2026-06-12', amount: '600', party: anchor },
        { issue: '2026-06-15', amount: '200', party: bolt },
        { issue: '2026-07-12', amount: '300', party: anchor },
        { issue: '2026-07-15', amount: '100', party: bolt },
      ] });
      // An aged-creditors list as at 31 August: it says what is owed, never what August cost.
      purchaseList(org, { start: '2026-08-01', end: '2026-08-31', listKind: 'open_items', tag: 'sup-oi', items: [
        { issue: '2026-08-12', amount: '500', party: anchor },
      ] });
      break;
    }
  }
}
