import 'server-only';
import { reviewsAsAnalyst } from './reviewer';
import { NotFound } from '@/core/errors';
import { Decimal } from '@/core/money';
import { can, isPlatformStaff } from '@/core/permissions';
import { listActions, type Action } from '@/modules/actions';
import { loadMetricSeries, loadOrganizationFacts, type PeriodLabel } from '@/modules/dashboard';
import {
  annualComparison, comparativeYears, growthBaselines, keyIndicators, loadAnnualFacts, marketingWindow, type AnnualFacts,
} from '@/modules/marketing';
import { loadTaxDates, type TaxDates } from '@/modules/tax';
import { canManageTargets } from '@/modules/targets';
import { ROLE_NAMES, moduleOn, type AccessContext } from '@/modules/tenancy';
import * as basicsRepo from '../../data/repository';
import * as repo from '../../data/dashboard-repository';
import { dayLabel } from '../../domain/dashboard-ops';
import { minusEach, valuesFor } from '../../domain/dashboard-money';
import {
  comparativePanel, complianceChecks, financeLine, firstName, greeting, growthView, keyIndicatorsPanel, lastLoginLabel,
  marketingPanel, workflowPanel, type ReadinessFacts,
} from '../../domain/dashboard-extras';
import type { DashboardExtras, MonthWindow, TargetActuals } from '../../domain/dashboard';
import { seriesMap } from './analysis';

/**
 * The panels below the department view (ADR-180), shared by every department: the masthead
 * (company, greeting, identity, last login), the year figures (Key Report Indicators, How can I
 * Grow?, Comparative Financials — `modules/marketing`'s annual totals), Marketing vs Revenue over the
 * window, Compliance View, the workflow infographic, the monthly targets' actuals, the templates'
 * finance line, and what the reader may do.
 *
 * Every count is read under the reader's own permissions; a panel whose source the reader may not
 * read says so (or is left out) rather than showing a zero it never counted.
 */

/** Company roles' names (`ROLE_NAMES`), and the two effective roles that are not roles a person holds. */
const ROLE_FALLBACK: Readonly<Record<string, string>> = { suspended_member: 'Read only', none: 'No access' };

const monthOf = (iso: string | null) => (iso === null ? null : iso.slice(0, 7));

function filingsText(tax: TaxDates | null): string | null {
  if (tax === null) return null;
  const parts: string[] = [];
  if (tax.vatRegistered === false) parts.push('Not VAT registered');
  else if (tax.lastVatQuarter !== null) parts.push(`VAT quarter ${tax.lastVatQuarter.label} ended ${dayLabel(tax.lastVatQuarter.end)}`);
  if (tax.corporationTax !== null) {
    parts.push(`Corporation Tax for the year to ${dayLabel(tax.corporationTax.yearEnd)} due ${dayLabel(tax.corporationTax.dueDate)}`);
  }
  return parts.length === 0 ? null : `${parts.join('; ')} — dates only; no filing has been checked`;
}

