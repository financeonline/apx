/**
 * The engine regression record (ADR-124): compares two dumps written by `npm run engine:compare`
 * (test/regression/engine-comparison.test.ts) and prints, per organisation, every change in the
 * headline cash, receivables, payables, working-capital and P&L figures (revenue and what derives from it), every Health score and rule
 * result that moved, and every alert that appeared or went away.
 *
 *   npx tsx scripts/engine-compare.ts before.json after.json > record.md
 *
 * It reports; it does not judge. Every line it prints is a change someone has to explain.
 */
import { readFileSync } from 'node:fs';
import { Decimal } from '@/core/money';

interface Dump {
  readonly engineVersion: string;
  readonly organisations: Record<string, {
    readonly metrics: readonly string[];
    readonly health: ReadonlyArray<{
      readonly period: string; readonly score: number | null; readonly used: number | null;
      readonly dimensions: ReadonlyArray<{
        readonly key: string; readonly score: number | null; readonly included: boolean; readonly exclusion: string | null;
        readonly rules: ReadonlyArray<{ readonly rule: string; readonly result: string; readonly points: number | null }> | null;
      }> | null;
    }>;
    readonly alerts: readonly string[];
    /** Step 0D: who the organisation's invoices are booked to, `name|invoices|total` (step0d dumps only). */
    readonly identities?: readonly string[];
  }>;
}

const FIGURES = [
  'opening_cash', 'net_cash_movement', 'closing_cash', 'cash_runway_months',
  'receivables', 'receivables_overdue', 'payables', 'payables_overdue', 'working_capital',
  // FU-9: the days figures change basis (payables) and must be compared too.
  'receivables_days', 'payables_days',
  // The P&L family (FU-1): revenue and what is derived from it.
  'revenue', 'cost_of_sales', 'gross_profit', 'operating_expenses', 'operating_profit', 'net_profit',
  'gross_margin', 'net_margin', 'customer_concentration_top1',
] as const;

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: tsx scripts/engine-compare.ts before.json after.json');
  process.exit(2);
}
const before = JSON.parse(readFileSync(beforePath, 'utf8')) as Dump;
const after = JSON.parse(readFileSync(afterPath, 'utf8')) as Dump;

/** `period|key` → "value (missing)" for the figures this record follows. */
function figures(metrics: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of metrics) {
    const [period, key, value, , assurance, , missing] = line.split('|');
    if (!(FIGURES as readonly string[]).includes(key!)) continue;
    const shown = value === 'NULL' ? 'NULL' : new Decimal(value!).toFixed(key === 'cash_runway_months' ? 1 : key!.endsWith('margin') || key!.startsWith('customer_concentration') ? 4 : 2);
    const reason = missing?.startsWith('m=') && missing !== 'm=[]' ? ` ${missing.slice(2).replace(/"/g, '')}` : '';
    // ADR-130: an assurance-only change (a figure re-badged inferred / calculated) is a change too —
    // the dump always carried the field, and the comparison used to drop it.
    const level = value === 'NULL' || assurance === undefined || assurance === 'verified' ? '' : ` [${assurance}]`;
    out.set(`${period!.slice(0, 7)}|${key}`, `${shown}${value === 'NULL' ? reason : ''}${level}`);
  }
  return out;
}

function health(org: Dump['organisations'][string]): Map<string, string> {
  const out = new Map<string, string>();
  for (const h of org.health) {
    const p = h.period.slice(0, 7);
    out.set(`${p}|score`, `${h.score ?? 'NULL'} (${h.used ?? 0} dims)`);
    for (const d of h.dimensions ?? []) {
      out.set(`${p}|${d.key}`, d.included ? `${d.score}` : `excluded ${d.exclusion ?? ''}`.trim());
      for (const r of d.rules ?? []) out.set(`${p}|${d.key}.${r.rule}`, `${r.result}${r.points === null ? '' : ` ${r.points}`}`);
    }
  }
  return out;
}

function alerts(org: Dump['organisations'][string]): Set<string> {
  return new Set(org.alerts.map((a) => {
    const [rule, subject, , severity, period] = a.split('|');
    return `${rule} · ${severity} · ${period!.slice(0, 7)}${subject === 'none' || subject === '-' ? '' : ` · ${subject}`}`;
  }));
}

function diff(a: Map<string, string>, b: Map<string, string>): string[] {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  return keys.filter((k) => a.get(k) !== b.get(k)).map((k) => `| ${k.replace('|', ' | ')} | ${a.get(k) ?? '—'} | ${b.get(k) ?? '—'} |`);
}

const lines: string[] = [];
lines.push(`# Engine regression record: ${before.engineVersion} → ${after.engineVersion}`, '');
const summary: string[] = [];
for (const key of Object.keys(after.organisations)) {
  const a = before.organisations[key];
  const b = after.organisations[key]!;
  if (a === undefined) { lines.push(`## ${key}`, '', '_not in the earlier dump_', ''); continue; }
  const figureDiff = diff(figures(a.metrics), figures(b.metrics));
  const healthDiff = diff(health(a), health(b));
  const [aa, ba] = [alerts(a), alerts(b)];
  const added = [...ba].filter((x) => !aa.has(x)).sort();
  const removed = [...aa].filter((x) => !ba.has(x)).sort();
  // Step 0D: identity is not an engine output, but the engine's customer figures rest on it.
  const [ai, bi] = [new Set(a.identities ?? []), new Set(b.identities ?? [])];
  const identityGone = [...ai].filter((x) => !bi.has(x)).sort();
  const identityNew = [...bi].filter((x) => !ai.has(x)).sort();
  summary.push(`| ${key} | ${figureDiff.length} | ${healthDiff.length} | ${added.length} | ${removed.length} |`);
  lines.push(`## ${key}`, '');
  if (figureDiff.length + healthDiff.length + added.length + removed.length + identityGone.length + identityNew.length === 0) {
    lines.push('No change.', '');
    continue;
  }
  if (identityGone.length + identityNew.length > 0) {
    lines.push('| Customers before (name · invoices · total) | Customers after |', '|---|---|');
    for (let i = 0; i < Math.max(identityGone.length, identityNew.length); i += 1) {
      lines.push(`| ${identityGone[i]?.replace(/\|/g, ' · ') ?? ''} | ${identityNew[i]?.replace(/\|/g, ' · ') ?? ''} |`);
    }
    lines.push('');
  }
  if (figureDiff.length > 0) lines.push('| Month | Figure | Before | After |', '|---|---|---|---|', ...figureDiff, '');
  if (healthDiff.length > 0) lines.push('| Month | Health | Before | After |', '|---|---|---|---|', ...healthDiff, '');
  for (const x of added) lines.push(`- alert added: ${x}`);
  for (const x of removed) lines.push(`- alert removed: ${x}`);
  lines.push('');
}
console.log(['| Organisation | Figure changes | Health changes | Alerts added | Alerts removed |', '|---|---|---|---|---|', ...summary, '', ...lines].join('\n'));
