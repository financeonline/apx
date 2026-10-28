import 'server-only';
import type { Db } from '@/db/types';
import { readOrganization, readRowById, readRows, readRowsByIds } from '@/db/app/caller-reads';
import type { HealthCardView } from '@/modules/health';
import type { ReportFileRef } from '../domain/types';

/** Reads for the Monthly Management Report. Nothing here writes; the render job does that. */

export interface ReportFileRow {
  readonly id: string;
  /**
   * `monthly_management` for the full Monthly Management Report's PDF, which only `financials.view`
   * may read (ADR-172 addendum; `report_files_select`); a Phase 17 kind for a stored report's PDF.
   */
  readonly reportKind: string;
  /** NULL for the PDF of a stored (Phase 17) report, which belongs to the report instead. */
  readonly periodId: string | null;
  readonly storageBucket: string;
  readonly storagePath: string;
  readonly byteSize: number | null;
  readonly createdAt: string;
}

interface FileRow {
  id: string;
  report_kind: string;
  period_id: string | null;
  storage_bucket: string;
  storage_path: string;
  byte_size: number | null;
  created_at: string;
  deleted_at: string | null;
}

export async function listReportFiles(
  db: Db, orgId: string,
): Promise<ReportFileRef[]> {
  // Phase 17: an adviser or custom report's PDF names its month too; only the monthly management
  // report's PDFs belong in this list. Equality filters only (no composite index); newest first in
  // TypeScript.
  const rows = (await readRows<FileRow>(db, orgId, 'report_files', (q) => q
    .where('report_kind', '==', 'monthly_management')
    .where('deleted_at', '==', null)))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  // The old `fiscal_periods!inner (label)`: a file whose month the caller cannot read is left out.
  const periods = await readRowsByIds<{ id: string; label: string }>(
    db, orgId, 'fiscal_periods', rows.map((row) => row.period_id),
  );
  const labels = new Map(periods.map((p) => [p.id, p.label]));
  return rows
    .filter((row) => row.period_id !== null && labels.has(row.period_id))
    .map((row) => ({
      id: row.id,
      // Monthly rows always name their month (`report_files_subject`).
      periodId: row.period_id ?? '',
      periodLabel: labels.get(row.period_id ?? '') ?? '',
      byteSize: row.byte_size === null ? null : Number(row.byte_size),
      createdAt: row.created_at,
    }));
}

/** Resolved by `(organization_id, id)`, so another organisation's id is simply absent (§166). */
export async function getReportFile(
  db: Db, orgId: string, reportFileId: string,
): Promise<ReportFileRow | null> {
  const row = await readRowById<FileRow>(db, orgId, 'report_files', reportFileId);
  if (row === null || row.deleted_at !== null) return null;
  return {
    id: row.id,
    reportKind: row.report_kind,
    periodId: row.period_id,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    createdAt: row.created_at,
  };
}

export async function organisationName(db: Db, orgId: string): Promise<string> {
  const org = await readOrganization(db, orgId);
  return (org?.name as string | undefined) ?? 'Your business';
}

/** The run the period's figures came from, so the report can say when and by which engine. */
export async function loadRunFor(
  db: Db, orgId: string, periodId: string,
): Promise<{ engineVersion: string | null; finishedAt: string | null }> {
  const cells = await readRows<{ calculation_run_id: string | null }>(
    db, orgId, 'metric_current', (q) => q.where('period_id', '==', periodId).limit(1),
  );
  const runId = cells[0]?.calculation_run_id ?? null;
  // The old `calculation_runs!inner`: the run as the caller may read it.
  const run = runId === null ? null
    : await readRowById<{ engine_version: string; finished_at: string | null }>(db, orgId, 'calculation_runs', runId);
  return {
    engineVersion: run?.engine_version ?? null,
    finishedAt: run?.finished_at ?? null,
  };
}

/**
 * The one plain sentence the report opens with.
 *
 * Taken from the stored health score's own summary, never written here and never from the AI
 * (`FINANCIAL_ENGINE.md §7.4`). A report that phrased the month in its own words would be a second
 * opinion about figures the engine already summarised.
 */
export function summaryFor(health: HealthCardView | null, periodLabel: string): string {
  if (health === null || health.score === null) {
    return `Figures for ${periodLabel}.`;
  }
  return `${periodLabel}: health score ${health.score}.`;
}
