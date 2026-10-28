import { appendFileSync } from 'node:fs';
import { Query, Transaction } from 'firebase-admin/firestore';

/**
 * Records the shape of every query the suite sends to Firestore, for `scripts/firestore-indexes.ts`
 * (FIRESTORE_DATA_MODEL.md §11). Off unless FIRESTORE_QUERY_LOG names a file.
 *
 * Every query — a `get`, a `count`, a stream, one inside a transaction — is turned into the
 * structured query the server receives by `Query#toStructuredQuery`, so wrapping that one method
 * sees exactly what the server would have to index: the collection (or collection group), the
 * filters and the explicit order. Each line also names the first `src/` frame that ran it, so the
 * queries a test's own fixtures make (which never need an index in production) can be told apart.
 * The SDK builds the request after an `await` of its own, when the caller's frames are gone, so the
 * frame is taken where the caller asks — `get`, `stream`, `count`/`aggregate`, a transaction's
 * `get` — and carried on the query object.
 */

interface ProtoFilter {
  fieldFilter?: { field: { fieldPath: string }; op: string };
  unaryFilter?: { field: { fieldPath: string }; op: string };
  compositeFilter?: { op: string; filters: ProtoFilter[] };
}

interface StructuredQuery {
  from?: Array<{ collectionId?: string; allDescendants?: boolean }>;
  where?: ProtoFilter;
  orderBy?: Array<{ field: { fieldPath: string }; direction?: string }>;
}

export interface QueryShape {
  readonly collection: string;
  readonly group: boolean;
  readonly filters: ReadonlyArray<{ field: string; op: string }>;
  readonly orderBy: ReadonlyArray<{ field: string; direction: 'ASCENDING' | 'DESCENDING' }>;
  readonly or: boolean;
  /** The first application frame (`src/…:line`), or null when only test code ran the query. */
  readonly source: string | null;
}

function flatten(filter: ProtoFilter | undefined, out: Array<{ field: string; op: string }>): boolean {
  if (!filter) return false;
  if (filter.fieldFilter) out.push({ field: filter.fieldFilter.field.fieldPath, op: filter.fieldFilter.op });
  else if (filter.unaryFilter) out.push({ field: filter.unaryFilter.field.fieldPath, op: filter.unaryFilter.op });
  else if (filter.compositeFilter) {
    let or = filter.compositeFilter.op === 'OR';
    for (const f of filter.compositeFilter.filters) or = flatten(f, out) || or;
    return or;
  }
  return false;
}

function appFrame(stack: string | undefined): string | null {
  for (const line of (stack ?? '').split('\n')) {
    const m = /\(?(\/[^\s()]*\/src\/[^\s():]+):(\d+):\d+\)?$/.exec(line.trim());
    if (m && !m[1]!.includes('/node_modules/')) return `${m[1]!.slice(m[1]!.lastIndexOf('/src/') + 1)}:${m[2]}`;
  }
  return null;
}

type Tagged = { __apxSource?: string | null };
type Method = (...a: unknown[]) => unknown;

/** Wraps `name` on `proto` so the query it runs carries the caller's first application frame. */
function tagCaller(proto: Record<string, unknown>, name: string, queryOf: (self: unknown, args: unknown[]) => unknown): void {
  const original = proto[name] as Method;
  proto[name] = function (this: unknown, ...args: unknown[]) {
    const target = queryOf(this, args);
    if (target instanceof Query) (target as unknown as Tagged).__apxSource ??= appFrame(new Error().stack);
    return original.apply(this, args);
  };
}

export function startQueryLog(file: string): void {
  const proto = Query.prototype as unknown as { toStructuredQuery: (...a: unknown[]) => StructuredQuery; __apxLogged?: boolean };
  if (proto.__apxLogged) return;
  proto.__apxLogged = true;
  const queryProto = Query.prototype as unknown as Record<string, unknown>;
  tagCaller(queryProto, 'get', (self) => self);
  tagCaller(queryProto, 'stream', (self) => self);
  // A count is built from its query (`q.count()`), in the caller's frame; the SDK keeps the query.
  tagCaller(queryProto, 'count', (self) => self);
  tagCaller(queryProto, 'aggregate', (self) => self);
  tagCaller(Transaction.prototype as unknown as Record<string, unknown>, 'get', (_self, args) => args[0]);
  const original = proto.toStructuredQuery;
  proto.toStructuredQuery = function (this: unknown, ...a: unknown[]): StructuredQuery {
    const q = original.apply(this, a);
    try {
      const from = q.from?.[0] ?? {};
      const filters: Array<{ field: string; op: string }> = [];
      const or = flatten(q.where, filters);
      const shape: QueryShape = {
        collection: from.collectionId ?? '',
        group: Boolean(from.allDescendants),
        filters,
        orderBy: (q.orderBy ?? []).map((o) => ({
          field: o.field.fieldPath, direction: o.direction === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING',
        })),
        or,
        source: (this as Tagged).__apxSource ?? appFrame(new Error().stack),
      };
      appendFileSync(file, `${JSON.stringify(shape)}\n`);
    } catch {
      // Recording must never change what the suite does.
    }
    return q;
  };
}
