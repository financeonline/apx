/**
 * Builds `firebase/firestore.indexes.json` from the queries APX actually sends (FIRESTORE_DATA_MODEL.md §11).
 *
 *   FIRESTORE_QUERY_LOG=logs/firestore-queries.jsonl npm run test:integration
 *   npm run db:indexes -- logs/firestore-queries.jsonl [more logs…] [--check]
 *
 * The emulator runs any query; a real project refuses one that needs a composite index it does not
 * have. The integration suite records the shape of every query (`test/integration/query-log.ts`);
 * this script keeps those an application file ran (not a test's own fixtures) and works out, by
 * Firestore's rules, which need an index:
 *
 *  - equality filters alone (`==`, `in`, `array-contains`, `is null`) are served by the automatic
 *    single-field indexes, merged — no composite index;
 *  - one field ordered or ranged, and nothing else, is served by that field's single-field index;
 *  - anything else — an equality filter with an order or a range on another field, two ordered or
 *    ranged fields — needs a composite index: the equality fields first, then the order the server
 *    applies (the explicit `orderBy`, then any inequality field not already in it, by name);
 *  - a collection-GROUP query has no automatic single-field indexes at all, so each field it filters
 *    or orders on alone gets a field override that adds the group-scope index.
 *
 * Indexes already in the file are kept (one added by hand is never dropped). `--check` writes
 * nothing and exits 1 when the file lacks an index the log needs (for CI).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface QueryShape {
  readonly collection: string;
  readonly group: boolean;
  readonly filters: ReadonlyArray<{ field: string; op: string }>;
  readonly orderBy: ReadonlyArray<{ field: string; direction: 'ASCENDING' | 'DESCENDING' }>;
  readonly or?: boolean;
  readonly source: string | null;
}

type Scope = 'COLLECTION' | 'COLLECTION_GROUP';
export interface IndexField { fieldPath: string; order?: 'ASCENDING' | 'DESCENDING'; arrayConfig?: 'CONTAINS' }
export interface CompositeIndex { collectionGroup: string; queryScope: Scope; fields: IndexField[] }
export interface FieldOverride {
  collectionGroup: string;
  fieldPath: string;
  indexes: Array<{ order?: 'ASCENDING' | 'DESCENDING'; arrayConfig?: 'CONTAINS'; queryScope: Scope }>;
}
export interface IndexFile { indexes: CompositeIndex[]; fieldOverrides: FieldOverride[] }

const EQUALITY = new Set(['EQUAL', 'IN', 'IS_NULL', 'IS_NAN']);
const ARRAY = new Set(['ARRAY_CONTAINS', 'ARRAY_CONTAINS_ANY']);
const NAME = '__name__';

/** The composite index one query needs, or null when single-field indexes serve it. */
export function compositeFor(q: QueryShape): CompositeIndex | null {
  const equality = new Map<string, IndexField>();
  const inequality = new Set<string>();
  for (const f of q.filters) {
    if (f.field === NAME) continue;
    if (EQUALITY.has(f.op)) equality.set(f.field, { fieldPath: f.field, order: 'ASCENDING' });
    else if (ARRAY.has(f.op)) equality.set(f.field, { fieldPath: f.field, arrayConfig: 'CONTAINS' });
    else inequality.add(f.field);
  }
  // The order the server applies: the explicit order, then each inequality field not in it, by name.
  const explicit = q.orderBy.filter((o) => o.field !== NAME);
  const lastDirection = explicit.at(-1)?.direction ?? 'ASCENDING';
  const ordered: IndexField[] = explicit.map((o) => ({ fieldPath: o.field, order: o.direction }));
  for (const field of [...inequality].sort()) {
    if (!ordered.some((o) => o.fieldPath === field)) ordered.push({ fieldPath: field, order: lastDirection });
  }
  const leading = [...equality.values()]
    .filter((e) => !ordered.some((o) => o.fieldPath === e.fieldPath))
    .sort((a, b) => a.fieldPath.localeCompare(b.fieldPath));

  if (ordered.length === 0) return null; // equality only: merged single-field indexes
  if (ordered.length === 1 && leading.length === 0) return null; // one field ordered or ranged
  const fields = [...leading, ...ordered];
  // `__name__` ordered against the direction the last field gives it must be spelled out.
  const name = q.orderBy.find((o) => o.field === NAME);
  if (name && name.direction !== lastDirection) fields.push({ fieldPath: NAME, order: name.direction });
  return { collectionGroup: q.collection, queryScope: q.group ? 'COLLECTION_GROUP' : 'COLLECTION', fields };
}

