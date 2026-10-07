import Link from 'next/link';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { hasForecast, loadForecast } from '@/modules/forecast';
import {
  ASSUMPTION_NOTE, ASSUMPTION_QUESTION, CASH_EFFECT_LABEL, CASH_ONLY_KINDS,
  DEFAULT_CASH_EFFECT, checkAffordability, hasScenario, listScenarios, loadScenario, parseWrittenAmount,
  type AffordabilityCheck,
} from '@/modules/scenarios';
import { Bookmark, FlaskConical, SlidersHorizontal } from 'lucide-react';
import { Card, CardBody, CardHeader, EmptyState, IconBadge, PageHeader } from '@/components/ui/surfaces';
import { requirePermission } from '@/app/_lib/authz';
import { ScenarioComparison } from './comparison';
import { ScenarioForm } from './scenario-form';
import { ArchiveControl } from './archive-control';
import { AffordabilityCard } from './affordability';

export const dynamic = 'force-dynamic';

/**
 * What-if (REQ-SC-01…10; ADR-100).
 *
 * One question, asked plainly: what would you like to change? Then one answer, in the same six
 * figures Home and the forecast already use, with the assumptions printed beneath it.
 *
 * **A scenario needs a forecast**, because a comparison needs something to compare against. An
 * organisation without one is told so and sent to the page that makes one, rather than being shown
 * an empty form that would fail at the end.
 *
 * Nothing here computes. Every figure is a `scenario_values` row the deterministic engine produced
 * from the deterministic forecast, and every assumption beside it is one somebody typed.
 */
export default async function WhatIfPage({
  params, searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ afford_amount?: string; afford_recurrence?: string; afford_start?: string }>;
}) {
  const { orgSlug } = await params;
  const query = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'dashboard.view');

  const [forecast, latest, saved] = await Promise.all([
    loadForecast(ctx),
    loadScenario(ctx),
    listScenarios(ctx),
  ]);
  const mayRun = can(ctx, 'intelligence.recompute');

  if (!hasForecast(forecast) || forecast.periods.length === 0) {
    return (
      <>
        <PageHeader eyebrow="What if" title="What if things change?" />
        <EmptyState
          title="There is nothing to compare against yet"
          actionHref={`/app/${orgSlug}/forecast`}
          actionLabel="Go to the forecast"
        >
          A what-if works by changing what MOTION already expects, so it needs a forecast first. Work
          one out and this page will be ready.
        </EmptyState>
      </>
    );
  }

  const months = forecast.periods.map((period, index) => ({
    value: index + 1,
    label: period.periodLabel,
  }));

  // "Can we afford it?" (ADR-146): worked out when asked, from the address, and never saved.
  const asked = typeof query.afford_amount === 'string' && query.afford_amount.trim() !== ''
    ? {
      amount: query.afford_amount.slice(0, 40),
      recurrence: query.afford_recurrence === 'monthly' ? 'monthly' as const : 'one_off' as const,
      start: Math.max(1, Number.parseInt(query.afford_start ?? '1', 10) || 1),
    }
    : null;
  const amount = asked === null ? null : parseWrittenAmount(asked.amount);
  const affordability: AffordabilityCheck | 'unreadable' | null = asked === null ? null
    : amount === null ? 'unreadable'
      : await checkAffordability(ctx, { amount, recurrence: asked.recurrence, startsInMonth: asked.start });

  /*
   * The order the questions are asked in: the two that move sales first, because that is what a
   * business owner asks about first, then costs, then borrowing. Every word the form renders is
   * built here — a client component cannot import this module without pulling the server-only
   * write path into the browser bundle.
   */
  const rows = ([
    'revenue_change', 'pricing_change', 'payroll_change', 'hiring',
    'supplier_cost_change', 'marketing_change', 'debt_drawdown', 'debt_repayment',
  ] as const).map((kind) => ({
    kind,
    question: ASSUMPTION_QUESTION[kind],
    note: ASSUMPTION_NOTE[kind],
    cashFixed: CASH_ONLY_KINDS.has(kind),
    defaultCashEffect: DEFAULT_CASH_EFFECT[kind],
  }));

  return (
    <>
      <PageHeader
        eyebrow="What if"
        title="What if things change?"
        description={`Against what MOTION expects for ${months.map((m) => m.label).join(', ')}.`}
      />

      <AffordabilityCard orgSlug={orgSlug} months={months} asked={asked} check={affordability} />

      {mayRun ? (
        <Card className="mt-6">
          <CardHeader
            title="What would you like to change?"
            icon={<SlidersHorizontal />}
            tint="violet"
            description="Tick the ones you want to try. Everything else stays as MOTION expects it."
          />
          <CardBody>
            <ScenarioForm
              orgSlug={orgSlug}
              months={months}
              rows={rows}
              copy={{
                cashSameMonth: CASH_EFFECT_LABEL.same_month,
                cashNone: CASH_EFFECT_LABEL.none,
              }}
            />
          </CardBody>
        </Card>
      ) : (
        <p className="mt-6 text-sm text-ink-muted">
          You can read the scenarios your team has saved. Working a new one out is done by an owner
          or an administrator.
        </p>
      )}

      {/*
        * What sits below the form is always the LAST SAVED scenario, and it says so. A refusal of
        * the request just made is reported inside the form (`ActionMessage`, error tone) and saves
        * nothing, so this section cannot change in response to one — the label and the date are
        * what stop a reader taking an older answer for the answer to their latest question (HIGH-1,
        * `PHASE_12_REMEDIATION.md`).
        */}
      {hasScenario(latest) ? (
        <>
          <p className="mt-10 text-xs uppercase tracking-wide text-ink-faint">
            Last saved scenario
            {' · '}
            {new Date(latest.createdAt).toLocaleDateString('en-GB', {
              day: 'numeric', month: 'short', year: 'numeric',
            })}
          </p>
          <h2 className="mt-1 font-serif text-xl text-ink">{latest.name}</h2>
          <ScenarioComparison scenario={latest} orgSlug={orgSlug} />
          {mayRun ? (
            <div className="mt-4">
              <ArchiveControl orgSlug={orgSlug} scenarioId={latest.runId} archived={false} />
            </div>
          ) : null}
        </>
      ) : (
        <p className="mt-6 text-sm text-ink-muted">
          No scenario has been saved yet.
        </p>
      )}

      {saved.length <= 1 ? null : (
        <Card className="mt-10">
          <CardHeader title="Saved scenarios" description="What you have tried before." icon={<Bookmark />} tint="pink" />
          <CardBody>
            <ul className="flex flex-col gap-3 text-sm">
              {saved.map((scenario) => (
                <li key={scenario.runId} className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-3">
                    <IconBadge tint="violet" size="sm"><FlaskConical /></IconBadge>
                    <Link
                      href={`/app/${orgSlug}/what-if/${scenario.runId}`}
                      className="min-w-0 font-medium text-ink underline-offset-2 hover:text-accent hover:underline"
                    >
                      {scenario.name}
                    </Link>
                  </span>
                  <span className="text-ink-muted">
                    {new Date(scenario.createdAt).toLocaleDateString('en-GB', {
                      day: 'numeric', month: 'short', year: 'numeric',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </>
  );
}
