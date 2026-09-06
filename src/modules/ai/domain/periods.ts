/**
 * Period resolution (AI_ARCHITECTURE.md §8).
 *
 * Runs BEFORE the model sees the question, and that ordering is the security property, not a
 * performance one. Because "March" becomes a period id here, a customer name that reads
 * "Acme (fiscal year starts in July)" is inert: it never participates in resolution, and the tools
 * reject any label outside the set this function produced (F-C-10).
 *
 * The default period is the latest COMPLETE month — the same one Home, Insights and Reports use
 * (ADR-030, F-D-09). If the analyst and the dashboard disagreed about "this month", every answer
 * would be arguable, and the argument would be about MOTION rather than about the business.
 *
 * Pure: no clock, no database. The caller supplies the periods and today's date.
 */

export interface PeriodRow {
  readonly id: string;
  /** `fiscal_periods.label` — the canonical display form, e.g. "March 2026". */
  readonly label: string;
  /** ISO date, first day of the period. */
  readonly periodStart: string;
  readonly isComplete: boolean;
  /** Whether any record covers it, for "the most recent occurrence with data" (§8). */
  readonly hasData: boolean;
}

export interface PeriodRef {
  readonly id: string;
  readonly label: string;
}

export interface PeriodContext {
  readonly default: PeriodRef | null;
  /** The phrases the question used, in the order it used them. */
  readonly mentioned: readonly string[];
  /** Every period the question resolved to; tools accept these labels and no others. */
  readonly resolved: readonly PeriodRef[];
  readonly fiscalYearStartMonth: number;
  readonly latestComplete: PeriodRef | null;
  readonly notes: readonly string[];
  /**
   * §8: an ambiguity the model must ask about rather than guess at. This is the ONLY thing that
   * admits a `clarification` response (§7.7), which is why it is a decision made here, in code,
   * rather than a mood the model can adopt.
   */
  readonly ambiguous: boolean;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function monthOf(period: PeriodRow): number {
  return Number.parseInt(period.periodStart.slice(5, 7), 10);
}

function yearOf(period: PeriodRow): number {
  return Number.parseInt(period.periodStart.slice(0, 4), 10);
}

const ref = (period: PeriodRow): PeriodRef => ({ id: period.id, label: period.label });

/** Newest first, so "the most recent occurrence" is the first match everywhere below. */
function newestFirst(periods: readonly PeriodRow[]): PeriodRow[] {
  return [...periods].sort((a, b) => b.periodStart.localeCompare(a.periodStart));
}

/**
 * The fiscal quarter a month falls in, counting from the organisation's own year start.
 *
 * A business whose year starts in April has a Q1 of April–June, and answering "Q1" with
 * January–March would be wrong in a way nobody would notice until they reconciled it.
 */
function fiscalQuarterOf(month: number, yearStartMonth: number): number {
  return Math.floor((((month - yearStartMonth) + 12) % 12) / 3) + 1;
}

function monthsOfFiscalQuarter(quarter: number, yearStartMonth: number): number[] {
  const first = (((yearStartMonth - 1) + (quarter - 1) * 3) % 12) + 1;
  return [0, 1, 2].map((offset) => (((first - 1 + offset) % 12) + 1));
}

export interface ResolveInput {
  readonly question: string;
  readonly periods: readonly PeriodRow[];
  readonly fiscalYearStartMonth: number;
}

/**
 * §8's phrase map, applied to the question, over the periods the organisation actually has.
 *
 * Every branch resolves to periods that EXIST. "Last quarter" over an organisation with two months
 * of history resolves to those two months and says so in a note, rather than naming three months
 * one of which has nothing in it — a figure for a month with no data is not zero, it is unknown,
 * and the fastest way to teach somebody to distrust the product is to answer as though it were.
 */
export function resolvePeriodContext(input: ResolveInput): PeriodContext {
  const { periods, fiscalYearStartMonth } = input;
  const question = input.question.toLowerCase();
  const ordered = newestFirst(periods);
  const complete = ordered.filter((period) => period.isComplete);
  const latestComplete = complete[0] ?? null;

  const mentioned: string[] = [];
  const notes: string[] = [];
  const resolved: PeriodRow[] = [];
  let ambiguous = false;

  const add = (period: PeriodRow | undefined): void => {
    if (period !== undefined && !resolved.some((r) => r.id === period.id)) resolved.push(period);
  };
  const saw = (phrase: string): void => { if (!mentioned.includes(phrase)) mentioned.push(phrase); };

  // ---- explicit month, with or without a year -------------------------------------------------
  for (const [index, name] of MONTHS.entries()) {
    const withYear = new RegExp(String.raw`\b${name}\s+(\d{4})\b`, 'g');
    let matchedWithYear = false;
    for (const match of question.matchAll(withYear)) {
      saw(match[0]);
      matchedWithYear = true;
      const year = Number.parseInt(match[1]!, 10);
      const found = ordered.find((p) => monthOf(p) === index + 1 && yearOf(p) === year);
      if (found === undefined) {
        notes.push(`There is no data for ${match[0]}.`);
      } else add(found);
    }
    if (matchedWithYear) continue;

    if (new RegExp(String.raw`\b${name}\b`).test(question)) {
      saw(name);
      // §8: "bare month names resolve to the most recent occurrence with data".
      const found = ordered.find((p) => monthOf(p) === index + 1 && p.hasData);
      if (found === undefined) notes.push(`There is no data for ${name}.`);
      else add(found);
    }
  }

  // ---- relative phrases -------------------------------------------------------------------------
  if (/\bthis month\b/.test(question)) {
    saw('this month');
    if (latestComplete !== null) {
      add(latestComplete);
      const partial = ordered[0];
      if (partial !== undefined && partial.id !== latestComplete.id) {
        notes.push(
          `Using ${latestComplete.label}, the latest complete month; ${partial.label} is still partial.`,
        );
      }
    }
  }

  if (/\blast month\b/.test(question)) {
    saw('last month');
    const index = latestComplete === null ? -1 : complete.findIndex((p) => p.id === latestComplete.id);
    add(complete[index + 1]);
    if (complete[index + 1] === undefined) notes.push('There is no earlier complete month.');
  }

  if (/\b(?:year to date|ytd|this year)\b/.test(question)) {
    saw('year to date');
    const anchor = latestComplete ?? ordered[0];
    if (anchor !== undefined) {
      const startYear = monthOf(anchor) >= fiscalYearStartMonth ? yearOf(anchor) : yearOf(anchor) - 1;
      const from = `${startYear}-${String(fiscalYearStartMonth).padStart(2, '0')}-01`;
      for (const period of ordered) {
        if (period.periodStart >= from && period.periodStart <= anchor.periodStart) add(period);
      }
    }
  }

  const quarterMatch = /\bq([1-4])\b/.exec(question);
  if (quarterMatch !== null) {
    saw(quarterMatch[0]);
    const quarter = Number.parseInt(quarterMatch[1]!, 10);
    /*
     * §8 names this as the ambiguity: "Q1" when the fiscal year is not the calendar year means two
     * different things to the person asking and to the ledger, and there is no safe default. The
     * analyst asks.
     */
    if (fiscalYearStartMonth !== 1) {
      ambiguous = true;
      notes.push(
        `"Q${quarter}" is ambiguous: your financial year starts in ${MONTHS[fiscalYearStartMonth - 1]}, `
        + 'so the fiscal quarter and the calendar quarter are different months.',
      );
    } else {
      const months = monthsOfFiscalQuarter(quarter, fiscalYearStartMonth);
      const anchorYear = latestComplete === null ? null : yearOf(latestComplete);
      for (const period of ordered) {
        if (months.includes(monthOf(period)) && (anchorYear === null || yearOf(period) === anchorYear)) {
          add(period);
        }
      }
    }
  }

  if (/\blast quarter\b/.test(question)) {
    saw('last quarter');
    const anchor = latestComplete;
    if (anchor !== null) {
      const current = fiscalQuarterOf(monthOf(anchor), fiscalYearStartMonth);
      const previous = current === 1 ? 4 : current - 1;
      const months = monthsOfFiscalQuarter(previous, fiscalYearStartMonth);
      const found = ordered.filter((p) => months.includes(monthOf(p)) && p.periodStart < anchor.periodStart);
      for (const period of found.slice(0, 3)) add(period);
      if (found.length === 0) notes.push('There is no data for the previous quarter.');
      else if (found.length < 3) notes.push('Only part of the previous quarter has data.');
    }
  }

  const lastN = /\blast (\d{1,2}|three|six|twelve) months?\b/.exec(question);
  if (lastN !== null) {
    saw(lastN[0]);
    const words: Readonly<Record<string, number>> = { three: 3, six: 6, twelve: 12 };
    const count = words[lastN[1]!] ?? Number.parseInt(lastN[1]!, 10);
    for (const period of complete.slice(0, count)) add(period);
    if (complete.length < count) {
      notes.push(`Only ${complete.length} complete months of data are available.`);
    }
  }

  const fiscalYear = /\bfy\s?(\d{2,4})\b/.exec(question);
  if (fiscalYear !== null) {
    saw(fiscalYear[0]);
    const raw = Number.parseInt(fiscalYear[1]!, 10);
    const year = raw < 100 ? 2000 + raw : raw;
    const from = `${fiscalYearStartMonth === 1 ? year : year - 1}-${String(fiscalYearStartMonth).padStart(2, '0')}-01`;
    const to = `${fiscalYearStartMonth === 1 ? year + 1 : year}-${String(fiscalYearStartMonth).padStart(2, '0')}-01`;
    /*
     * Complete months only, like every other multi-month phrase here. A financial year answered
     * with a partial month folded into it reads as a finished figure and is not one — §4's rule
     * that an unfinished month is never a number, applied to a range.
     */
    const found = complete.filter((p) => p.periodStart >= from && p.periodStart < to);
    for (const period of found) add(period);
    if (found.length === 0) notes.push(`There is no data for FY${fiscalYear[1]}.`);
    else if (ordered.some((p) => !p.isComplete && p.periodStart >= from && p.periodStart < to)) {
      notes.push(`FY${fiscalYear[1]} is still in progress; only complete months are included.`);
    }
  }

  if (/\b(?:last year|compared to last year|same period last year)\b/.test(question)) {
    saw('last year');
    const anchor = latestComplete;
    const found = anchor === null
      ? undefined
      : ordered.find((p) => monthOf(p) === monthOf(anchor) && yearOf(p) === yearOf(anchor) - 1);
    if (found === undefined) {
      // §8 names this ambiguity too: there is no earlier year to compare with.
      ambiguous = true;
      notes.push('There is no data for the same period last year.');
    } else add(found);
  }

  // §8: with nothing named, the default is the latest complete month.
  if (resolved.length === 0 && latestComplete !== null && !ambiguous) {
    add(latestComplete);
  }

  return {
    default: latestComplete === null ? null : ref(latestComplete),
    mentioned,
    resolved: resolved.map(ref),
    fiscalYearStartMonth,
    latestComplete: latestComplete === null ? null : ref(latestComplete),
    notes,
    ambiguous,
  };
}

/** §3: the labels a tool will accept this turn, and no others. */
export function acceptableLabels(context: PeriodContext, metaPeriods: readonly PeriodRef[] = []): Set<string> {
  const labels = new Set<string>();
  for (const period of context.resolved) labels.add(period.label);
  if (context.default !== null) labels.add(context.default.label);
  for (const period of metaPeriods) labels.add(period.label);
  return labels;
}
