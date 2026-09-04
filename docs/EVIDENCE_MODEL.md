# MOTION — Evidence & Traceability Model

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-008, ADR-009, ADR-010, ADR-016), `DATABASE_ARCHITECTURE.md §6`, `FINANCIAL_ENGINE.md`, `RBAC_MATRIX.md`
Consumed by: `AI_ARCHITECTURE.md`, `UX_ARCHITECTURE.md`, `SERVICE_ARCHITECTURE.md`, `TEST_STRATEGY.md`
Module home: `src/modules/evidence`

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026, ADR-029, ADR-031, ADR-032 (§5–6), ADR-034, ADR-037. Findings addressed: F-C-02, F-C-06, F-C-07, F-C-11, F-C-14, F-C-15, F-C-16, F-C-18, F-A-13, F-A-18, F-D-06, F-D-08. See `RED_TEAM_REVIEW.md`.

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
Ordered members of a bundle. Fields: `id`, `organization_id`, `bundle_id`, `sort_order`, `item_type`, `ref_id`, `ref_revision_no`, `query_descriptor`, `descriptor_hash`, `label`, `claim`, `assurance_level`. Exactly one of `ref_id` / `query_descriptor` is set (`evidence_item_xor` trigger); every `ref_id` is checked for organization equality by the `same_org_ref` trigger, which resolves the target table from `item_type` (ADR-034), because a polymorphic column cannot carry a foreign key.

| `item_type` | `ref_id` points at | Used for |
|---|---|---|
| `metric_snapshot` | `metric_snapshots.id` | any cited number |
| `calculation_run` | `calculation_runs.id` | "as of" context |
| `ledger_entry` / `bank_transaction` / `invoice` / `period_balance` | the record | pinned drivers, duplicates, anomalies |
| `counterparty` / `account` / `fiscal_period` | the entity | subject of a claim |
| `source_document` | `source_documents.id` | direct document citation (page in `label`) |
| `alert` | `alerts.id` with `ref_revision_no` = the `alert_revisions.revision_no` cited | an AI finding or action that rests on an alert; pins the exact text and severity seen (ADR-034) |
| `query` | — (uses `query_descriptor`; `descriptor_hash` stored) | aggregate evidence: "all entries on accounts 4000–4020 in March" |

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
// metric_snapshots.evidence_query (ADR-034): a leaf selects records; a derived metric names its inputs by snapshot id
type EvidenceQuery =
  | { kind: 'leaf'; descriptor: QueryDescriptor }
  | { kind: 'derived'; components: { name: string; snapshot_id: string }[] };
// variance snapshots are derived with components [{name:'current', snapshot_id}, {name:'comparison', snapshot_id}]
type EvidenceBundleView = {
  id: string; kind: BundleKind; origin: { table: string; id: string };
  asOf: { calculationRunId: string; engineVersion: string; finishedAt: string };
  items: EvidenceItemView[];
  assurance: Assurance;                        // min over items (§7)
};
```

---

## 3. Query descriptor

A `query_descriptor` is a declarative, versioned selection that the resolver re-executes under RLS. It never contains SQL, never contains an `organization_id` (implied by the bundle's organization), and never selects across tables. It is produced only by engine code and alert rules; it is **never part of any model-visible schema and never accepted from the AI or from user input** (ADR-032.6).

```json
{
  "v": 1,
  "table": "ledger_entries | bank_transactions | invoices | period_balances | metric_snapshots",
  "filters": {
    "period_ids": ["uuid"],
    "account_ids": ["uuid"],
    "counterparty_ids": ["uuid"],
    "bank_account_ids": ["uuid"],
    "category_account_ids": ["uuid"],
    "invoice_types": ["sales", "sales_credit_note"],
    "direction": "debit | credit | inflow | outflow",
    "exclude_cash_transfers": true,
    "open_as_of": "2026-03-31",
    "overdue_as_of": "2026-03-31",
    "metric_keys": ["revenue"],
    "dimension": { "type": "counterparty", "id": "uuid" }
  },
  "as_of": { "calculation_run_id": "uuid" },
  "order": [{ "field": "amount", "dir": "desc" }, { "field": "id", "dir": "asc" }],
  "limit": 500
}
```

Rules:
- **Stable identities only (ADR-034).** Engine descriptors name `account_ids`, `category_account_ids` and `bank_account_ids` resolved at run time. `standard_categories` is **not** a v1 filter: a category is a mutable property of an account, so filtering by it would make old evidence follow later remaps. The v1 schema rejects the key.
- **As-of semantics.** `as_of` is mandatory for engine descriptors and equals the producing `calculation_run_id`. The resolver selects rows that were `accepted` and not superseded at `calculation_runs.finished_at` using the append-only `record_status_events (record_table, record_id, status, at, actor)` table (written by commit, rollback, supersede, reject and unsupersede), never `updated_at`. For bank rows the category in force at `finished_at` comes from `category_history (record_table, record_id, category_account_id, valid_from, valid_to)`; for accounts from `account_category_history`. Rollback never clears `superseded_by`; it writes an `unsuperseded` status event that the resolver honours (ADR-029.2).
- **Without `as_of`** (user-facing filters only) the resolver returns currently accepted, non-superseded rows. The compiler rejects `table = metric_snapshots` without `as_of` so a selection can never mix runs.
- `order` always ends with `id asc` so pagination is deterministic.
- `limit` ≤ 1,000; the resolver also returns `count` and `total` (Σ amount) over the *whole* selection so a truncated list still reconciles to the metric.
- Unknown keys or an unknown `v` fail validation (Zod schema `QueryDescriptorV1`), never a best-effort query.
- `descriptor_hash = sha256(canonical JSON)` is stored on every `query` item and returned by tools with the item; an AI `query` reference is accepted only when its hash matches a descriptor a tool returned in the same turn (§5).

### 3.1 Resolver service

```ts
resolveDescriptor(ctx: AccessContext, d: QueryDescriptor, page?: Cursor)
  → { rows: RecordView[]; count: number; total: Decimal | null; nextCursor?: Cursor }
