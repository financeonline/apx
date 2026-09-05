/**
 * `modules/evidence` — the mechanism that makes every number on every screen inspectable
 * (EVIDENCE_MODEL.md; ADR-009, ADR-032.6, ADR-034, ADR-046.2, ADR-047.1).
 *
 * What this phase delivers (plan Phase 4 slice 5):
 *   * `QueryDescriptorV1` — the strict, versioned selection schema;
 *   * `descriptorHash` — RFC 8785 canonical JSON + sha256, stable across runs;
 *   * the descriptor compiler — an allow-list of columns per table, no string interpolation;
 *   * `resolveDescriptor` — as-of resolution from `record_status_events` and the history tables;
 *   * the read side of the §9 contract: `getBundle`, `resolveItem`, `resolveDerived`.
 *
 * What it deliberately does NOT deliver, and where it lands instead:
 *   * `buildBundleForMetric`   — needs the calculation engine that writes `evidence_query` (Phase 6);
 *   * `buildBundleForHealthScore` — needs the health engine (Phase 8);
 *   * `buildBundleForAlert`    — needs `alerts.evaluate` and the rule catalogue (Phase 9);
 *   * `buildBundleForAiResponse` — needs grounding v2 and `ai_tool_calls` (Phase 11);
 *   * `cloneBundleForAction`   — needs `actions` (Phase 12);
 *   * `getDocumentReference` and `domain/labels.ts` — the drawer and the signed-URL/audit path
 *     (Phase 10, ADR-038.1).
 * None of them is stubbed here: an empty function that returned a bundle id would look implemented.
 */

export {
  DESCRIPTOR_TABLES,
  DESCRIPTOR_DIRECTIONS,
  DIMENSION_TYPES,
  ID_ARRAY_FILTER_KEYS,
  INVOICE_TYPES,
  MAX_DESCRIPTOR_LIMIT,
  TERMINAL_ORDER,
  EvidenceQuerySchema,
  QueryDescriptorV1Schema,
  parseQueryDescriptor,
  withTerminalOrder,
  type DescriptorAsOf,
  type DescriptorDirection,
  type DescriptorFilterKey,
  type DescriptorFilters,
  type DescriptorOrderEntry,
  type DescriptorTable,
  type EvidenceQuery,
  type QueryDescriptorV1,
} from './domain/descriptor';

export {
  canonicalDescriptorJson,
  canonicaliseDescriptor,
  descriptorHash,
  descriptorHashLiteral,
} from './domain/canonical';

export {
  ASSURANCE_LEVELS,
  isAssuranceLevel,
  minAssurance,
  type AssuranceLevel,
} from './domain/assurance';

export {
  RECORD_STATUS_EVENTS,
  foldRecordStatusEvents,
  isVisibleAtInstant,
  selectVisibleRecordIds,
  valueInForceAt,
  type AsOfRecordState,
  type HistoryInterval,
  type RecordStatusEvent,
  type RecordStatusEventName,
} from './domain/as-of';

export {
  DEFAULT_DESCRIPTOR_LIMIT,
  compileDescriptor,
  type CompiledFilter,
  type CompiledOrder,
  type CompiledQuery,
  type FilterOp,
  type PostFilter,
} from './data/descriptor-compiler';

export {
  ITEM_TYPE_TABLE,
  type EvidenceItemType,
  type PinnedItemType,
} from './data/bundles';

export {
  resolveDescriptor,
  type Cursor,
  type RecordView,
  type ResolvedSelection,
} from './services/resolve';

export {
  getBundle,
  resolveDerived,
  resolveItem,
  type DerivedComponentView,
  type EvidenceBundleView,
  type EvidenceItemView,
  type EvidenceRefView,
  type ResolvedItem,
} from './services/bundle';
