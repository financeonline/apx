import Link from 'next/link';
import { formatMoney, formatPercent } from '@/core/money';
import {
  CASH_EFFECT_LABEL, SCENARIO_DISCLAIMER, SCENARIO_HEADLINE_KEYS,
  assumptionSentence, type ScenarioView,
} from '@/modules/scenarios';
import {
  BASIS_LABEL, BASIS_TEXT, metricLabel, unavailableText as forecastUnavailableText,
} from '@/modules/forecast';
import { DATA_QUALITY_NOTE_TEXT } from '@/components/dashboard';
import { Badge, Banner, Card, CardBody, CardHeader } from '@/components/ui/surfaces';

/**
 * BASELINE versus SCENARIO (REQ-SC-09, §5, §6, §14).
 *
 * Three rules from §14–§16 decide everything on this screen:
 *
 *   * **Six figures, not thirty.** The same six §5 names, in the same order, for the first month.
 *     The other two months are behind "The months after that" — §14 asks for progressive disclosure
 *     and a non-technical reader cannot hold thirty numbers.
 *   * **A scenario never looks like a result.** Each figure carries the word "If this happens",
 *     the baseline it is compared with is labelled "Expected now", and the disclaimer is on the
 *     page rather than in a tooltip.
 *   * **The assumptions are on the page.** Not behind a link, not in a tooltip: the figures mean
 *     nothing without them, so they are printed under the comparison in full sentences.
 */

function pounds(value: string, currency: string | null): string {
  return formatMoney(value, { currency: currency ?? 'GBP' });
}

