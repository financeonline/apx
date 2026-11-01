/**
 * View models the dashboard's server actions return to its client components (formatted strings
 * and drawing numbers only — the components never compute a figure).
 */

/** The prototype's monthly target check (`operations.js#renderTargets`), formatted. */
export interface TargetsCheckView {
  readonly month: string;
  /** False: "Data completion required" (no actual for the month). */
  readonly hasActuals: boolean;
  readonly warnings: number;
  readonly items: readonly {
    readonly key: string;
    readonly label: string;
    readonly status: 'on-track' | 'attention' | 'missing';
    readonly actual: string;        // "£278k", "18.0%", "78 tasks", "No figure"
    readonly target: string;        // "max £15k", "£300k"
    readonly meterPercent: string;  // "0"–"100"
  }[];
  /** The card's preview (`#targets-preview`); null without actuals. */
  readonly preview: { readonly salesActual: string; readonly salesTarget: string; readonly marketingActual: string; readonly marketingTarget: string } | null;
  /** The card's chart (`#targets-chart`): six months of sales against the selected sales target. */
  readonly chart: {
    readonly labels: readonly string[];
    readonly sales: readonly (number | null)[];
    readonly titles: readonly string[];
    readonly target: number;
    readonly cap: number;
    /** Grid labels at 0, ½ and the cap. */
    readonly ticks: readonly [string, string, string];
  };
}

export interface GrowthRowsView {
  readonly rows: readonly { readonly rate: number; readonly revenue: string; readonly cost: string; readonly profit: string; readonly uplift: string; readonly profitCompact: string }[];
  readonly investmentDisplay: string;
}

/** The targets API's record (`GET /api/dashboard/targets`). */
export interface TargetsRecord {
  readonly month: string;
  readonly targets: { readonly workflow: number; readonly sales: string; readonly marketing: string; readonly costRatio: string; readonly marketingRatio: string };
  readonly revision: number;
  readonly isDefault: boolean;
  readonly updatedAt: string | null;
  readonly canManage?: boolean;
}
