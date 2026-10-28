import 'server-only';
import type {
  CollectionReference, DocumentReference, Firestore, Query, Transaction,
} from 'firebase-admin/firestore';

/**
 * A working set: the in-memory copy of every document an import operation reads and changes
 * (FIRESTORE_DATA_MODEL.md §7).
 *
 * The SQL import functions are long sequences of statements, each reading what the one before it
 * wrote (`app.rerun_dedupe` flags rows that the commit loop then reads; the commit inserts
 * `pending` balances that the supersession loop then queries). A Firestore transaction cannot do
 * that — every read must come before the first write. So the port runs the SAME sequence against
 * this set instead: documents are loaded once (through the transaction, or plainly for a chunked
 * commit), every statement reads and writes the in-memory copy, and the final state of each changed
 * document becomes one write at the end (`writes()`).
 *
 * `query` keeps a query honest about what was changed in memory: it runs the Firestore query as a
 * superset filter, then also considers every document of that collection already in the set (an
 * inserted row, a row whose status changed), and applies the caller's exact predicate to the
 * CURRENT state — what a later SQL statement would have seen.
 */

export type Data = Record<string, unknown>;

export interface Loader {
  getAll(refs: DocumentReference[]): Promise<Array<Data | null>>;
  query(q: Query): Promise<Array<{ ref: DocumentReference; data: Data }>>;
}

export function txLoader(tx: Transaction): Loader {
  return {
    async getAll(refs) {
      if (refs.length === 0) return [];
      const snaps = await tx.getAll(...refs);
      return snaps.map((s) => (s.exists ? (s.data() as Data) : null));
    },
    async query(q) {
      const snap = await tx.get(q);
      return snap.docs.map((d) => ({ ref: d.ref, data: d.data() as Data }));
    },
  };
}

export function plainLoader(fs: Firestore): Loader {
  return {
    async getAll(refs) {
      if (refs.length === 0) return [];
      const out: Array<Data | null> = [];
      for (let i = 0; i < refs.length; i += 300) {
        const snaps = await fs.getAll(...refs.slice(i, i + 300));
        for (const s of snaps) out.push(s.exists ? (s.data() as Data) : null);
      }
      return out;
    },
    async query(q) {
      const snap = await q.get();
      return snap.docs.map((d) => ({ ref: d.ref, data: d.data() as Data }));
    },
  };
}

interface Entry {
  readonly ref: DocumentReference;
  readonly stored: Data | null;
  current: Data | null;
  dirty: boolean;
  /** Set or deleted (not merely updated): the write replaces the whole document. */
  replaced: boolean;
  /** The fields `update` changed, when the document is only updated. */
  patch: Data;
}

export interface PlannedWrite {
  readonly ref: DocumentReference;
  /** The document's final state; null deletes it. */
  readonly data: Data | null;
  /**
   * For a stored document that was only updated: just the changed fields, so the write is an
   * `update` of those (a row status, not the whole row with its raw data). Absent for a set/delete.
   */
  readonly patch?: Data;
}

export class WorkingSet {
  private readonly entries = new Map<string, Entry>();
  private readonly order: string[] = [];
  /** Superset queries already run: their documents are in the set and tracked from then on. */
  private readonly ran = new Set<string>();

  constructor(readonly fs: Firestore, private readonly loader: Loader) {}

  private remember(ref: DocumentReference, stored: Data | null): Entry {
    const existing = this.entries.get(ref.path);
    if (existing) return existing;
    const entry: Entry = { ref, stored, current: stored ? { ...stored } : null, dirty: false, replaced: false, patch: {} };
    this.entries.set(ref.path, entry);
    return entry;
  }

  /** Loads documents not yet in the set (one round trip); returns their CURRENT states. */
  async load(refs: DocumentReference[]): Promise<Array<Data | null>> {
    const missing = [...new Map(refs.filter((r) => !this.entries.has(r.path)).map((r) => [r.path, r])).values()];
    if (missing.length > 0) {
      const data = await this.loader.getAll(missing);
      missing.forEach((ref, i) => this.remember(ref, data[i] ?? null));
    }
    return refs.map((r) => this.entries.get(r.path)!.current);
  }

