import 'server-only';
import { NotFound } from '@/core/errors';
import { can } from '@/core/permissions';
import { isOverdue, listActions, type Action } from '@/modules/actions';
import { loadLastDataDate } from '@/modules/dashboard';
import { loadTaxDates, type TaxDates } from '@/modules/tax';
import { moduleOn, type AccessContext } from '@/modules/tenancy';
import * as repo from '../data/repository';

/**
 * Home's "Data & compliance" strip (ADR-172 follow-up; SOW "Client/Analyst specific dashboards" and
 * "Accountant: basic summary of integrated or uploaded data, including compliance").
 *
 * Not a separate dashboard: Home composes its sections by PERMISSION, and this is the section for
 * whoever keeps the data — the holder of `imports.review`, which is an accountant's job (and an
 * owner's, an admin's and the Financial Analyst's too; they see the same strip). Each line is asked
 * only of someone who may read it, and is null otherwise, so the page draws a line or leaves it out
 * and never says "none" for something it could not see:
 *
 *   - uploads waiting for review, and failed ones (`imports.review`);
 *   - when data was last added (`imports.review` — the committed import);
 *   - the VAT quarter and Corporation Tax dates the tax module states (`financials.view`, the Tax
 *     system on);
 *   - open actions given to THIS person (`actions.view`, the Actions system on).
 *
 * It computes nothing: counts, dates and rows the Imports, Tax and Action Centre pages already read.
 */

export interface DataComplianceView {
  readonly imports: { readonly awaitingReview: number; readonly failed: number } | null;
  readonly lastDataAdded: string | null;
  readonly tax: TaxDates | null;
  readonly myActions: { readonly open: number; readonly overdue: number; readonly top: readonly Action[] } | null;
}

/** How many of one's own actions the strip names; the rest are a count and a link. */
const MY_ACTIONS_SHOWN = 3;

export async function loadDataCompliance(ctx: AccessContext, today: string): Promise<DataComplianceView> {
  const orgId = ctx.orgId;
  if (!orgId) throw new NotFound();
  const reviewsImports = can(ctx, 'imports.review');
  const seesTax = can(ctx, 'financials.view') && moduleOn(ctx, 'tax');
  const seesActions = can(ctx, 'actions.view') && moduleOn(ctx, 'actions');

  const [imports, lastDataAdded, tax, mine] = await Promise.all([
    reviewsImports ? repo.importCounts(ctx.db, orgId) : Promise.resolve(null),
    reviewsImports ? loadLastDataDate(ctx.db, orgId, ctx.requestId) : Promise.resolve(null),
    seesTax ? loadTaxDates(ctx) : Promise.resolve(null),
    seesActions
      ? listActions(ctx, { status: ['open', 'in_progress'], ownerUserId: ctx.userId })
      : Promise.resolve(null),
  ]);

  return {
    imports,
    lastDataAdded,
    tax,
    myActions: mine === null ? null : {
      open: mine.length,
      overdue: mine.filter((action) => isOverdue(action, today)).length,
      top: mine.slice(0, MY_ACTIONS_SHOWN),
    },
  };
}
