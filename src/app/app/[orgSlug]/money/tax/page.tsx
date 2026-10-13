import Link from 'next/link';
import { CalendarClock, Landmark, Receipt, Scale } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { formatMoney, formatPercent } from '@/core/money';
import { loadCorporationTaxView, loadVatView, type CorporationTaxView, type VatView } from '@/modules/tax';
import { Banner, Card, CardBody, CardHeader, DetailList, PageHeader } from '@/components/ui/surfaces';
import { TOUCH_TARGET } from '@/components/ui/clickable-card';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/shadcn';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Tax (ADR-156; owner, 2026-10-07): the indicative VAT return for a quarter and the Corporation Tax
 * estimate for the financial year, under the organisation's country's rules (UK or UAE).
 *
 * Both are built from the business's own records — invoices for VAT, MOTION's calculated profit for
 * Corporation Tax — and both say plainly that they are indicative: the business files its returns;
 * MOTION does not, and nothing here is advice.
 */

const SCHEME_LABEL = { standard: 'Standard (invoice basis)', cash_accounting: 'Cash accounting', flat_rate: 'Flat Rate Scheme' } as const;
const NOT_CALCULATED = {
  flat_rate: 'The Flat Rate Scheme return uses your flat-rate percentage, which APX does not hold, so it is not calculated here.',
  not_registered: 'Settings say this business is not VAT registered, so there is no VAT return.',
  country: 'APX calculates VAT returns for UK and UAE businesses. Set the country in Settings.',
} as const;

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export default async function TaxPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ quarter?: string }>;
}) {
  const { orgSlug } = await params;
  const { quarter } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'financials.view');

  const [vat, ct] = await Promise.all([loadVatView(ctx, quarter), loadCorporationTaxView(ctx)]);
  const canSet = can(ctx, 'settings.manage');

  return (
    <>
      <PageHeader
        eyebrow="Money"
        title="Tax"
        description="Your VAT return and Corporation Tax, worked out from your own records. Indicative — check before you file."
      />
      <div className="flex flex-col gap-6">
        <VatSection vat={vat} orgSlug={orgSlug} canSet={canSet} />
        <CorporationTaxSection ct={ct} orgSlug={orgSlug} canSet={canSet} />
      </div>
    </>
  );
}

function SettingsLink({ orgSlug, canSet, children }: { orgSlug: string; canSet: boolean; children: React.ReactNode }) {
  return canSet
    ? <Link href={`/app/${orgSlug}/settings`} className="text-accent underline underline-offset-2">{children}</Link>
    : <>{children}</>;
}

