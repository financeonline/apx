# Run from this folder: python3 generate.py  (writes the CSVs into ./files)
import os; os.makedirs('files', exist_ok=True); os.chdir('files')
# Synthetic sample business for MOTION local testing. Every name and figure is invented.
import calendar, datetime as dt, random
random.seed(42)
MONTHS = [(2026, m) for m in range(1, 10)]          # Jan–Sep 2026, all complete
CUSTOMERS = [('Acme Cafés Ltd', 0.34), ('Beta Hotels', 0.22), ('Gamma Catering', 0.18), ('Delta Offices', 0.15), ('Epsilon Events', 0.11)]
SUPPLIERS = ['Northern Foods Wholesale', 'PackRight Supplies']
base = 42000.0
gl = ['Date,Account,Description,Debit,Credit']
sales = ['Invoice Number,Customer,Invoice Date,Due Date,Total,Amount Paid,Paid Date,Status']
purch = ['Invoice Number,Supplier,Invoice Date,Due Date,Total,Amount Paid,Paid Date,Status']
bank = []          # (date, description, out, in)
budget = ['Month,Account,Budget']
inv_no, bill_no = 1001, 501
end = lambda y, m: dt.date(y, m, calendar.monthrange(y, m)[1])
TODAY = dt.date(2026, 10, 6)
for i, (y, m) in enumerate(MONTHS):
    revenue = round(base * (1.03 ** i) * random.uniform(0.97, 1.03), 2)
    budget += [f'{y}-{m:02d},Revenue,{round(base * (1.035 ** i), 2):.2f}', f'{y}-{m:02d},Cost of Sales,{round(base * (1.035 ** i) * 0.44, 2):.2f}',
               f'{y}-{m:02d},Payroll,{11500 if m < 7 else 12500:.2f}', f'{y}-{m:02d},Marketing,2000.00', f'{y}-{m:02d},Operating Expenses,3200.00']
    for name, share in CUSTOMERS:
        amount = round(revenue * share, 2)
        issue = dt.date(y, m, min(5 + CUSTOMERS.index((name, share)) * 4, 26))
        due = issue + dt.timedelta(days=30)
        # Most pay in 25–45 days; Delta pays slowly; the last two months are partly still open.
        delay = random.randint(25, 45) + (35 if name == 'Delta Offices' else 0)
        paid = issue + dt.timedelta(days=delay)
        if paid > end(2026, 9):
            sales.append(f'INV-{inv_no},{name},{issue},{due},{amount:.2f},0.00,,Unpaid')
        else:
            sales.append(f'INV-{inv_no},{name},{issue},{due},{amount:.2f},{amount:.2f},{paid},Paid')
            bank.append((paid, f'FPS CREDIT {name.upper()} INV-{inv_no}', 0.0, amount))
        gl.append(f'{issue},Revenue,Invoice INV-{inv_no} {name},,{amount:.2f}')
        inv_no += 1
    cos = round(revenue * random.uniform(0.43, 0.47), 2)
    for k, sup in enumerate(SUPPLIERS):
        amount = round(cos * (0.7 if k == 0 else 0.3), 2)
        issue = dt.date(y, m, 8 + k * 6)
        due = issue + dt.timedelta(days=30)
        paid = issue + dt.timedelta(days=28)
        if paid > end(2026, 9):
            purch.append(f'BILL-{bill_no},{sup},{issue},{due},{amount:.2f},0.00,,Awaiting payment')
        else:
            purch.append(f'BILL-{bill_no},{sup},{issue},{due},{amount:.2f},{amount:.2f},{paid},Paid')
            bank.append((paid, f'{sup.upper()} BILL-{bill_no}', amount, 0.0))
        gl.append(f'{issue},Cost of Sales,Bill BILL-{bill_no} {sup},{amount:.2f},')
        bill_no += 1
    payroll = 11500.0 if m < 7 else 12500.0
    marketing = round(random.uniform(1500, 2600), 2)
    for date, account, desc, amt, bank_desc in [
        (dt.date(y, m, 1), 'Operating Expenses', 'Warehouse rent', 2500.0, 'RENT WAREHOUSE LTD'),
        (dt.date(y, m, 12), 'Operating Expenses', 'Utilities', round(random.uniform(520, 680), 2), 'ENERGY CO DD'),
        (dt.date(y, m, 15), 'Marketing', 'Online advertising', marketing, 'ADS PLATFORM'),
        (end(y, m), 'Payroll', f'{calendar.month_name[m]} salaries', payroll, f'PAYROLL {calendar.month_abbr[m].upper()}'),
        (end(y, m), 'Interest Expense', 'Business loan interest', round(150 - i * 8, 2), 'LOAN INTEREST'),
    ]:
        gl.append(f'{date},{account},{desc},{amt:.2f},')
        bank.append((date, bank_desc, amt, 0.0))
    bank.append((end(y, m), 'LOAN REPAYMENT', 2000.0, 0.0))   # capital: not an expense