export function ScenarioComparison({
  scenario, orgSlug,
}: {
  scenario: ScenarioView;
  orgSlug: string;
}) {
  const first = scenario.periods[0];
  const later = scenario.periods.slice(1);
  // The organisation's configured currency, carried on the view — never a default and never
  // whatever a cell happened to carry (MEDIUM-3).
  const currency = scenario.currency;

  return (
    <>
      {scenario.stale ? (
        <div className="mt-6">
          <Banner tone="warn" title="Your forecast has moved on since this was worked out">
            This scenario still shows what it showed when it was saved. Work out a new one to use
            the latest expectations.
          </Banner>
        </div>
      ) : null}

      {/* §16: the disclaimer is on the page, not behind a tooltip. */}
      <p className="mt-6 text-sm text-ink-muted">{SCENARIO_DISCLAIMER}</p>

      {/*
        * §12: how much to lean on the baseline this scenario moved, in the forecast's own three
        * words and never a percentage, followed by any note the forecast's figures carried. Both
        * are stored on the run, so a saved scenario keeps disclosing them after the forecast has
        * been regenerated (MEDIUM-2).
        */}
      {scenario.basis === null && scenario.dataQuality.warnings.length === 0 ? null : (
        <div className="mt-3 text-sm text-ink-muted" data-testid="scenario-basis">
          {scenario.basis === null ? null : (
            <p>
              <span className="text-ink">{BASIS_LABEL[scenario.basis]}</span>
              {' — '}
              {BASIS_TEXT[scenario.basis].split('—')[1]?.trim()}
            </p>
          )}
          {scenario.dataQuality.warnings.length === 0 ? null : (
            <p className="mt-1">
              The figures this rests on carry a note:{' '}
              {scenario.dataQuality.warnings
                .map((code) => DATA_QUALITY_NOTE_TEXT[code] ?? 'some of the figures carry a data-quality warning')
                .join('; ')}
              .
            </p>
          )}
        </div>
      )}

      {first === undefined ? null : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SCENARIO_HEADLINE_KEYS.map((key) => {
            const metric = first.metrics.find((m) => m.metricKey === key);
            const missing = scenario.dataQuality.forecastUnavailable.find((u) => u.metricKey === key);
            return (
              <Card key={key}>
                <CardBody>
                  <p className="text-xs uppercase tracking-wide text-ink-faint">{metricLabel(key)}</p>
                  {metric === undefined ? (
                    <p className="mt-2 text-sm text-ink-muted">
                      {missing === undefined
                        ? 'Not available from the figures we have.'
                        : forecastUnavailableText(missing.reason)}
                    </p>
                  ) : (
                    <>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span className="font-mono text-2xl tabular-nums text-ink">
                          {pounds(metric.scenarioValue, metric.currency)}
                        </span>
                        <Badge tone="neutral">If this happens</Badge>
                      </div>
                      <p className="mt-2 text-sm text-ink-muted">
                        Expected now:{' '}
                        <span className="font-mono tabular-nums text-ink">
                          {pounds(metric.baselineValue, metric.currency)}
                        </span>
                      </p>
                      <p className="mt-1 font-mono text-sm tabular-nums text-ink">
                        {formatMoney(metric.change, {
                          currency: metric.currency ?? 'GBP', signDisplay: 'always',
                        })}
                        {metric.changeRatio === null ? null : (
                          <span className="text-ink-muted">
                            {' '}({formatPercent(metric.changeRatio, { signDisplay: 'always' })})
                          </span>
                        )}
                      </p>
                    </>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <Card className="mt-6">
        <CardHeader title="What this assumes" />
        <CardBody>
          <ul className="flex flex-col gap-2 text-sm">
            {/*
              * The sentence names its own subject ("Sales up by 10%…"), so there is no label chip
              * beside it: a reader who saw "Sales · Sales up by 10%" would be reading the noun
              * twice and wondering which of the two mattered.
              */}
            {scenario.assumptions.map((assumption, index) => (
              <li key={`${assumption.kind}-${index}`} className="flex flex-wrap items-baseline gap-2">
                <span className="text-ink">
                  {assumptionSentence(assumption, (value) => pounds(value, currency))}
                </span>
                <span className="text-ink-muted">
                  · {CASH_EFFECT_LABEL[assumption.cashEffect].toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-ink-muted">
            MOTION changes only what these say. It does not assume anything else follows from them —
            no extra sales from marketing, no change to when money arrives, and no interest that was
            not given.
          </p>
        </CardBody>
      </Card>

      {later.length === 0 ? null : (
        <details className="mt-6 rounded-card border border-line bg-surface p-4">
          <summary className="cursor-pointer text-sm text-ink">The months after that</summary>
          <div className="mt-3 flex flex-col gap-4">
            {later.map((period) => (
              <div key={period.periodId}>
                <p className="text-sm font-medium text-ink">{period.periodLabel}</p>
                <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  {SCENARIO_HEADLINE_KEYS.map((key) => {
                    const metric = period.metrics.find((m) => m.metricKey === key);
                    if (metric === undefined) return null;
                    return (
                      <div key={key} className="flex gap-1.5">
                        <dt className="text-ink-muted">{metricLabel(key)}</dt>
                        <dd className="font-mono tabular-nums text-ink">
                          {pounds(metric.scenarioValue, metric.currency)}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            ))}
          </div>
        </details>
      )}

      <details className="mt-4 rounded-card border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm text-ink">How was this worked out?</summary>
        <div className="mt-3 flex flex-col gap-3 text-sm text-ink-muted">
          <p>
            MOTION starts from what it already expects for the next three months, changes only the
            things listed above, and then works the rest out the same way it always does: profit
            from sales less costs, and cash from your last real balance plus each month&rsquo;s
            movement. Nothing is worked out twice and nothing is worked out differently on the two
            sides, so the comparison is between two versions of the same sum.
          </p>
          <p>
            Interest on a loan changes your cash but not your operating profit, because interest
            sits below operating profit in your accounts.
          </p>
          {scenario.dataQuality.forecastUnavailable.length === 0 ? null : (
            <div>
              <p className="text-ink">Not included</p>
              <ul className="mt-1 flex flex-col gap-1">
                {scenario.dataQuality.forecastUnavailable.map((item) => (
                  <li key={item.metricKey}>
                    {metricLabel(item.metricKey)} — {forecastUnavailableText(item.reason)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {scenario.evidenceBundleId === null ? null : (
            <p>
              <Link
                href={`/app/${orgSlug}/evidence/${scenario.evidenceBundleId}`}
                className="text-accent underline underline-offset-2"
              >
                See the figures this rests on
              </Link>
            </p>
          )}
          <p>
            Worked out on {new Date(scenario.createdAt).toLocaleDateString('en-GB', {
              day: 'numeric', month: 'long', year: 'numeric',
            })}.
          </p>
        </div>
      </details>

      {/*
        * §17: the integration point with the Action Centre, and no more than that. MOTION does not
        * create an action from a scenario — a person decides that, in the place decisions are
        * recorded, and nothing here does it on their behalf.
        */}
      <p className="mt-6 text-sm text-ink-muted">
        Decided to do something about this?{' '}
        <Link href={`/app/${orgSlug}/actions`} className="text-accent underline underline-offset-2">
          Record it in your actions
        </Link>
        .
      </p>
    </>
  );
}

