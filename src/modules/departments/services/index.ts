import 'server-only';
import { NotFound } from '@/core/errors';
import { formatMoney, isNegative, isPositive } from '@/core/money';
import { addDays, fixedClock, todayInTimeZone } from '@/core/periods';
import { assertCan, can } from '@/core/permissions';
import { callApi } from '@/core/db';
import { listActions } from '@/modules/actions';
import { aiQuotaStatus } from '@/modules/ai';
import { loadLastDataDate, loadPeriodSnapshots, loadPeriods, loadPeriodsWithData, type SnapshotRow } from '@/modules/dashboard';
import { hasForecast, loadForecast } from '@/modules/forecast';
import { bandLabel, loadHealthCard } from '@/modules/health';
import { listAvailable, listStoredReports, windowLabel } from '@/modules/reporting';
import type { AccessContext } from '@/modules/tenancy';
import * as repo from '../data/repository';

/**
 * The Departmental Dashboard (Agreement §4 "Business Department Overview. System Functional
 * Overview"; owner decision 2026-10-06, ADR-143).
 *
 * One tile per department of the business as MOTION sees it — finance, banking, customers, actions,
 * alerts, reports, the analyst, planning — each with its headline and a link into the section, and
 * a system overview: how fresh the data is, what is waiting, when MOTION last calculated, what runs
 * on a schedule and which modules are switched on.
 *
 * It computes nothing new. Every figure is a snapshot, count or row the section's own page reads,
 * and a tile appears only for someone who may open that section — a hidden department is absent,
 * never shown locked (RBAC §5).
 */

export type TileTone = 'good' | 'attention' | 'quiet';

export interface DepartmentTile {
  readonly key: string;
  readonly title: string;
  readonly href: string;
  readonly tone: TileTone;
  readonly headline: string;
  readonly lines: readonly string[];
}

export interface SystemOverview {
  readonly dataRefreshed: string;
  readonly lastCalculation: string;
  readonly imports: string | null;
  readonly schedule: readonly string[];
  readonly modules: readonly { readonly label: string; readonly on: boolean }[];
  readonly team: string | null;
}

export interface DepartmentsView {
  readonly tiles: readonly DepartmentTile[];
  readonly system: SystemOverview;
}

/**
 * Only the switches that actually gate something. ADR-025 declared five flags, but forecasting,
 * scenarios, commercial intelligence and reconciliation shipped ungated, so listing them as "off"
 * would describe a product that does not exist.
 */
const MODULE_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ['ai_pdf_extraction', 'Reading PDF documents with AI'],
  ['funding_readiness', 'Funding readiness'],
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function scalar(rows: readonly SnapshotRow[], key: string): SnapshotRow | null {
  return rows.find((r) => r.metricKey === key && r.dimensionType === 'none') ?? null;
}

