import 'server-only';
import type { DbFunctions } from '../registry';
import { functions as access } from './access';
import { functions as engine } from './engine';
import { functions as jobs } from './jobs';
import { functions as imports } from './imports';
import { functions as ai } from './ai';
import { functions as reporting } from './reporting';
import { functions as marketing } from './marketing';
import { functions as purge } from './purge';

/**
 * Every `api_server.*` function: facts only the server may record (ADR-043).
 *
 * One file per area; each exports its functions under their SQL names. A name defined twice is a
 * merge mistake, so `assertDisjoint` fails the server at start-up rather than letting one silently win.
 */
const AREAS: ReadonlyArray<readonly [string, DbFunctions]> = [
  ['access', access], ['engine', engine], ['jobs', jobs], ['imports', imports], ['ai', ai], ['reporting', reporting], ['marketing', marketing], ['purge', purge],
];

function assertDisjoint(areas: typeof AREAS): DbFunctions {
  const out: Record<string, DbFunctions[string]> = {};
  for (const [area, fns] of areas) {
    for (const [name, fn] of Object.entries(fns)) {
      if (out[name]) throw new Error(`api_server.${name} is defined twice (again in ${area})`);
      out[name] = fn;
    }
  }
  return out;
}

export const SERVER_FUNCTIONS: DbFunctions = assertDisjoint(AREAS);
