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
 * Added in Phase 8 (the two ends of the chain, ADR-096):
 *   * `getRecordProvenance` — one record's own history: is it still counted, which import brought
 *     it in, and which line of which file it is;
 *   * `getDocumentEvidence` — one file's reach: the imports it produced, the months they declare,
 *     and how many records rest on it.
 *
 * Every §5 producer now builds its bundle, and each is written where the write happens rather than
 * here — which is why no builder but the metric one is exported from this module:
 *   * health score — `modules/health/services/score-run.ts` (`evidenceFor`), written inside
 *     `api_server.finish_health` so the bundle and the score land in one transaction;
 *   * alert — `app.build_alert_bundle`, called by `api_server.persist_alerts` per revision;
 *   * AI response — `api_server.ai_persist_turn`, after grounding;
 *   * action — `app.clone_bundle_for_action`, which copies the source's items so an action's
 *     evidence is frozen even when the alert behind it is re-evaluated;
 *   * report — `api_server.record_report_file`.
 * None is stubbed: an empty function that returned a bundle id would look implemented.
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
  reconcileDifference,
  type DifferenceReconciliation,
  type DifferenceTermInput,
} from './domain/difference';

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
  type DrawerDifference,
  type DrawerDifferenceTerm,
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

export {
  RECORD_KINDS,
  RECORD_KIND_LABELS,
  getDocumentEvidence,
  getRecordProvenance,
  isRecordKind,
  mayOpenDocuments,
  type DocumentEvidence,
  type DocumentImport,
  type RecordImport,
  type RecordKind,
  type RecordProvenance,
  type RecordStanding,
} from './services/provenance';