```
- Runs with the caller's user-scoped Supabase client (RLS applies; ADR-013/ADR-026 reads). The bundle's `organization_id` must equal `ctx.orgId` or the call fails with `NotFound`. For `ai_response` bundles the caller must be the origin message's owner or an organization owner/admin (ADR-032.8).
- Compiles filters into a fixed query-builder mapping (`data/descriptor-compiler.ts`) — an allow-list of columns per table; no string interpolation.
- Deterministic: same descriptor + same `as_of` ⇒ same rows in same order (tested).

---

## 4. Pinned records vs descriptors (ADR-009)

| Use a **pinned** item (`ref_id`) when | Use a **descriptor** when |
|---|---|
| The claim is about specific records (duplicate pair, unusual payment, the top-5 drivers, an overdue invoice) | The claim is an aggregate (revenue for a period, marketing spend, all overdue invoices) |
| The reader must see *that* row even if data later changes | The reader must see the *set* that produced the number as of the run |
| AI cites a record returned by `get_transactions_for_evidence` (input: a snapshot, alert or evidence item id, never a descriptor) | AI cites a metric returned by `get_metric` (the item pins the snapshot, and the snapshot carries the descriptor); a `query` ref is allowed only with a `descriptor_hash` returned this turn |

A bundle usually mixes both: alerts pin drivers and carry the aggregate descriptor; AI answers pin snapshots and records.

---

## 5. How each producer builds a bundle

| Producer | When | Bundle `kind` | Items |
|---|---|---|---|
| **Metric snapshot** | at calculation run write | none — the snapshot *is* the evidence root: `metric_snapshots.evidence_query` is either a `leaf` descriptor or a `derived` list of component snapshot ids (ADR-034). `buildBundleForMetric(snapshotId)` materialises a bundle on demand with: the snapshot, its `calculation_run`, and for a leaf one `query` item; for a derived metric one `metric_snapshot` item per component, recursively expanded to leaves so the drawer can reconcile each. Dimension metrics add the `counterparty`/`account` item. | |
| **Alert** | at `alerts.evaluate` upsert | `alert` | pinned records listed in the rule's "Evidence pinned" column (`FINANCIAL_ENGINE.md §8.2`), the triggering `metric_snapshot`(s), the comparison snapshot, the `query` descriptor for the aggregate, the `fiscal_period`. A new bundle is built **only when a new `alert_revisions` row is written** (material change, ADR-034); the revision points at its bundle, older revisions keep theirs (immutability). |
| **Health dimension** | at health score write | `health_score` | one bundle per score row: `metric_snapshot` items for every metric in `breakdown[].metrics`, `calculation_run`. Positive/negative factors reference snapshot ids inside `breakdown`. |
| **AI response** | after grounding (`passed` **or** `degraded`; a `failed` message has no bundle) | `ai_response` | one bundle per assistant message, built from the statements that survived grounding (ADR-032.5). Items are built **only from tool-call outputs recorded in `ai_tool_calls`**: every `metric_snapshot` id, record id, `alert` id + revision and `descriptor_hash` the tools returned that the response's `evidence[]` references. Every statement — including `direct_answer`, causes, risks, opportunities and recommended actions — must reference ≥1 item; the item's `claim` is the statement text. The builder rejects any id or hash not present in that turn's tool outputs — model text can never introduce an item. |
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
| 2 Calculation | formula in words ("Gross profit = Revenue − Cost of sales"), each component with value, its own basis **and a link to its own snapshot**, engine version, run time | `snapshot.components`, `evidence_query.components`, registry definition |
| 3 Records | for a leaf metric: paginated table from the descriptor or the pinned rows (date, description, counterparty, account/category, amount, status badge `superseded`/`accepted`), `count` and `total` reconciling to the metric. For a **derived** metric: one reconciliation block per leaf component ("Revenue £150,000 = 1,238 rows", "Cost of sales £45,000 = 312 rows"), each openable to its rows; the block totals must reproduce the derived value (ADR-034). | resolver |
| 4 Document | source document viewer with page and highlighted row/line from `import_rows.source_ref`; download button (permission-gated) | signed URL (60 s) |

Behaviour rules: level 3 shows `total` next to the metric value and a visible reconciliation ("500 of 1,238 rows shown; all rows total £120,000.00 = metric"); superseded records show a badge and a link to the replacement; an `alert` item whose current revision differs from the pinned revision shows "updated since you acknowledged" with both versions; a level the role cannot open shows the friendly denied state rather than an empty panel.

---

## 7. Assurance propagation

- Each item carries `assurance_level` copied from its target (`metric_snapshots.assurance_level`, record `assurance_level`; descriptor items take the *minimum* assurance over the resolved set, computed at build time and stored).
- Bundle assurance = min over items in order `verified > calculated > estimated > inferred`.
- A claim's badge is its bundle assurance, rendered with the **single canonical label table in `UX_ARCHITECTURE.md §8.1`** (`assurance → label → tooltip`); this document and `AI_ARCHITECTURE.md` cite that table and never restate labels (ADR-037). A finding backed by an `inferred` record (Claude-extracted PDF row) carries the `inferred` assurance even if the arithmetic is exact.
- Data-quality warnings on any cited snapshot are surfaced at level 1 and echoed in the AI's Confidence section.

---

## 8. Integrity rules

1. **Immutable bundles.** No UPDATE/DELETE policy on `evidence_bundles`/`evidence_items` for `authenticated`; producers always create new bundles and repoint the origin.
2. **Snapshot ids, not values.** Items reference `metric_snapshots.id`; recalculation appends new snapshots and rewrites `metric_current` pointers, so an old bundle keeps resolving to the exact numbers that were shown. Referenced snapshots are never archived (retention = organization lifetime, ADR-031.5). The drawer shows "This figure has since been recalculated — current value £X" when the referenced snapshot is not current.
3. **Superseded records resolve.** Pinned `ref_id` rows that are later superseded or rejected are still fetched (the resolver does not filter pinned items by status) and shown with a `superseded`/`rejected` badge and the replacement link.
4. **Cross-organization references are impossible.** `evidence_items.organization_id` must equal the bundle's; because `ref_id` is polymorphic it is guarded by the `same_org_ref` trigger (resolves the target table from `item_type` and asserts organization equality), `evidence_bundles.origin_id` by the same trigger, and every non-polymorphic FK is org-composite (ADR-034); the resolver rejects a bundle whose organization ≠ `ctx.orgId`.
5. **Producers only.** Bundles are written by `api.*` functions (ADR-026) called from `src/modules/evidence/services/build-*.ts` or by jobs; `authenticated` has no insert privilege. The AI module calls `buildBundleForAiResponse` with tool-output ids and descriptor hashes and receives validation errors for anything else.
6. **No orphan claims.** Any statement (including the direct answer, an inference or a recommendation) or alert whose bundle would be empty is **downgraded**: alerts are not created (rule outcome dropped with an audit note), AI statements are moved into `unsupported` and are never shown as facts (`AI_ARCHITECTURE.md` grounding, ADR-032.3).
7. **Reconciliation is reproducible.** After an account remap, a bank recategorisation, a supersession or a rollback, resolving a descriptor with its original `as_of` returns the same rows and the same `total` as when the bundle was built, because identities are stable and status/category history is append-only (ADR-034).

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
getDocumentReference(ctx, recordRef): Promise<{ documentId, page?, sheet?, row?, signedUrl? }> // signedUrl only if documents.view; minted by core/storage/signer with an audit id (ADR-038.1)
resolveDerived(ctx, snapshotId): Promise<{ components: { name, snapshotId, value, leaf: boolean }[] }>   // walks evidence_query.kind='derived'
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
- **Revision 1.1 cases:** after remapping an account (F-C-07), overriding a bank category, superseding an invoice and rolling back a batch, resolving the original descriptor with its `as_of` returns the original rows and `total` equals the cited value to the cent; a derived metric's chain walks to leaves whose totals reproduce it (F-C-15); an AI `query` ref with a hash not returned this turn is rejected, and tool 13 rejects a descriptor input (F-C-02); an `alert` item pins a revision and the drawer flags a later revision (F-C-16); the `same_org_ref` trigger rejects a foreign `ref_id` under service role (F-A-13); a `degraded` message has a bundle of surviving statements and a `failed` message has none (F-C-14); a snapshot referenced by an item survives the compaction job (F-C-18).