export async function loadDepartments(ctx: AccessContext): Promise<DepartmentsView> {
  // `financials.view`: every active role, never a suspended member (ADR-044.4).
  assertCan(ctx, 'financials.view');
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();
  const db = ctx.db;
  const base = `/app/${ctx.orgSlug ?? ''}`;

  const { data: orgRow } = await db.from('organizations').select('timezone, base_currency').eq('id', orgId).maybeSingle();
  const timezone = (orgRow as { timezone?: string } | null)?.timezone ?? 'Europe/London';
  const currency = (orgRow as { base_currency?: string } | null)?.base_currency ?? 'GBP';
  const today = todayInTimeZone(fixedClock(ctx.now()), timezone);
  const money = (value: string | null) => (value === null ? '—' : formatMoney(value, { currency }));

  const [periods, withData, lastData] = await Promise.all([
    loadPeriods(db, orgId, ctx.requestId),
    loadPeriodsWithData(db, orgId, ctx.requestId),
    loadLastDataDate(db, orgId, ctx.requestId),
  ]);
  const month = periods.find((p) => p.isComplete && withData.has(p.id)) ?? null;
  const previous = month === null ? null : periods.find((p) => p.periodStart < month.periodStart && withData.has(p.id)) ?? null;
  const snapshots = month === null ? [] : await loadPeriodSnapshots(db, orgId, month.id, ctx.requestId);

  const tiles: DepartmentTile[] = [];

  // ---- Finance ----
  if (can(ctx, 'financials.view')) {
    if (month === null) {
      tiles.push({ key: 'finance', title: 'Finance', href: `${base}/money`, tone: 'quiet',
        headline: 'No complete month yet', lines: ['Add a ledger, trial balance or profit and loss report to see the month’s figures.'] });
    } else {
      const health = await loadHealthCard(db, orgId, month.id, previous?.id ?? null, ctx.requestId);
      const revenue = scalar(snapshots, 'revenue');
      const net = scalar(snapshots, 'net_profit');
      const loss = net?.value != null && isNegative(net.value);
      const weak = health?.band === 'at_risk' || health?.band === 'needs_attention';
      tiles.push({
        key: 'finance', title: 'Finance', href: `${base}/money`, tone: loss || weak ? 'attention' : 'good',
        headline: `${month.label}: revenue ${money(revenue?.value ?? null)}, net profit ${money(net?.value ?? null)}`,
        lines: [health === null || health.score === null
          ? 'No health score for this month.'
          : `Health score ${health.score} (${bandLabel(health.band) ?? 'not banded'}).`],
      });
    }
  }

  // ---- Banking ----
  if (can(ctx, 'banking.view')) {
    const facts = await repo.bankFacts(db, orgId);
    const cash = scalar(snapshots, 'closing_cash');
    const stale = facts.statementsReach === null || facts.statementsReach < addDays(today, -45);
    tiles.push({
      key: 'banking', title: 'Banking', href: `${base}/money/banking`,
      tone: facts.accounts === 0 ? 'quiet' : stale ? 'attention' : 'good',
      headline: facts.accounts === 0 ? 'No bank account added' : `${plural(facts.accounts, 'bank account')}`,
      lines: [
        facts.statementsReach === null ? 'No bank statement imported yet.' : `Statements reach ${facts.statementsReach}.`,
        ...(month === null || cash === null || cash.value === null ? [] : [`Cash at the end of ${month.label}: ${money(cash.value)}.`]),
      ],
    });
  }

  // ---- Customers ----
  if (can(ctx, 'customers.view')) {
    const owed = scalar(snapshots, 'receivables');
    const overdue = scalar(snapshots, 'receivables_overdue');
    const late = overdue?.value != null && isPositive(overdue.value);
    tiles.push({
      key: 'customers', title: 'Customers', href: `${base}/customers`, tone: owed?.value == null ? 'quiet' : late ? 'attention' : 'good',
      headline: owed?.value == null ? 'What customers owe is not known yet' : `Customers owe ${money(owed.value)}`,
      lines: overdue?.value == null ? [] : [`${money(overdue.value)} of it overdue at the end of ${month?.label ?? 'the month'}.`],
    });
  }

  // ---- Actions ----
  if (can(ctx, 'actions.view')) {
    const open = await listActions(ctx, { status: ['open', 'in_progress'] });
    const overdue = open.filter((a) => a.dueDate !== null && a.dueDate < today).length;
    const soon = open.filter((a) => a.dueDate !== null && a.dueDate >= today && a.dueDate <= addDays(today, 7)).length;
    tiles.push({
      key: 'actions', title: 'Actions', href: `${base}/actions`, tone: overdue > 0 ? 'attention' : open.length === 0 ? 'quiet' : 'good',
      headline: `${plural(open.length, 'open action')}`,
      lines: [`${overdue} overdue, ${soon} due in the next 7 days.`],
    });
  }

  // ---- Alerts ----
  if (can(ctx, 'financials.view')) {
    const counts = await repo.alertCounts(db, orgId);
    const serious = counts.critical + counts.high;
    tiles.push({
      key: 'alerts', title: 'Alerts', href: `${base}/insights`, tone: serious > 0 ? 'attention' : 'good',
      headline: serious > 0 ? `${plural(serious, 'critical or high alert')} open` : 'No critical or high alert open',
      lines: [`${counts.critical} critical, ${counts.high} high, ${counts.other} other open.`],
    });
  }

  // ---- Reports ----
  if (can(ctx, 'reports.view')) {
    const [stored, monthly] = await Promise.all([
      listStoredReports(ctx, ['daily_brief', 'weekly_intelligence']),
      listAvailable(ctx),
    ]);
    const daily = stored.find((r) => r.kind === 'daily_brief');
    const weekly = stored.find((r) => r.kind === 'weekly_intelligence');
    tiles.push({
      key: 'reports', title: 'Reports', href: `${base}/reports`, tone: daily === undefined ? 'quiet' : 'good',
      headline: daily === undefined ? 'No daily brief yet' : `Latest daily brief: ${windowLabel(daily.windowStart, daily.windowEnd)}`,
      lines: [
        weekly === undefined ? 'No weekly report yet.' : `Latest weekly report: ${windowLabel(weekly.windowStart, weekly.windowEnd)}.`,
        `${plural(monthly.length, 'monthly report')} available.`,
      ],
    });
  }

  // ---- Analyst ----
  if (can(ctx, 'ai.use')) {
    const quota = await aiQuotaStatus(ctx);
    const exhausted = quota.monthlyExhausted || (quota.remainingToday !== null && quota.remainingToday <= 0);
    tiles.push({
      key: 'analyst', title: 'AI Analyst', href: `${base}/analyst`, tone: exhausted ? 'attention' : 'good',
      headline: quota.dailyLimit === null ? `${plural(quota.usedToday, 'question')} asked today` : `${quota.usedToday} of ${quota.dailyLimit} questions used today`,
      lines: [exhausted ? 'No more questions can be asked until the allowance resets.' : 'Answers come only from your calculated figures, with evidence.'],
    });
  }

  // ---- Planning ----
  {
    const [forecast, budgets] = await Promise.all([loadForecast(ctx), can(ctx, 'financials.view') ? repo.budgetMonths(db, orgId) : Promise.resolve(null)]);
    tiles.push({
      key: 'planning', title: 'Planning', href: `${base}/forecast`, tone: hasForecast(forecast) || (budgets ?? 0) > 0 ? 'good' : 'quiet',
      headline: hasForecast(forecast) ? `Forecast worked out ${forecast.generatedAt.slice(0, 10)}` : 'No forecast worked out yet',
      lines: budgets === null ? [] : [budgets === 0 ? 'No budget imported.' : `A budget for ${plural(budgets, 'month')}.`],
    });
  }

  // ---- System ----
  const [run, features] = await Promise.all([repo.latestRun(db, orgId), repo.organisationFeatures(db, orgId)]);
  const imports = can(ctx, 'imports.review') ? await repo.importCounts(db, orgId) : null;
  let team: string | null = null;
  if (can(ctx, 'users.view')) {
    const members = await callApi<unknown[]>(db, 'org_members', { p_org: orgId }, ctx.requestId);
    team = `${plural((members ?? []).length, 'person', 'people')} in the team.`;
  }

  return {
    tiles,
    system: {
      dataRefreshed: lastData === null ? 'No data has been added yet.' : `Data last added ${lastData.slice(0, 10)}.`,
      lastCalculation: run === null
        ? 'APX has not calculated anything yet.'
        : `Last calculation ${run.status === 'succeeded' ? 'finished' : run.status} ${run.finishedAt?.slice(0, 16).replace('T', ' ') ?? ''} UTC${run.engineVersion === null ? '' : `, engine ${run.engineVersion}`}.`,
      imports: imports === null ? null : `${plural(imports.awaitingReview, 'import')} waiting for review, ${imports.failed} failed.`,
      schedule: [
        `Figures are recalculated each day shortly after midnight (${timezone}).`,
        'The Daily Executive Brief is produced shortly after midnight; the Weekly Intelligence Report early on Monday.',
        'Alerts are checked after every calculation.',
      ],
      modules: MODULE_FLAGS.map(([key, label]) => ({ label, on: features[key] === true })),
      team,
    },
  };
}
