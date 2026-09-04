# MOTION — Evidence & Traceability Model

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-008, ADR-009, ADR-010, ADR-016), `DATABASE_ARCHITECTURE.md §6`, `FINANCIAL_ENGINE.md`, `RBAC_MATRIX.md`
Consumed by: `AI_ARCHITECTURE.md`, `UX_ARCHITECTURE.md`, `SERVICE_ARCHITECTURE.md`, `TEST_STRATEGY.md`
Module home: `src/modules/evidence`

---

## 1. Purpose

SOW §12: a user must be able to move from an AI statement to the calculation and then to the underlying records and source document. SOW §11: material AI conclusions must be traceable to evidence. The evidence model is the one mechanism that makes every number on every screen inspectable, and it is what stops the AI from asserting anything it cannot point at.

The chain, as objects:

```
AI statement / alert / health factor / dashboard figure
  → metric_snapshots row            (value, basis, components, engine_version)
    → calculation_runs row           (engine version, fingerprint, period range)
      → records: ledger_entries | bank_transactions | invoices | period_balances
        → import_rows (raw row, mapping, review decision)
          → source_documents (file, page/sheet, row/line reference)
```

Every link in that chain is a foreign key or a deterministic query; none is free text.

---

## 2. Schema (canonical definitions in `DATABASE_ARCHITECTURE.md §6`)

### 2.1 `evidence_bundles`
One bundle per material claim-set: a metric, an alert, a health dimension, an AI response, an action, a report section. Fields: `id`, `organization_id`, `kind ∈ {metric, alert, ai_response, health_score, action, report}`, `origin_table`, `origin_id`, `calculation_run_id` (the as-of run), `created_by_type ∈ {system, ai, user}`, `created_by`, `created_at`. Bundles are immutable after creation (§8).

### 2.2 `evidence_items`
Ordered members of a bundle. Fields: `id`, `organization_id`, `bundle_id`, `sort_order`, `item_type`, `ref_id`, `query_descriptor`, `label`, `claim`, `assurance_level`. Exactly one of `ref_id` / `query_descriptor` is set (`evidence_item_xor` trigger).

| `item_type` | `ref_id` points at | Used for |
|---|---|---|
| `metric_snapshot` | `metric_snapshots.id` | any cited number |
| `calculation_run` | `calculation_runs.id` | "as of" context |
| `ledger_entry` / `bank_transaction` / `invoice` / `period_balance` | the record | pinned drivers, duplicates, anomalies |
| `counterparty` / `account` / `fiscal_period` | the entity | subject of a claim |
| `source_document` | `source_documents.id` | direct document citation (page in `label`) |
| `query` | — (uses `query_descriptor`) | aggregate evidence: "all marketing entries in March" |

`claim` is the sentence the item supports (for AI bundles, the Key Finding text; for alerts, the explanation; for metrics, NULL). `label` is the short human string shown in the drawer ("Revenue, Mar 2026 — from trial balance", "Invoice INV-1042, Acme Ltd, £4,200").

### 2.3 JSON shapes

```ts
type EvidenceItemView = {
  id: string; itemType: ItemType; label: string; claim: string | null;
  assurance: 'verified' | 'calculated' | 'estimated' | 'inferred';
  ref?: { table: string; id: string; superseded: boolean; recordStatus: string };
  query?: QueryDescriptor;                     // §3
  resolved?: { count: number; total?: string; sample: Record<string, unknown>[] }; // filled by resolver
};
type EvidenceBundleView = {
  id: string; kind: BundleKind; origin: { table: string; id: string };
  asOf: { calculationRunId: string; engineVersion: string; finishedAt: string };
  items: EvidenceItemView[];
  assurance: Assurance;                        // min over items (§7)
};
```

---

## 3. Query descriptor

