import type { DepartmentId, MainChart } from '@/modules/departments';

/** What the CSV header rows and the file name say about the view (`app.js#exportData`). */
export interface ExportMeta {
  readonly dept: DepartmentId;
  readonly deptName: string;
  readonly role: string;
  readonly scenario: string;
  readonly period: string;
  readonly months: number;
  readonly currency: string;
}

/** The unit row: the currency, or what the counts count. */
export function unitLabel(meta: ExportMeta, unit: MainChart['unit']): string {
  if (unit === 'money') return meta.currency;
  if (meta.dept === 'workflow') return 'Tasks';
  if (meta.dept === 'clients') return 'Requests';
  return 'Documents';
}

/**
 * The prototype's `exportData()`: a UTF-8 CSV with a BOM, every cell quoted, CRLF lines — the
 * header rows, then Period / series / Baseline and one row per month — downloaded through a
 * temporary link. The figures are the chart's own rows, exactly as the data table shows them.
 */
export function downloadChartCsv(chart: MainChart, meta: ExportMeta): void {
  const quote = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const rows: Array<Array<string | number>> = [
    ['APX Financial System'],
    ['Department', meta.deptName],
    ['View', meta.role],
    ['Scenario', meta.scenario],
    ['Period', meta.period],
    ['Currency / unit', unitLabel(meta, chart.unit)],
    ['Period', chart.series[0], chart.series[1], 'Baseline'],
    ...chart.rows.map((r) => [r.period, r.first, r.second, r.baseline]),
  ];
  const csv = `\ufeff${rows.map((r) => r.map(quote).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `APX-${meta.dept}-actual-${meta.months}m.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