  async get(ref: DocumentReference): Promise<Data | null> {
    return (await this.load([ref]))[0] ?? null;
  }

  /** The current state of a document already in the set (undefined when it was never loaded). */
  peek(ref: DocumentReference): Data | null | undefined {
    const e = this.entries.get(ref.path);
    return e ? e.current : undefined;
  }

  /**
   * The documents of `collection` matching `keep` in their CURRENT state. `superset` is a Firestore
   * query on that collection that every matching stored document satisfies.
   */
  async query(collection: CollectionReference, superset: Query, keep: (d: Data) => boolean, memo?: string): Promise<Data[]> {
    // With `memo`, the same superset is read once: every later change to its documents is in memory.
    if (!memo || !this.ran.has(memo)) {
      const found = await this.loader.query(superset);
      for (const { ref, data } of found) this.remember(ref, data);
      if (memo) this.ran.add(memo);
    }
    const prefix = `${collection.path}/`;
    const out: Data[] = [];
    for (const path of this.entries.keys()) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
      const cur = this.entries.get(path)!.current;
      if (cur && keep(cur)) out.push(cur);
    }
    return out;
  }

  /** Every current document of `collection` already in the set that matches `keep` (no read). */
  inMemory(collection: CollectionReference, keep: (d: Data) => boolean): Data[] {
    const prefix = `${collection.path}/`;
    const out: Data[] = [];
    for (const [path, e] of this.entries) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
      if (e.current && keep(e.current)) out.push(e.current);
    }
    return out;
  }

  private touch(ref: DocumentReference): Entry {
    const e = this.entries.get(ref.path) ?? this.remember(ref, null);
    if (!e.dirty) {
      e.dirty = true;
      this.order.push(ref.path);
    }
    return e;
  }

  /** Creates or replaces a document. A document never loaded is treated as new. */
  set(ref: DocumentReference, data: Data): void {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) throw new Error(`refusing to store undefined in ${ref.path}.${k}`);
    }
    const e = this.touch(ref);
    e.current = { ...data };
    e.replaced = true;
  }

  /** Merges fields into a document that must be in the set and exist. */
  update(ref: DocumentReference, patch: Data): Data {
    const e = this.entries.get(ref.path);
    if (!e || !e.current) throw new Error(`update of a document not in the working set: ${ref.path}`);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) throw new Error(`refusing to store undefined in ${ref.path}.${k}`);
    }
    const t = this.touch(ref);
    t.current = { ...t.current!, ...patch };
    if (!t.replaced) t.patch = { ...t.patch, ...patch };
    return t.current;
  }

  delete(ref: DocumentReference): void {
    const e = this.touch(ref);
    e.current = null;
    e.replaced = true;
  }

  /** The final state of every changed document, in first-touched order. */
  writes(): PlannedWrite[] {
    const out: PlannedWrite[] = [];
    for (const path of this.order) {
      const e = this.entries.get(path)!;
      if (e.current === null && e.stored === null) continue;
      if (!e.replaced && e.stored !== null && e.current !== null) out.push({ ref: e.ref, data: e.current, patch: e.patch });
      else out.push({ ref: e.ref, data: e.current });
    }
    return out;
  }

  /** Applies `writes()` through a transaction (after every read). */
  apply(tx: Transaction): number {
    const writes = this.writes();
    for (const w of writes) {
      if (w.data === null) tx.delete(w.ref);
      else if (w.patch) tx.update(w.ref, w.patch);
      else tx.set(w.ref, w.data);
    }
    return writes.length;
  }

  /** An estimate of the write payload, so a caller can decide whether one transaction can hold it. */
  size(): { writes: number; bytes: number } {
    const writes = this.writes();
    let bytes = 0;
    for (const w of writes) bytes += w.ref.path.length + JSON.stringify(w.patch ?? w.data ?? null).length;
    return { writes: writes.length, bytes };
  }
}

/** Splits a list into chunks of at most `n` (Firestore `in` takes 30 values). */
export function chunks<T>(items: readonly T[], n = 30): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
