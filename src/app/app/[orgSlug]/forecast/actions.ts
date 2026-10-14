'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { generateForecast, hasForecast } from '@/modules/forecast';
import { done, fail, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Work the forecast out again (REQ-FC-02; ADR-099).
 *
 * `financials.view` (ADR-172): the forecast's tables are figures beneath the overview, and a 3rd party
 * holds `dashboard.view` without them, so the `dashboard.view` this asked for until then would have
 * let a 3rd party write a forecast. Checked here first, then by `generateForecast` and in SQL where
 * `api_server.finish_forecast` re-validates the actor — the permission is not a property of this
 * button (ADR-026). No new forecast permission exists: a forecast is a figure, and §22 forbids one
 * that could sit outside the matrix.
 */
export async function regenerateForecastAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'financials.view');

    const state = await generateForecast(ctx);
    revalidatePath(`/app/${orgSlug}/forecast`);

    /*
     * "It could not be worked out" is an outcome, not a failure, and it has to be SAID. Reporting
     * success for a run that produced nothing would leave the reader looking at the same empty page
     * with a tick beside it, and wondering which of the two things had happened.
     */
    return hasForecast(state)
      ? done('Worked out from your latest figures.')
      : done('There is not enough finished history to forecast from yet. '
        + 'A forecast needs at least three finished months in a row.');
  } catch (error) {
    return fail(error, { requestId, action: 'forecast.generate' });
  }
}
