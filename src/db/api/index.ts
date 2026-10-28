import 'server-only';
import type { DbFunctions } from '../registry';
import { functions as tenancy } from './tenancy';
import { functions as platform } from './platform';
import { functions as portfolio } from './portfolio';
import { functions as imports } from './imports';
import { functions as financials } from './financials';
import { functions as banking } from './banking';
import { functions as commercial } from './commercial';
import { functions as marketing } from './marketing';
import { functions as engagement } from './engagement';
import { functions as actions } from './actions';
import { functions as alerts } from './alerts';
import { functions as reporting } from './reporting';
import { functions as investment } from './investment';
import { functions as scenarios } from './scenarios';
import { functions as ai } from './ai';
import { functions as jobs } from './jobs';

/**
 * Every `api.*` function: what a signed-in user may ask the database to do (ADR-026).
 *
 * One file per area; each exports its functions under their SQL names. A name defined twice is a
 * merge mistake, so `assertDisjoint` fails the server at start-up rather than letting one silently win.
 */
const AREAS: ReadonlyArray<readonly [string, DbFunctions]> = [
  ['tenancy', tenancy], ['platform', platform], ['portfolio', portfolio], ['imports', imports], ['financials', financials], ['banking', banking], ['commercial', commercial], ['marketing', marketing], ['engagement', engagement], ['actions', actions], ['alerts', alerts], ['reporting', reporting], ['investment', investment], ['scenarios', scenarios], ['ai', ai], ['jobs', jobs],
];

function assertDisjoint(areas: typeof AREAS): DbFunctions {
  const out: Record<string, DbFunctions[string]> = {};
  for (const [area, fns] of areas) {
    for (const [name, fn] of Object.entries(fns)) {
      if (out[name]) throw new Error(`api.${name} is defined twice (again in ${area})`);
      out[name] = fn;
    }
  }
  return out;
}

export const API_FUNCTIONS: DbFunctions = assertDisjoint(AREAS);