A `query_descriptor` is a declarative, versioned selection that the resolver re-executes under RLS. It never contains SQL, never contains an `organization_id` (implied by the bundle's organization), and never selects across tables.

```json
{
  "v": 1,
  "table": "ledger_entries | bank_transactions | invoices | period_balances | metric_snapshots",
  "filters": {
    "period_ids": ["uuid"],
    "standard_categories": ["marketing"],
    "account_ids": ["uuid"],
    "counterparty_ids": ["uuid"],
    "bank_account_ids": ["uuid"],
    "invoice_types": ["sales", "sales_credit_note"],
    "direction": "debit | credit | inflow | outflow",
    "is_transfer": false,
    "open_as_of": "2026-03-31",
    "overdue_as_of": "2026-03-31",
    "metric_keys": ["revenue"],
    "dimension": { "type": "counterparty", "id": "uuid" },
    "record_status": "accepted"
  },
  "as_of": { "calculation_run_id": "uuid" },
  "order": [{ "field": "amount", "dir": "desc" }, { "field": "id", "dir": "asc" }],
  "limit": 500
}
```

Rules:
- `record_status` is always `accepted` for record tables; the resolver additionally applies `superseded_by IS NULL` **unless** `as_of` is set, in which case it includes records that were accepted and non-superseded at `calculation_runs.finished_at` (using `created_at`/`updated_at` and `superseded_by` timestamps), so old evidence still resolves to what the run saw.
- `order` always ends with `id asc` so pagination is deterministic.
- `limit` ≤ 1,000; the resolver also returns `count` and `total` (Σ amount) over the *whole* selection so a truncated list still reconciles to the metric.
- Unknown keys or an unknown `v` fail validation (Zod schema `QueryDescriptorV1`), never a best-effort query.
- Descriptors are produced only by engine code (`FINANCIAL_ENGINE.md §3` "Evidence" column) and alert rules — never by the AI and never from user input.

### 3.1 Resolver service

```ts
resolveDescriptor(ctx: AccessContext, d: QueryDescriptor, page?: Cursor)
  → { rows: RecordView[]; count: number; total: Decimal | null; nextCursor?: Cursor }
```
- Runs with the caller's user-scoped Supabase client (RLS applies; ADR-013). The bundle's `organization_id` must equal `ctx.orgId` or the call fails with `NotFound`.
- Compiles filters into a fixed query-builder mapping (`data/descriptor-compiler.ts`) — an allow-list of columns per table; no string interpolation.
- Deterministic: same descriptor + same `as_of` ⇒ same rows in same order (tested).

---

## 4. Pinned records vs descriptors (ADR-009)

| Use a **pinned** item (`ref_id`) when | Use a **descriptor** when |
|---|---|
| The claim is about specific records (duplicate pair, unusual payment, the top-5 drivers, an overdue invoice) | The claim is an aggregate (revenue for a period, marketing spend, all overdue invoices) |
| The reader must see *that* row even if data later changes | The reader must see the *set* that produced the number as of the run |
| AI cites a record returned by `get_transactions_for_evidence` | AI cites a metric returned by `get_metric` (the item pins the snapshot, and the snapshot carries the descriptor) |

A bundle usually mixes both: alerts pin drivers and carry the aggregate descriptor; AI answers pin snapshots and records.

---

## 5. How each producer builds a bundle

| Producer | When | Bundle `kind` | Items |
|---|---|---|---|
| **Metric snapshot** | at calculation run write | none — the snapshot *is* the evidence root: `metric_snapshots.evidence_query` holds its descriptor and `components` its inputs. `buildBundleForMetric(snapshotId)` materialises a bundle on demand (for the drawer or an action) with: the snapshot, its `calculation_run`, one `query` item per input descriptor (derived metrics get one per component), and for dimension metrics the `counterparty`/`account` item. | |
| **Alert** | at `alerts.evaluate` upsert | `alert` | pinned records listed in the rule's "Evidence pinned" column (`FINANCIAL_ENGINE.md §8.2`), the triggering `metric_snapshot`(s), the comparison snapshot, the `query` descriptor for the aggregate, the `fiscal_period`. Regenerated on each re-evaluation as a **new** bundle; the alert points at the latest, older bundles remain (immutability). |
| **Health dimension** | at health score write | `health_score` | one bundle per score row: `metric_snapshot` items for every metric in `breakdown[].metrics`, `calculation_run`. Positive/negative factors reference snapshot ids inside `breakdown`. |
| **AI response** | after grounding passes (`AI_ARCHITECTURE.md`) | `ai_response` | one bundle per assistant message. Items are built **only from tool-call outputs recorded in `ai_tool_calls`**: every `metric_snapshot` id, record id and descriptor the tools returned that the response's structured `evidence[]` references. Each Key Finding must reference ≥1 item; the item's `claim` is the finding text. The builder rejects any id not present in that turn's tool outputs — model text can never introduce an item. |
| **Action** | at action creation | `action` | inherits: the source's bundle items are *copied* into a new bundle (`origin_table = actions`), so the action's evidence is frozen even if the alert is re-evaluated. Manual actions may have an empty bundle. |
| **Report** (MVP: Monthly Management Report) | at render | `report` | metric snapshots and alert bundles referenced by the report, one bundle per report. |

### 5.1 Summary-level data
For `period_balances`-based metrics the record item is the `period_balance` row; its `import_row_id → import_rows.source_ref` gives the sheet/row or page/line, and `source_document_id` the file. The drawer shows: metric → "Trial balance, Mar 2026, account 4000 Sales: movement £120,000" → document page. There is no transaction level for summary data; the records table shows the TB rows instead and says so ("This figure comes from a trial balance, so individual transactions are not available").

---

## 6. Evidence Drawer — UI contract (`UX_ARCHITECTURE.md` owns the visual design)

The drawer opens from any evidence affordance (the "ⓘ Why?" on a figure, "Show evidence" on an alert/AI finding/health factor) and presents levels the user can descend, never all at once:

| Level | Content | Data source |
|---|---|---|
| 0 Statement | the claim text, assurance badge, as-of date | bundle |
| 1 Metric card | metric label, value, period, basis label ("from trial balance"), data-quality warnings in plain words | `metric_snapshot` item |
| 2 Calculation | formula in words ("Gross profit = Revenue − Cost of sales"), each component with value and its own basis, engine version, run time | `snapshot.components`, registry definition |
| 3 Records | paginated table from the descriptor or the pinned rows: date, description, counterparty, account/category, amount, status badge (`superseded`/`accepted`), `count` and `total` reconciling to the metric | resolver |
| 4 Document | source document viewer with page and highlighted row/line from `import_rows.source_ref`; download button (permission-gated) | signed URL (60 s) |

Behaviour rules: level 3 shows `total` next to the metric value and a visible reconciliation ("500 of 1,238 rows shown; all rows total £120,000.00 = metric"); superseded records show a badge and a link to the replacement; a level the role cannot open shows the friendly denied state rather than an empty panel.

---

## 7. Assurance propagation

- Each item carries `assurance_level` copied from its target (`metric_snapshots.assurance_level`, record `assurance_level`; descriptor items take the *minimum* assurance over the resolved set, computed at build time and stored).
- Bundle assurance = min over items in order `verified > calculated > estimated > inferred`.
- A claim's badge is its bundle assurance. The AI response contract labels each finding with this badge; a finding backed by an `inferred` record (Claude-extracted PDF row) is shown as "inferred — needs review" even if the arithmetic is exact.
- Data-quality warnings on any cited snapshot are surfaced at level 1 and echoed in the AI's Confidence section.

---

## 8. Integrity rules

1. **Immutable bundles.** No UPDATE/DELETE policy on `evidence_bundles`/`evidence_items` for `authenticated`; producers always create new bundles and repoint the origin.
2. **Snapshot ids, not values.** Items reference `metric_snapshots.id`; recalculation writes new snapshots and flips `is_current`, so an old bundle keeps resolving to the exact numbers that were shown. The drawer shows "This figure has since been recalculated — current value £X" when the referenced snapshot is not current.
3. **Superseded records resolve.** Pinned `ref_id` rows that are later superseded or rejected are still fetched (the resolver does not filter pinned items by status) and shown with a `superseded`/`rejected` badge and the replacement link.
4. **Cross-organization references are impossible.** `evidence_items.organization_id` must equal the bundle's; composite FKs `(organization_id, ref_id)` are enforced for every `ref` table; the resolver rejects a bundle whose organization ≠ `ctx.orgId`.
5. **Producers only.** Only `src/modules/evidence/services/build-*.ts` write bundles; the AI module calls `buildBundleForAiResponse` with tool-output ids and receives validation errors for anything else.
6. **No orphan claims.** A Key Finding or alert whose bundle would be empty is **downgraded**: alerts are not created (rule outcome dropped with an audit note), AI findings are moved out of Key Findings into the Confidence section as "Unsupported: {text}" and are never shown as facts (`AI_ARCHITECTURE.md` grounding).

---

## 9. Service contract sketches (`src/modules/evidence/index.ts`)

```ts
getBundle(ctx, bundleId): Promise<EvidenceBundleView>            // items unresolved, plus assurance
resolveItem(ctx, itemId, page?): Promise<ResolvedItem>            // pinned → record view; query → resolver rows
buildBundleForMetric(ctx, snapshotId): Promise<BundleId>           // on demand, cached by (snapshotId)
buildBundleForAlert(orgScope, alertDraft): Promise<BundleId>       // called by alerts.evaluate (service role, withOrgScope)
buildBundleForHealthScore(orgScope, healthScoreId): Promise<BundleId>
buildBundleForAiResponse(ctx, { messageId, toolOutputs, findings }): Promise<BundleId> // validates ids ⊆ toolOutputs
cloneBundleForAction(ctx, sourceBundleId, actionId): Promise<BundleId>
getDocumentReference(ctx, recordRef): Promise<{ documentId, page?, sheet?, row?, signedUrl? }> // signedUrl only if documents.view
```

All read functions take `AccessContext` and go through RLS; the two `orgScope` builders run inside jobs with `withOrgScope` (ADR-013).

---

## 10. Permissions (from `RBAC_MATRIX.md`)

| Level | super_admin | employee | owner | admin | client |
|---|---|---|---|---|---|
| 0–2 statement, metric, calculation | ✓ | ✓ | ✓ | ✓ | ✓ (`financials.view`) |
| 3 records | ✓ | ✓ | ✓ | ✓ | ✓ |
| 4 document view/download | ✓ | ✓ | ✓ | ✓ | ✗ (`documents.view`); shows "Ask an admin for the source file" |

Every level-4 open writes `audit_events` `document.viewed` / `document.downloaded`. Super-admin opens under `/app/*` also write `org.data_viewed` (CD-13).

---

## 11. Testing (`TEST_STRATEGY.md §8`)

- Every bundle produced by the golden organizations resolves: no item returns 404, every descriptor validates, every `total` equals its metric value to the cent.
- Cross-org: inserting an item whose `ref_id` belongs to another organization fails at the composite FK; a bundle of org A requested with org B context returns `NotFound`.
- Determinism: resolving the same descriptor twice (and after an unrelated import) returns identical ordered ids when `as_of` is set.
- AI builder rejects ids not in tool outputs; findings without evidence are downgraded, not shown.
- Immutability: UPDATE/DELETE on bundle tables as any authenticated role is denied (pgTAP).
- Superseded pinned records resolve with the badge; recalculated snapshots resolve with the "since recalculated" note.
