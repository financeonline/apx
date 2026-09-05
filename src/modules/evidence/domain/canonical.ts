import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { InternalError } from '@/core/errors';
import type { DescriptorFilters, QueryDescriptorV1 } from './descriptor';

/**
 * `descriptor_hash` (EVIDENCE_MODEL.md §3, ADR-046.2).
 *
 *   descriptor_hash = sha256( RFC 8785 (JCS) canonical JSON of the descriptor,
 *                             with every id array sorted ascending as strings )
 *
 * Two things make that hash stable, and both are needed:
 *
 *  * **JCS** fixes object key order, number formatting and string escaping, so the same descriptor
 *    serialised by two different code paths produces the same bytes. We use the reference
 *    implementation (`canonicalize`, by a co-author of RFC 8785) rather than a hand-rolled
 *    `JSON.stringify` — key sorting is by UTF-16 code unit and the number rules are the ES6
 *    `Number::toString` rules, both easy to get subtly wrong.
 *  * **Sorted id arrays**, because the engine resolves account and period ids from a query whose
 *    row order is not guaranteed. The engine sorts the same way before writing a descriptor, so two
 *    runs over identical data produce byte-identical hashes (§11, R2-C-12 test list).
 *
 * The hash is stored as `bytea` on `evidence_items.descriptor_hash` and exposed to tool outputs and
 * the AI contract as lower-case hex; an AI `query` reference is accepted only when its hex hash
 * matches a descriptor a tool returned in the same turn (§5).
 *
 * This module is pure: no clock, no I/O, no database.
 */

/** Ascending by UTF-16 code unit — the same ordering JCS uses for object keys. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedCopy(values: readonly string[] | undefined): string[] | undefined {
  return values === undefined ? undefined : [...values].sort(byCodeUnit);
}

/**
 * The descriptor with its id arrays sorted. Written out key by key rather than by looping over
 * `ID_ARRAY_FILTER_KEYS` so that adding a filter to the schema without deciding whether it is an
 * id array is a type error here rather than a silent hash difference later.
 */
function withSortedIdArrays(filters: DescriptorFilters): DescriptorFilters {
  const out: DescriptorFilters = { ...filters };
  if (out.period_ids !== undefined) out.period_ids = sortedCopy(out.period_ids);
  if (out.account_ids !== undefined) out.account_ids = sortedCopy(out.account_ids);
  if (out.counterparty_ids !== undefined) out.counterparty_ids = sortedCopy(out.counterparty_ids);
  if (out.bank_account_ids !== undefined) out.bank_account_ids = sortedCopy(out.bank_account_ids);
  if (out.category_account_ids !== undefined) {
    out.category_account_ids = sortedCopy(out.category_account_ids);
  }
  if (out.invoice_types !== undefined) {
    out.invoice_types = sortedCopy(out.invoice_types) as DescriptorFilters['invoice_types'];
  }
  return out;
}

/** The descriptor in the form that gets hashed. Exported so tests and tools can inspect it. */
export function canonicaliseDescriptor(descriptor: QueryDescriptorV1): QueryDescriptorV1 {
  return { ...descriptor, filters: withSortedIdArrays(descriptor.filters) };
}

/** The RFC 8785 canonical JSON string of a descriptor. */
export function canonicalDescriptorJson(descriptor: QueryDescriptorV1): string {
  const json = canonicalize(canonicaliseDescriptor(descriptor));
  if (typeof json !== 'string') {
    // canonicalize() returns undefined only for `undefined` input, which a parsed descriptor can
    // never be. Failing loudly beats hashing the string "undefined".
    throw new InternalError('The evidence descriptor could not be canonicalised.');
  }
  return json;
}

/** `descriptor_hash` as lower-case hex, the form used in tool outputs and the AI contract (§3). */
export function descriptorHash(descriptor: QueryDescriptorV1): string {
  return createHash('sha256').update(canonicalDescriptorJson(descriptor), 'utf8').digest('hex');
}

/**
 * The same hash in the PostgREST/`bytea` literal form (`\xdeadbeef`), for the `api.*` functions that
 * will write `evidence_items.descriptor_hash`. The bundle *builders* land in later phases
 * (Phase 6 for the engine, Phase 9 for alerts, Phase 11 for AI); this helper is the piece of that
 * write path that belongs to the descriptor itself.
 */
export function descriptorHashLiteral(descriptor: QueryDescriptorV1): string {
  return `\\x${descriptorHash(descriptor)}`;
}
