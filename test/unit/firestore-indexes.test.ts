import { describe, expect, it } from 'vitest';
import { compositeFor, groupFieldsFor, indexPlan, type QueryShape } from '../../scripts/firestore-indexes';

/** The index rules of `scripts/firestore-indexes.ts` (FIRESTORE_DATA_MODEL.md §11), stated as cases. */

const q = (over: Partial<QueryShape>): QueryShape => ({
  collection: 'actions', group: false, filters: [], orderBy: [], source: 'src/db/x.ts:1', ...over,
});
const eq = (field: string) => ({ field, op: 'EQUAL' });
const asc = (field: string) => ({ field, direction: 'ASCENDING' as const });
const desc = (field: string) => ({ field, direction: 'DESCENDING' as const });

describe('which queries need a composite index', () => {
  it('equality filters alone never do (single-field indexes merge)', () => {
    expect(compositeFor(q({ filters: [eq('status'), eq('priority'), { field: 'id', op: 'IN' }] }))).toBeNull();
  });

  it('one field ordered or ranged, and nothing else, does not', () => {
    expect(compositeFor(q({ orderBy: [desc('created_at')] }))).toBeNull();
    expect(compositeFor(q({ filters: [{ field: 'due_date', op: 'LESS_THAN' }], orderBy: [asc('due_date')] }))).toBeNull();
  });

  it('an equality filter with an order on another field does: equality first, then the order', () => {
    expect(compositeFor(q({ filters: [eq('status')], orderBy: [desc('finished_at')] }))).toEqual({
      collectionGroup: 'actions', queryScope: 'COLLECTION',
      fields: [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'finished_at', order: 'DESCENDING' }],
    });
  });

  it('an inequality joins the order after the explicit fields, in the last direction', () => {
    expect(compositeFor(q({ filters: [eq('status'), { field: 'due_date', op: 'LESS_THAN' }], orderBy: [desc('priority')] }))?.fields)
      .toEqual([
        { fieldPath: 'status', order: 'ASCENDING' },
        { fieldPath: 'priority', order: 'DESCENDING' },
        { fieldPath: 'due_date', order: 'DESCENDING' },
      ]);
  });

  it('an array-contains filter is a CONTAINS field, and two orders need an index', () => {
    expect(compositeFor(q({ filters: [{ field: 'tags', op: 'ARRAY_CONTAINS' }], orderBy: [asc('title')] }))?.fields)
      .toEqual([{ fieldPath: 'tags', arrayConfig: 'CONTAINS' }, { fieldPath: 'title', order: 'ASCENDING' }]);
    expect(compositeFor(q({ orderBy: [asc('a'), desc('b')] }))?.fields).toHaveLength(2);
  });

  it('a tie-break on the document id is implicit unless it runs against the last direction', () => {
    expect(compositeFor(q({ filters: [eq('status')], orderBy: [desc('at'), desc('__name__')] }))?.fields)
      .toEqual([{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'at', order: 'DESCENDING' }]);
    expect(compositeFor(q({ filters: [eq('status')], orderBy: [desc('at'), asc('__name__')] }))?.fields.at(-1))
      .toEqual({ fieldPath: '__name__', order: 'ASCENDING' });
  });
});

describe('collection-group queries', () => {
  it('need a group-scope single-field index for each field they use alone', () => {
    expect(groupFieldsFor(q({ group: true, filters: [eq('organization_id'), eq('status')] })))
      .toEqual([{ field: 'organization_id', kind: 'ASCENDING' }, { field: 'status', kind: 'ASCENDING' }]);
    expect(groupFieldsFor(q({ group: false, filters: [eq('status')] }))).toEqual([]);
  });

  it('and a composite one, group-scoped, when they combine', () => {
    expect(compositeFor(q({ group: true, filters: [eq('status')], orderBy: [asc('at')] }))?.queryScope).toBe('COLLECTION_GROUP');
  });
});

describe('the plan', () => {
  it('ignores queries only test code ran, de-duplicates, and keeps what the file already had', () => {
    const kept = { collectionGroup: 'jobs', queryScope: 'COLLECTION' as const, fields: [{ fieldPath: 'a', order: 'ASCENDING' as const }, { fieldPath: 'b', order: 'ASCENDING' as const }] };
    const shape = q({ filters: [eq('status')], orderBy: [desc('finished_at')] });
    const plan = indexPlan([shape, shape, { ...shape, collection: 'alerts', source: null }], { indexes: [kept], fieldOverrides: [] });
    expect(plan.added).toHaveLength(1);
    expect(plan.file.indexes).toHaveLength(2);
    expect(plan.file.indexes.some((i) => i.collectionGroup === 'alerts')).toBe(false);
  });

  it('restates the collection-scope defaults when it adds a field override', () => {
    const plan = indexPlan([q({ group: true, collection: 'actions', filters: [eq('status')] })]);
    expect(plan.file.fieldOverrides).toEqual([{
      collectionGroup: 'actions', fieldPath: 'status', indexes: [
        { order: 'ASCENDING', queryScope: 'COLLECTION' }, { order: 'DESCENDING', queryScope: 'COLLECTION' },
        { arrayConfig: 'CONTAINS', queryScope: 'COLLECTION' }, { order: 'ASCENDING', queryScope: 'COLLECTION_GROUP' },
      ],
    }]);
  });
});
