import 'server-only';
import type {
  DocumentData, DocumentReference, DocumentSnapshot, Firestore, Transaction,
} from 'firebase-admin/firestore';
import { raise } from '../raise';
import { orgRow, type OrgTable } from '../schema';

/**
 * Write plumbing the engine's run functions share (FIRESTORE_DATA_MODEL.md §7).
 *
 * A chunk of a calculation writes thousands of documents, more than one transaction holds, so the
 * engine writes through a `WritePlan`: every write keyed by its document path, the LAST write to a
 * path winning (a delete followed by a set of the same cell is one set — which is also what keeps a
 * pointer from ever being absent between the two), committed in batches of `CHUNK` writes.
 */

/** Writes per batch: under Firestore's per-commit limit, with room for the caller's own. */
export const CHUNK = 400;

type Op =
  | { readonly kind: 'set'; readonly ref: DocumentReference; readonly data: DocumentData }
  | { readonly kind: 'update'; readonly ref: DocumentReference; readonly data: DocumentData }
  | { readonly kind: 'delete'; readonly ref: DocumentReference };

export class WritePlan {
  private readonly ops = new Map<string, Op>();

  set(ref: DocumentReference, data: DocumentData): void {
    this.ops.set(ref.path, { kind: 'set', ref, data });
  }

  /** A partial update; folded into an earlier set of the same document. */
  update(ref: DocumentReference, data: DocumentData): void {
    const prior = this.ops.get(ref.path);
    if (prior?.kind === 'set') this.ops.set(ref.path, { kind: 'set', ref, data: { ...prior.data, ...data } });
    else if (prior?.kind === 'update') this.ops.set(ref.path, { kind: 'update', ref, data: { ...prior.data, ...data } });
    else this.ops.set(ref.path, { kind: 'update', ref, data });
  }

  delete(ref: DocumentReference): void {
    this.ops.set(ref.path, { kind: 'delete', ref });
  }

  has(ref: DocumentReference): boolean {
    return this.ops.has(ref.path);
  }

  /** True when the plan's last write to `ref` is a set. */
  isSet(ref: DocumentReference): boolean {
    return this.ops.get(ref.path)?.kind === 'set';
  }

  get size(): number {
    return this.ops.size;
  }

  /** Applies every write to one transaction (the caller has done all its reads). */
  applyTo(tx: Transaction): void {
    for (const op of this.ops.values()) {
      if (op.kind === 'set') tx.set(op.ref, op.data);
      else if (op.kind === 'update') tx.update(op.ref, op.data);
      else tx.delete(op.ref);
    }
  }

  /** Commits in batches of `CHUNK`, in insertion order. Not atomic across batches. */
  async commit(fs: Firestore): Promise<void> {
    const all = [...this.ops.values()];
    for (let i = 0; i < all.length; i += CHUNK) {
      const batch = fs.batch();
      for (const op of all.slice(i, i + CHUNK)) {
        if (op.kind === 'set') batch.set(op.ref, op.data);
        else if (op.kind === 'update') batch.update(op.ref, op.data);
        else batch.delete(op.ref);
      }
      await batch.commit();
    }
  }
}

/** `fs.getAll` in slices, preserving order. */
export async function getAllChunked(
  fs: Firestore, refs: readonly DocumentReference[], tx?: Transaction,
): Promise<DocumentSnapshot[]> {
  const out: DocumentSnapshot[] = [];
  for (let i = 0; i < refs.length; i += 300) {
    const slice = refs.slice(i, i + 300);
    if (slice.length === 0) continue;
    out.push(...(tx ? await tx.getAll(...slice) : await fs.getAll(...slice)));
  }
  return out;
}

/** A jsonb value as PostgreSQL would hold it: `undefined` members dropped, as `to_jsonb` drops nothing it never saw. */
export function jsonb<T = unknown>(value: unknown): T {
  return (value === undefined ? null : JSON.parse(JSON.stringify(value))) as T;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `x::uuid`: lower-cased, or the cast's own refusal. Null and '' stay null. */
export function uuidOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value);
  if (!UUID.test(s)) raise.invalid(`invalid input syntax for type uuid: "${s}"`);
  return s.toLowerCase();
}

/** `decode(x, 'hex')`, stored as lowercase hex without the `\x` prefix. */
export function hexOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/^\\x/i, '');
  if (!/^(?:[0-9a-f]{2})*$/i.test(s)) raise.invalid('invalid hexadecimal data');
  return s.toLowerCase();
}

/**
 * `app.same_org_ref(id_col, disc_col, value → table …)`: the id a row names must exist in the same
 * organisation's table its discriminator maps to; a discriminator mapped to '-' names no row, so the
 * id must be null; an unmapped value is a configuration mistake, not a pass. Organisation-scoped
 * collections make "another organization's row" unresolvable, so existence is the whole check.
 *
 * `rows` are checked together: one batched read per distinct id.
 */
export async function checkSameOrgRef(
  fs: Firestore,
  orgId: string,
  table: string,
  idCol: string,
  discCol: string,
  mapping: Readonly<Record<string, OrgTable | '-'>>,
  rows: ReadonlyArray<Record<string, unknown>>,
  tx?: Transaction,
): Promise<void> {
  const wanted = new Map<string, DocumentReference>();
  for (const row of rows) {
    const id = row[idCol] as string | null;
    const disc = row[discCol] as string | null;
    if (disc === null || disc === undefined) {
      if (id) raise.invalid(`${table}.${idCol} is set although ${table}.${discCol} is null`);
      continue;
    }
    const target = mapping[disc];
    if (target === undefined) {
      raise.invalid(`${table}.${discCol} = ${disc} has no table mapping on ${table}; add it to the same_org_ref trigger ('-' if it names no table)`);
    }
    if (target === '-') {
      if (id) raise.invalid(`${table}.${idCol} is set although ${table}.${discCol} = ${disc} names no table`);
      continue;
    }
    if (!id) continue;
    const ref = orgRow(fs, orgId, target, id);
    wanted.set(ref.path, ref);
  }
  const snaps = await getAllChunked(fs, [...wanted.values()], tx);
  if (snaps.some((s) => !s.exists)) raise.invalid(`${table}.${idCol} references a row that does not exist`);
}

/** A foreign key to a row of the same organisation: it must exist. */
export function missingReference(table: string, column: string): never {
  return raise.invalid(`${table}.${column} references a row that does not exist`);
}