export async function loadDashboardExtras(
  ctx: AccessContext, window: MonthWindow, options: { readonly periods?: readonly PeriodLabel[] } = {},
): Promise<DashboardExtras> {
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();
  const db = ctx.db;
  const base = `/app/${ctx.orgSlug ?? ''}`;
  const currency = window.currency;
  const recent = window.recent ?? window.months;
  const anchor = window.months.at(-1) ?? recent.at(-1) ?? null;
  const seesActions = can(ctx, 'actions.view');
  const seesTax = can(ctx, 'financials.view') && moduleOn(ctx, 'tax');
  const ids = [...new Set([...window.months, ...recent].map((m) => m.periodId))];

  const [org, basics, profile, signedIn, facts, series, actions, batches, tax] = await Promise.all([
    loadOrganizationFacts(db, orgId),
    basicsRepo.organisationBasics(db, orgId),
    repo.myProfile(db, ctx.requestId),
    repo.previousSignIn(db, ctx.requestId),
    loadAnnualFacts(db, orgId, { periods: options.periods, requestId: ctx.requestId }),
    loadMetricSeries(db, orgId, ['revenue', 'operating_profit'], ids, ctx.requestId),
    seesActions ? listActions(ctx) : Promise.resolve(null as readonly Action[] | null),
    repo.batchFacts(db, orgId),
    seesTax ? loadTaxDates(ctx) : Promise.resolve(null),
  ]);

  // ---- The masthead ----
  const staff = isPlatformStaff(ctx);
  const name = profile.fullName?.trim() || profile.email || 'Your account';
  const identity = {
    name,
    role: (ROLE_NAMES as Readonly<Record<string, string>>)[ctx.effectiveRole] ?? ROLE_FALLBACK[ctx.effectiveRole] ?? 'Member',
    isAnalyst: reviewsAsAnalyst(ctx),
    lastLogin: lastLoginLabel(signedIn, profile.timezone ?? basics.timezone),
  };

  // ---- The window's figures (finance line, targets) ----
  const byKey = seriesMap(series);
  const of = (key: string, periodIds: readonly string[]) => valuesFor(byKey.get(key) ?? new Map(), periodIds);
  const sum = (values: readonly (Decimal | null)[]) => (values.some((v) => v !== null)
    ? values.reduce<Decimal>((a, v) => (v === null ? a : a.plus(v)), new Decimal(0)) : null);
  const windowIds = window.months.map((m) => m.periodId);
  const revenue = sum(of('revenue', windowIds));
  const profit = sum(of('operating_profit', windowIds));

  // ---- The year panels ----
  const comparison = facts === null ? null : annualComparison(facts);
  const annualCurrency = facts?.currency ?? currency;

  // ---- Actions ----
  const windowKeys = new Set(window.months.map((m) => m.periodStart.slice(0, 7)));
  const live = actions?.filter((a) => a.status !== 'dismissed') ?? null;
  const createdInWindow = live?.filter((a) => windowKeys.has(a.createdAt.slice(0, 7))) ?? [];
  const readiness: ReadinessFacts = {
    batches,
    actions: live === null ? null : {
      open: live.filter((a) => a.status === 'open' || a.status === 'in_progress').length,
      total: live.length,
      windowTotal: createdInWindow.length,
      windowCompleted: createdInWindow.filter((a) => a.status === 'completed').length,
    },
    filings: filingsText(tax),
    // A monthly report is available for every complete month with figures (`listAvailable`): the
    // window ends on a month with figures, so it is ready exactly when that month is complete.
    reportReady: anchor !== null && anchor.isComplete && can(ctx, 'reports.view') && moduleOn(ctx, 'reports'),
  };

  // ---- Monthly targets: the recent months' actuals ----
  const recentIds = recent.map((m) => m.periodId);
  const recentRevenue = of('revenue', recentIds);
  const recentCosts = minusEach(recentRevenue, of('operating_profit', recentIds));
  const history: TargetActuals[] = recent.map((m, i) => {
    const marketing = facts?.categorySpend.find((r) => r.periodId === m.periodId && r.category === 'marketing') ?? null;
    const key = m.periodStart.slice(0, 7);
    return {
      month: key,
      label: m.label,
      sales: recentRevenue[i]?.toFixed(2) ?? null,
      costs: recentCosts[i]?.toFixed(2) ?? null,
      marketing: marketing?.value == null ? null : new Decimal(marketing.value).toFixed(2),
      workflowCompleted: live === null ? null
        : live.filter((a) => a.status === 'completed' && monthOf(a.completedAt) === key).length,
    };
  });

  const analyst = can(ctx, 'ai.use') && moduleOn(ctx, 'analyst');
  return {
    companyName: org?.name ?? 'Your company',
    companyLine: `${anchor?.longLabel ?? ''} · ${currency}`.replace(/^ · /, ''),
    greeting: greeting(firstName(profile.fullName, profile.email), staff),
    identity,
    keyIndicators: comparison === null ? null : keyIndicatorsPanel(keyIndicators(comparison)),
    growth: comparison === null ? [] : growthView(growthBaselines(comparison), annualCurrency),
    comparative: comparison === null ? null : comparativePanel(comparativeYears(comparison), annualCurrency),
    marketing: facts === null ? null : marketingPanel(marketingWindowFor(facts, window), annualCurrency),
    compliance: complianceChecks(readiness),
    workflow: workflowPanel(readiness),
    targets: { history, defaultMonth: anchor?.periodStart.slice(0, 7) ?? '', canSave: canManageTargets(ctx) },
    financeLine: financeLine(window.snapshotLabel, window.periodCaption, revenue, profit, currency),
    can: {
      requestReview: seesActions,
      markReviewed: reviewsAsAnalyst(ctx),
      completeTasks: can(ctx, 'actions.update_own'),
      recordClientReview: seesActions && can(ctx, 'customers.view'),
      askAnalyst: analyst,
      openWhatIf: can(ctx, 'financials.view') && moduleOn(ctx, 'planning'),
      openReports: can(ctx, 'reports.view') && moduleOn(ctx, 'reports'),
      openImports: can(ctx, 'imports.review'),
      openBanking: can(ctx, 'financials.view') && moduleOn(ctx, 'banking'),
    },
    links: {
      analyst: `${base}/analyst`, whatIf: `${base}/what-if`, reports: `${base}/reports`, imports: `${base}/data/imports`,
      actions: `${base}/actions`, insights: `${base}/insights`, customers: `${base}/customers`, money: `${base}/money`,
    },
  };
}

function marketingWindowFor(facts: AnnualFacts, window: MonthWindow) {
  return marketingWindow(facts, window.months.map((m) => ({ periodId: m.periodId, label: m.label })), window.periodCaption);
}