/** The group-scope single-field indexes a collection-group query served by single fields needs. */
export function groupFieldsFor(q: QueryShape): Array<{ field: string; kind: 'ASCENDING' | 'DESCENDING' | 'CONTAINS' }> {
  if (!q.group || compositeFor(q) !== null) return [];
  const out: Array<{ field: string; kind: 'ASCENDING' | 'DESCENDING' | 'CONTAINS' }> = [];
  for (const f of q.filters) {
    if (f.field === NAME) continue;
    out.push({ field: f.field, kind: ARRAY.has(f.op) ? 'CONTAINS' : 'ASCENDING' });
  }
  for (const o of q.orderBy) if (o.field !== NAME) out.push({ field: o.field, kind: o.direction });
  return out;
}

const keyOf = (i: CompositeIndex): string =>
  JSON.stringify([i.collectionGroup, i.queryScope, i.fields.map((f) => [f.fieldPath, f.order ?? f.arrayConfig])]);

/** The index file the shapes need, merged into what is already there. */
export function indexPlan(shapes: readonly QueryShape[], existing: IndexFile = { indexes: [], fieldOverrides: [] }): {
  file: IndexFile; added: CompositeIndex[]; addedOverrides: string[]; orQueries: QueryShape[];
} {
  const app = shapes.filter((s) => s.source !== null && s.collection !== '');
  const byKey = new Map(existing.indexes.map((i) => [keyOf(i), i]));
  const added: CompositeIndex[] = [];
  for (const q of app) {
    const index = compositeFor(q);
    if (!index) continue;
    const k = keyOf(index);
    if (!byKey.has(k)) { byKey.set(k, index); added.push(index); }
  }

  const overrides = new Map(existing.fieldOverrides.map((o) => [`${o.collectionGroup}/${o.fieldPath}`, o]));
  const addedOverrides: string[] = [];
  for (const q of app) {
    for (const { field, kind } of groupFieldsFor(q)) {
      const k = `${q.collection}/${field}`;
      let o = overrides.get(k);
      if (!o) {
        // Listing a field's indexes replaces its defaults, so the collection-scope ones are restated.
        o = { collectionGroup: q.collection, fieldPath: field, indexes: [
          { order: 'ASCENDING', queryScope: 'COLLECTION' }, { order: 'DESCENDING', queryScope: 'COLLECTION' },
          { arrayConfig: 'CONTAINS', queryScope: 'COLLECTION' },
        ] };
        overrides.set(k, o);
      }
      const want = kind === 'CONTAINS'
        ? { arrayConfig: 'CONTAINS' as const, queryScope: 'COLLECTION_GROUP' as const }
        : { order: kind, queryScope: 'COLLECTION_GROUP' as const };
      if (!o.indexes.some((i) => i.queryScope === want.queryScope && i.order === want.order && i.arrayConfig === want.arrayConfig)) {
        o.indexes.push(want);
        addedOverrides.push(`${k} (${kind}, group)`);
      }
    }
  }

  const sortedIndexes = [...byKey.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const sortedOverrides = [...overrides.values()]
    .sort((a, b) => `${a.collectionGroup}/${a.fieldPath}`.localeCompare(`${b.collectionGroup}/${b.fieldPath}`));
  return {
    file: { indexes: sortedIndexes, fieldOverrides: sortedOverrides },
    added, addedOverrides, orQueries: app.filter((s) => s.or),
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const logs = args.filter((a) => !a.startsWith('--'));
  if (logs.length === 0) throw new Error('usage: firestore-indexes.ts <query log>… [--check]');
  const target = 'firebase/firestore.indexes.json';
  const existing = JSON.parse(readFileSync(target, 'utf8')) as IndexFile;
  const shapes = logs.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as QueryShape));
  const { file, added, addedOverrides, orQueries } = indexPlan(shapes, existing);
  console.log(`${shapes.length} queries read; ${file.indexes.length} composite indexes (${added.length} new), ${file.fieldOverrides.length} field overrides (${addedOverrides.length} new)`);
  for (const i of added) console.log(`  + ${i.collectionGroup} [${i.queryScope}] ${i.fields.map((f) => `${f.fieldPath} ${f.order ?? f.arrayConfig}`).join(', ')}`);
  for (const o of addedOverrides) console.log(`  + override ${o}`);
  if (orQueries.length > 0) console.log(`  ! ${orQueries.length} OR queries: check their indexes by hand (${[...new Set(orQueries.map((q) => q.source))].join(', ')})`);
  if (check) { if (added.length + addedOverrides.length > 0) process.exit(1); return; }
  writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
