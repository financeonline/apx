/**
 * `modules/evidence` — the mechanism that makes every number on every screen inspectable
 * (EVIDENCE_MODEL.md; ADR-009, ADR-032.6, ADR-034, ADR-046.2, ADR-047.1).
 *
 * Built in plan Phase 4 slice 5 (the mechanism):
 *   * `QueryDescriptorV1` — the strict, versioned selection schema;
 *   * `descriptorHash` — RFC 8785 canonical JSON + sha256, stable across runs;
 *   * the descriptor compiler — an allow-list of columns per table, no string interpolation;
 *   * `resolveDescriptor` — as-of resolution from `record_status_events` and the history tables;
 *   * the read side of the §9 contract: `getBundle`, `resolveItem`, `resolveDerived`.
 *
 * Added in Phase 10 (the drawer):
 *   * `domain/labels.ts` — the server-generated item label, never taken from a model (R2-C-08);
 *   * `buildBundleForMetric` — materialises a metric's bundle on demand from its `evidence_query`;
 *   * `getDocumentReference` — the level-4 signed URL, minted only behind an audit row (ADR-038.1).
 *
 * Still deliberately absent, and where each lands:
 *   * `buildBundleForHealthScore` — EVIDENCE_MODEL.md §5 puts it at the health score write, which is
 *     Phase 8's engine path and was not built there; a health factor's "Why?" therefore opens the
 *     bundle of the metric behind it rather than a `health_score` bundle of its own;
 *   * `buildBundleForAlert` — exists, but in SQL: `app.build_alert_bundle`, called by
 *     `api_server.persist_alerts` inside the evaluation transaction (Phase 9);
 *   * `buildBundleForAiResponse` — needs grounding v2 and `ai_tool_calls` (Phase 11);
 *   * `cloneBundleForAction` — needs `actions` (Phase 12).
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
  minAssurance, weakestOf,
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

export { buildBundleForMetric } from './services/build-metric';

export {
  getDocumentReference,
  itemCanReachDocument,
  parseSourceRef,
  type DocumentReference,
} from './services/document';

export {
  currentSnapshotId,
  loadEvidenceDrawer,
  type DrawerComponent,
  type DrawerMetric,
  type DrawerPinned,
  type DrawerRecords,
  type EvidenceDrawerView,
} from './services/drawer';

export {
  accountLabel,
  calculationRunLabel,
  counterpartyLabel,
  invoiceLabel,
  metricSnapshotLabel,
  queryLabel,
} from './domain/labels';

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