# Bank statement Jan–Sep with a running balance from 18,000.00.
bank.sort(key=lambda t: (t[0], t[1]))
bal = 18000.0
rows = ['Date,Description,Paid Out,Paid In,Balance']
for d, desc, out, inn in bank:
    bal = round(bal - out + inn, 2)
    rows.append(f'{d},{desc},{f"{out:.2f}" if out else ""},{f"{inn:.2f}" if inn else ""},{bal:.2f}')
closing = bal
open('gl.csv', 'w').write('\n'.join(gl) + '\n')
open('sales_invoices.csv', 'w').write('\n'.join(sales) + '\n')
open('purchase_invoices.csv', 'w').write('\n'.join(purch) + '\n')
open('bank.csv', 'w').write('\n'.join(rows) + '\n')
open('budget.csv', 'w').write('\n'.join(budget) + '\n')
# Balance sheets at 30 June and 30 September: the loan falls by 2,000.00 a month from 40,000.00.
def bs(month, cash, loan):
    open_ar = 0.0; open_ap = 0.0
    asof = end(2026, month)
    for line in sales[1:]:
        p = line.split(','); issue = dt.date.fromisoformat(p[2]); paid = p[6]
        if issue <= asof and (not paid or dt.date.fromisoformat(paid) > asof): open_ar += float(p[4])
    for line in purch[1:]:
        p = line.split(','); issue = dt.date.fromisoformat(p[2]); paid = p[6]
        if issue <= asof and (not paid or dt.date.fromisoformat(paid) > asof): open_ap += float(p[4])
    equity = round(cash + open_ar + 25000.0 - open_ap - loan, 2)
    return ['Account,Balance', f'Cash,{cash:.2f}', f'Accounts Receivable,{open_ar:.2f}', f'Fixed Assets,25000.00',
            f'Accounts Payable,{-open_ap:.2f}', f'Loans,{-loan:.2f}', f'Equity,{-equity:.2f}']
june_cash = 18000.0
for d, desc, out, inn in bank:
    if d <= dt.date(2026, 6, 30): june_cash = round(june_cash - out + inn, 2)
open('balance_sheet_jun.csv', 'w').write('\n'.join(bs(6, june_cash, 40000 - 2000 * 6)) + '\n')
open('balance_sheet_sep.csv', 'w').write('\n'.join(bs(9, closing, 40000 - 2000 * 9)) + '\n')
# Company b: a small second client for the Command Centre — three months, thin margins.
glb = ['Date,Account,Description,Debit,Credit']
for m in (7, 8, 9):
    rev = 18000 + m * 900
    glb += [f'2026-{m:02d}-10,Revenue,Sales,,{rev:.2f}', f'2026-{m:02d}-12,Cost of Sales,Stock,{rev * 0.62:.2f},',
            f'2026-{m:02d}-28,Payroll,Salaries,{rev * 0.3:.2f},', f'{end(2026, m)},Operating Expenses,Rent and bills,{1900:.2f},']
open('gl_b.csv', 'w').write('\n'.join(glb) + '\n')
print('lines', len(gl) - 1, len(sales) - 1, len(purch) - 1, len(rows) - 1, 'closing cash', closing)