function VatSection({ vat, orgSlug, canSet }: { vat: VatView; orgSlug: string; canSet: boolean }) {
  const currency = vat.facts.baseCurrency;
  const isUae = vat.facts.countryCode === 'AE';
  const title = isUae ? 'VAT return (VAT201)' : 'VAT return';

  if (vat.quarters === null || vat.selected === null || vat.vatReturn === null) {
    return (
      <Card>
        <CardHeader title={title} icon={<Receipt />} />
        <CardBody>
          <p className="text-sm text-ink">
            Tell APX which months your VAT quarters end in, and the return for each quarter appears here.{' '}
            <SettingsLink orgSlug={orgSlug} canSet={canSet}>Set your VAT quarters in Settings</SettingsLink>.
          </p>
        </CardBody>
      </Card>
    );
  }

  const r = vat.vatReturn;
  return (
    <Card>
      <CardHeader
        title={title}
        description={`${vat.selected.label} · ${SCHEME_LABEL[vat.facts.vatScheme]}${isUae ? ' · UAE' : ' · UK'}`}
        icon={<Receipt />}
      />
      <CardBody className="flex flex-col gap-4">
        <nav aria-label="VAT quarters" className="flex flex-wrap gap-2 text-sm">
          {vat.quarters.map((q) => (
            <Link
              key={q.end}
              href={`/app/${orgSlug}/money/tax?quarter=${q.end}`}
              aria-current={q.end === vat.selected!.end ? 'page' : undefined}
              className={`inline-flex items-center rounded-full px-3 py-1 font-medium transition-colors ${TOUCH_TARGET} ${
                q.end === vat.selected!.end ? 'bg-accent text-on-accent' : 'bg-surface-sunken text-ink-muted hover:bg-accent-soft hover:text-accent'
              }`}
            >
              {q.label}
            </Link>
          ))}
        </nav>

        {r.kind === 'not_calculated' ? (
          <p className="text-sm text-ink">{NOT_CALCULATED[r.reason]}</p>
        ) : (
          <>
            {/* Three columns, one of them words: it wraps on a phone rather than scrolling. */}
            <Table className="min-w-0">
              <TableCaption className="sr-only">{`VAT return for ${vat.selected.label}`}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Box</TableHead>
                  <TableHead>What it is</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.boxes.map((b) => (
                  <TableRow key={`${b.box}-${b.label}`}>
                    <TableCell className="font-mono text-ink-muted">{b.box}</TableCell>
                    <TableCell>
                      <span className="text-ink">{b.label}</span>
                      {b.note ? <span className="block text-xs text-ink-muted">{b.note}</span> : null}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {b.value === null ? '—' : formatMoney(b.value, { currency, showMinorUnits: !/^\d+$/.test(b.value) })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-sm text-ink-muted">
              From {r.invoicesCounted} invoices ({r.salesInvoices} sales, {r.purchaseInvoices} purchases)
              {vat.facts.vatScheme === 'cash_accounting' ? ', by the date they were paid' : ', by the date they were issued'}.
            </p>
            {r.vatNotStated.length > 0 ? (
              <Banner tone="warn" title={`${r.vatNotStated.length} invoices do not state their VAT`}>
                Their VAT is left out of the boxes above rather than guessed; their value is counted in the sales or
                purchases total. Add the VAT amount on those invoices and the return updates.
              </Banner>
            ) : null}
          </>
        )}
        <p className="text-xs text-ink-muted">
          Indicative: APX does not file VAT returns. Check against your records before submitting
          {isUae ? ' to the Federal Tax Authority.' : ' to HMRC.'}
        </p>
      </CardBody>
    </Card>
  );
}

function CorporationTaxSection({ ct, orgSlug, canSet }: { ct: CorporationTaxView; orgSlug: string; canSet: boolean }) {
  const currency = ct.facts.baseCurrency;
  const isUae = ct.facts.countryCode === 'AE';
  const title = isUae ? 'Corporate Tax' : 'Corporation Tax';
  const money = (v: string) => formatMoney(v, { currency, showMinorUnits: true });

  if (ct.year === null || ct.profitBeforeTax === null || ct.estimate === null) {
    return (
      <Card>
        <CardHeader title={title} icon={<Landmark />} tint="pink" />
        <CardBody>
          <p className="text-sm text-ink">
            The estimate needs at least one complete month of profit in the financial year. Add your figures and it appears here.
          </p>
        </CardBody>
      </Card>
    );
  }

  const e = ct.estimate;
  return (
    <Card>
      <CardHeader
        title={title}
        description={`Financial year ${longDate(ct.year.start)} to ${longDate(ct.year.end)}`}
        icon={<Landmark />}
        tint="pink"
      />
      <CardBody className="flex flex-col gap-4">
        {ct.coveredTo !== null ? (
          <Banner tone="info" title={`Year to date: ${ct.monthsCovered} of ${ct.monthsInYear} months`}>
            The figures reach {longDate(ct.coveredTo)}. The estimate is for the profit so far, with the limits
            reduced for the shorter span; it will change as the year goes on.
          </Banner>
        ) : null}

        {e.kind === 'not_estimated' ? (
          <p className="text-sm text-ink">
            {e.reason === 'country'
              ? <>APX estimates Corporation Tax for UK and UAE businesses. <SettingsLink orgSlug={orgSlug} canSet={canSet}>Set the country in Settings</SettingsLink>.</>
              : 'This financial year began before the current rates applied, so no estimate is made.'}
          </p>
        ) : (
          <DetailList
            items={[
              { label: 'Profit before tax', value: <span className="font-mono tabular-nums">{money(e.profitBeforeTax)}</span> },
              { label: 'Tax already booked in your accounts', value: <span className="font-mono tabular-nums">{money(ct.bookedTax ?? '0')}</span> },
              { label: 'Estimated tax', value: <span className="font-mono text-lg tabular-nums text-ink">{money(e.estimatedTax)}</span> },
              { label: 'How it was worked out', value: e.band },
              ...(e.marginalRelief === null ? [] : [{ label: 'Marginal relief', value: <span className="font-mono tabular-nums">{money(e.marginalRelief)}</span> }]),
              ...(e.effectiveRate === null ? [] : [{ label: 'Effective rate', value: formatPercent(e.effectiveRate) }]),
              {
                label: isUae ? 'Threshold' : 'Limits for this period',
                value: e.thresholds.upper === null ? money(e.thresholds.lower) : `${money(e.thresholds.lower)} and ${money(e.thresholds.upper)}`,
              },
              { label: isUae ? 'Return and payment due' : 'Payment due', value: <span className="inline-flex items-center gap-1.5"><CalendarClock aria-hidden="true" className="size-4 text-accent" />{longDate(e.dueDate)}</span> },
            ]}
          />
        )}

        <p className="flex items-start gap-2 text-xs text-ink-muted">
          <Scale aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {isUae
            ? 'Indicative: on accounting profit, 9% above AED 375,000. Taxable income can differ, and Small Business Relief (revenue up to AED 3 million) is an election you make — check with your adviser.'
            : 'Indicative: on accounting profit. Taxable profit can differ (capital allowances instead of depreciation, disallowed expenses, losses brought forward). Large companies pay by quarterly instalments. Check with your accountant.'}
          {!isUae && ct.facts.ctAssociatedCompanies > 0 ? ` Limits shared with ${ct.facts.ctAssociatedCompanies} associated companies.` : ''}
        </p>
      </CardBody>
    </Card>
  );
}
