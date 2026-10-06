import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';
import type { HealthCardView } from '@/modules/health';
import type { ReportFileRef } from '../domain/types';

/** Reads for the Monthly Management Report. Nothing here writes; the render job does that. */

export interface ReportFileRow {
  readonly id: string;
  /** NULL for the PDF of a stored (Phase 17) report, which belongs to the report instead. */
  readonly periodId: string | null;
  readonly storageBucket: string;
  readonly storagePath: string;
  readonly byteSize: number | null;
  readonly createdAt: string;
}

const FILE_SELECT =
  'id, period_id, storage_bucket, storage_path, byte_size, created_at, deleted_at';

interface FileRow {
  id: string;
  period_id: string | null;
  storage_bucket: string;
  storage_path: string;
  byte_size: number | null;
  created_at: string;
  deleted_at: string | null;
}

export async function listReportFiles(
  db: SupabaseClient, orgId: string,
): Promise<ReportFileRef[]> {
  const { data, error } = await db
    .from('report_files')
    .select(`${FILE_SELECT}, fiscal_periods!inner (label)`)
    .eq('organization_id', orgId)
    // Phase 17: an adviser or custom report's PDF names its month too; only the monthly
    // management report's PDFs belong in this list.
    .eq('report_kind', 'monthly_management')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw toMotionError(error);

  const rows = (data ?? []) as unknown as Array<FileRow & {
    fiscal_periods: { label: string } | { label: string }[] | null;
  }>;
  return rows.map((row) => {
    const period = Array.isArray(row.fiscal_periods) ? row.fiscal_periods[0] : row.fiscal_periods;
    return {
      id: row.id,
      // Monthly rows always name their month (`report_files_subject`).
      periodId: row.period_id ?? '',
      periodLabel: period?.label ?? '',
      byteSize: row.byte_size,
      createdAt: row.created_at,
    };
  });
}

/** Resolved by `(organization_id, id)`, so another organisation's id is simply absent (§166). */
export async function getReportFile(
  db: SupabaseClient, orgId: string, reportFileId: string,
): Promise<ReportFileRow | null> {
  const { data, error } = await db
    .from('report_files').select(FILE_SELECT)
    .eq('organization_id', orgId).eq('id', reportFileId).maybeSingle();
  if (error) throw toMotionError(error);
  if (data === null) return null;

  const row = data as unknown as FileRow;
  if (row.deleted_at !== null) return null;
  return {
    id: row.id,
    periodId: row.period_id,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    byteSize: row.byte_size,
    createdAt: row.created_at,
  };
}

export async function organisationName(db: SupabaseClient, orgId: string): Promise<string> {
  const { data, error } = await db
    .from('organizations').select('name').eq('id', orgId).maybeSingle();
  if (error) throw toMotionError(error);
  return (data as { name?: string } | null)?.name ?? 'Your business';
}

/** The run the period's figures came from, so the report can say when and by which engine. */
export async function loadRunFor(
  db: SupabaseClient, orgId: string, periodId: string,
): Promise<{ engineVersion: string | null; finishedAt: string | null }> {
  const { data, error } = await db
    .from('metric_current')
    .select('calculation_runs!inner (engine_version, finished_at)')
    .eq('organization_id', orgId)
    .eq('period_id', periodId)
    .limit(1);
  if (error) throw toMotionError(error);

  const rows = (data ?? []) as unknown as Array<{
    calculation_runs: { engine_version: string; finished_at: string | null }
      | { engine_version: string; finished_at: string | null }[] | null;
  }>;
  const run = rows[0]?.calculation_runs;
  const resolved = Array.isArray(run) ? run[0] : run;
  return {
    engineVersion: resolved?.engine_version ?? null,
    finishedAt: resolved?.finished_at ?? null,
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
