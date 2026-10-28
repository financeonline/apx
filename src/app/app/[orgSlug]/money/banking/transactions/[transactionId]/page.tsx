import Link from 'next/link';
import { ArrowLeftRight, FileSearch, Receipt, Tags } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody, Badge, DetailList } from '@/components/ui/surfaces';
import { formatDate } from '@/components/labels';
import { loadBankTransactionDetail, type ReconciliationStatus } from '@/modules/dashboard';
import { requirePermission } from '@/app/_lib/authz';
import { CategoryForm, TransferControls } from './transaction-controls';

export const dynamic = 'force-dynamic';

/**
 * One statement line (Phase 13 brief §22). Date, description, amount and direction, account,
 * category and who set it, transfer state, whether it still counts, the balance printed beside it,
 * the reconciliation of the statement it came from — and a way to the source. No ids on screen.
 *
 * Edits (category, transfer pairing) appear only for `banking.reconcile`; the source document only
 * for `documents.view` — through the record page, which mints the signed URL after an audit event
 * (SECURITY_MODEL.md §7). An id from another organisation is the same 404 as a wrong one (§8.4).
 */
const RECONCILIATION_TONE: Readonly<Record<ReconciliationStatus, 'neutral' | 'accent' | 'warn' | 'danger'>> = {
  reconciled: 'accent', unreconciled: 'danger', balances_missing: 'warn', no_statement: 'neutral',
};

export default async function BankTransactionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; transactionId: string }>;
}) {
  const { orgSlug, transactionId } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'banking.view');
  if (!/^[0-9a-f-]{36}$/i.test(transactionId)) notFound();

  const view = await loadBankTransactionDetail(ctx.db, ctx.orgId!, orgSlug, transactionId, ctx.requestId);
  if (!view) notFound();
  const mayEdit = can(ctx, 'banking.reconcile');
  const maySeeDocuments = can(ctx, 'documents.view');
  const recordHref = `/app/${orgSlug}/evidence/record/bank/${view.id}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={view.direction === 'in' ? 'Money in' : 'Money out'}
        title={view.description}
        description={`${formatDate(view.date)} · ${view.account.name}${view.periodLabel ? ` · ${view.periodLabel}` : ''}`}
        action={<Link href={`/app/${orgSlug}/money/banking/transactions?period=${view.periodId}&account=${view.account.id}`} className="text-sm text-ink-muted hover:text-ink">Back to transactions</Link>}
      />

      <Card>
        <CardHeader title="This transaction" icon={<Receipt />} />
        <CardBody>
          <p className="font-mono text-2xl tabular-nums text-ink" data-testid="txn-amount">{view.amount}</p>
          <div className="mt-4">
            <DetailList items={[
              { label: 'Date', value: formatDate(view.date) + (view.postedDate && view.postedDate !== view.date ? ` (posted ${formatDate(view.postedDate)})` : '') },
              { label: 'Description', value: view.description },
              ...(view.reference ? [{ label: 'Reference', value: view.reference }] : []),
              { label: 'Money in or out', value: view.direction === 'in' ? 'Money in' : 'Money out' },
              { label: 'Account', value: `${view.account.name} · ${view.account.reference} · ${view.account.typeLabel}` },
              { label: 'Category', value: <span>{view.category.uncategorised ? <Badge tone="warn">{view.category.label}</Badge> : view.category.label} <span className="text-ink-muted">· {view.category.sourceLabel}</span></span> },
              ...(view.transfer ? [{ label: 'Transfer', value: <span>{view.transfer.label}{view.transfer.pairHref ? <> · <Link href={view.transfer.pairHref} className="underline">see the other half</Link></> : null}</span> }] : []),
              ...(view.recurring ? [{ label: 'Regular payment', value: <Link href={view.recurring.href} className="underline">Part of a payment APX sees regularly</Link> }] : []),
              { label: 'Balance on the statement after this line', value: view.statementBalance ? <span className="tabular">{view.statementBalance}</span> : <span className="text-ink-muted">Not on the statement</span> },
              { label: 'In your figures?', value: <span><Badge tone={view.standing.counted ? 'accent' : 'warn'}>{view.standing.label}</Badge> <span className="text-ink-muted">· {view.standing.assurance === 'verified' ? 'Read straight from the statement' : view.standing.assurance === 'calculated' ? 'Read from the statement’s text and checked' : view.standing.assurance === 'inferred' ? 'Read by AI and confirmed page by page' : 'Estimated'}</span></span> },
              { label: 'Does the statement add up?', value: <span><Badge tone={RECONCILIATION_TONE[view.reconciliation.status]}>{view.reconciliation.label}</Badge> <span className="text-ink-muted">· {view.reconciliation.sentence}</span></span> },
            ]} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Source" description={view.source} icon={<FileSearch />} tint="pink" />
        <CardBody>
          <p className="text-sm">
            <Link href={recordHref} className="underline">Where this line came from</Link>
            <span className="text-ink-muted"> — the upload it arrived in, the line in the file{maySeeDocuments ? ', and the statement itself' : ''}.</span>
          </p>
          {!maySeeDocuments ? <p className="mt-2 text-xs text-ink-faint">Your role can see what the figures rest on but not the uploaded file itself.</p> : null}
        </CardBody>
      </Card>

      {mayEdit ? (
        <>
          <Card>
            <CardHeader title="Change the category" description="Changing it here changes your figures; APX’s rules never overwrite your choice." icon={<Tags />} />
            <CardBody><CategoryForm orgSlug={orgSlug} transactionId={view.id} current={view.category.accountId} options={view.categoryOptions} /></CardBody>
          </Card>
          <Card>
            <CardHeader title={view.transfer ? 'Marked as a transfer' : 'Is this a transfer between your own accounts?'} description="Money moved between your own accounts is left out of your cash figures. Card and loan repayments stay in." icon={<ArrowLeftRight />} tint="pink" />
            <CardBody><TransferControls orgSlug={orgSlug} transactionId={view.id} isTransfer={view.transfer !== null} candidates={view.transferCandidates} /></CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}
