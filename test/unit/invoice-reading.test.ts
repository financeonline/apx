import { describe, expect, it } from 'vitest';
import { findAmounts, findDate, readInvoiceText } from '@/core/invoice-reading';

/** ADR-175: proposals for the invoice form, read from a PDF's text or an OCR of a photo. */

const PURCHASE = `Northern Foods Wholesale Ltd
Unit 4, Riverside Park, Leeds LS1 4AB
VAT Reg No: GB 123 4567 89
TAX INVOICE
Invoice No: NFW-20931
Invoice Date: 14/09/2026
Bill To:
Sample Catering
12 High Street
Description Qty Unit price Total
Frozen pastry 40 12.50 500.00
Packaging boxes 10 28.00 280.00
Subtotal £780.00
VAT @ 20% £156.00
Total due £936.00
Payment terms: 30 days`;

const SALES = `Sample Catering
12 High Street, York
INVOICE
Invoice # INV-1042
Date: 3rd October 2026
Due date: 2 November 2026
Invoice to: Acme Cafés Ltd
Item Amount
Catering supplies 1,250.00
Net total 1,250.00
VAT 250.00
Amount due GBP 1,500.00`;

describe('invoice reading', () => {
  it('reads a purchase invoice: supplier from the top, totals, terms', () => {
    const r = readInvoiceText(PURCHASE, { side: 'purchase', ownName: 'Sample Catering' });
    expect(r).toMatchObject({
      invoiceNumber: 'NFW-20931',
      counterparty: 'Northern Foods Wholesale Ltd',
      issueDate: '2026-09-14',
      dueDate: '2026-10-14',
      subtotal: '780.00',
      taxAmount: '156.00',
      total: '936.00',
      currency: 'GBP',
    });
    expect(r.notes).toContain('The due date is worked out from the payment terms.');
  });

  it('reads a sales invoice: the customer is the bill-to name, never the company itself', () => {
    const r = readInvoiceText(SALES, { side: 'sales', ownName: 'Sample Catering' });
    expect(r).toMatchObject({
      invoiceNumber: 'INV-1042',
      counterparty: 'Acme Cafés Ltd',
      issueDate: '2026-10-03',
      dueDate: '2026-11-02',
      subtotal: '1250.00',
      taxAmount: '250.00',
      total: '1500.00',
    });
    expect(r.notes).toEqual([]);
  });

  it('works out the missing one of net, VAT and total, and says so', () => {
    const r = readInvoiceText('Invoice number 77\nDate 01/02/2026\nTotal 120.00\nVAT 20.00', { side: 'purchase' });
    expect(r.subtotal).toBe('100.00');
    expect(r.notes).toContain('The net amount is worked out as the total minus VAT.');
  });

  it('flags figures that do not add up rather than correcting them', () => {
    const r = readInvoiceText('Invoice no 9\nSubtotal 100.00\nVAT 20.00\nTotal 125.00', { side: 'sales' });
    expect(r.total).toBe('125.00');
    expect(r.notes).toContain('Net plus VAT does not equal the total. Check all three against the invoice.');
  });

  it('leaves what it cannot find empty and lists it', () => {
    const r = readInvoiceText('Thank you for your business', { side: 'sales' });
    expect(r.invoiceNumber).toBeNull();
    expect(r.total).toBeNull();
    expect(r.notes[0]).toBe('Not found: invoice number, customer, invoice date, total. Type them in from the invoice.');
  });

  it('never takes a VAT registration line or a percentage as the VAT amount', () => {
    const r = readInvoiceText('VAT Registration 123456789\nNet 50.00\nVAT 20% 10.00\nTotal 60.00', { side: 'sales' });
    expect(r.taxAmount).toBe('10.00');
  });

  it('cuts a supplier name that OCR joined to the word INVOICE on the same line', () => {
    const r = readInvoiceText('Coastal Packaging Supplies Ltd INVOICE\n8 Harbour Road Invoice No: CPS-4471\nBill To:\nSample Catering\nTotal due £768.00',
      { side: 'purchase', ownName: 'Sample Catering' });
    expect(r.counterparty).toBe('Coastal Packaging Supplies Ltd');
  });

  it('reads UK, ISO and written dates and refuses impossible ones', () => {
    expect(findDate('on 31/12/2026')).toBe('2026-12-31');
    expect(findDate('2026-03-05')).toBe('2026-03-05');
    expect(findDate('March 5, 2026')).toBe('2026-03-05');
    expect(findDate('5 Sept 2026')).toBe('2026-09-05');
    expect(findDate('31/02/2026')).toBeNull();
    expect(findDate('12/25/2026')).toBeNull();
  });

  it('reads money with commas and symbols, and ignores percentages and bare numbers', () => {
    expect(findAmounts('Total £1,234.50 (20.00%) qty 3').map(String)).toEqual(['1234.5']);
    expect(findAmounts('Qty 2 100.00').map(String)).toEqual(['100']);
  });
});
