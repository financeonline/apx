# MOTION — Phase 8: Evidence & Traceability

Date: 2026-09-11 · Branch `main`, on top of `507e1a0` · Decision recorded: ADR-096
Scope: the Evidence & Traceability layer only. No Phase 9 work; no Actions, Forecasting, Scenarios,
Banking Intelligence, Commercial Intelligence, Adviser/CFO, Funding Readiness or advanced Reporting.

---

## 1. What Step 1 found, and what that meant for this phase

The brief's first instruction was to inspect before changing anything, and to extend rather than
compete with an evidence system that already exists. It does exist, and it is substantial:

| Piece | Where it already lived | Built in |
|---|---|---|
| `evidence_bundles` / `evidence_items`, the polymorphic origin guard, the append-only rules | `20260905000016`, `20260905000018`, ADR-034/044.8 | plan Phase 4 |
| `QueryDescriptorV1`, the RFC 8785 canonical hash, the column allow-list compiler | `modules/evidence/domain`, `data/descriptor-compiler.ts` | plan Phase 4 |
| As-of resolution from `record_status_events` | `domain/as-of.ts`, `services/resolve.ts` | plan Phase 4 |
| The five-level drawer as a deep-linkable page | `services/drawer.ts`, `/app/[orgSlug]/evidence/[bundleId]` | plan Phase 10 |
| Level 4: signed URL behind a verified audit row | `services/document.ts`, `core/storage/signer.ts` | ADR-038.1, ADR-043.5 |
| Metric bundle, built on demand and server-side | `api_server.build_metric_bundle_as` | ADR-066 |
| Alert bundle, one per revision | `app.build_alert_bundle` in `api_server.persist_alerts` | plan Phase 9 |
| Health-score bundle | `modules/health/services/score-run.ts` → `api_server.finish_health` | ADR-055 |
| AI-response bundle | `api_server.ai_persist_turn` | ADR-076+ |
| Action bundle (cloned, frozen) | `app.clone_bundle_for_action` | ADR-063 |
| Report bundle | `api_server.record_report_file` | ADR-086 |

So every producer §5 names already builds its bundle at the point of writing. **Phase 8 therefore
created no new table, no new bundle kind, and no second evidence architecture.**

### The gap that was real

The chain INSIGHT → METRIC → CALCULATION → RECORD → SOURCE DOCUMENT was walkable **downward only**.
From any figure a reader could open its calculation, its rows, and a row's file. Asked from the other
end, the product had no answer at all:

- a reader looking at **one record** — a bank line, an invoice — could not ask where it came from,
  whether it still counted, or which import brought it in. Nothing anywhere in the product showed a
  record's own history;
- a reader looking at **one file** saw the imports that rested on it and nothing about what those
  imports became: how many records reached the figures, or which months.

Those two questions are exactly the brief's `getRecordEvidence(...)` and `getDocumentEvidence(...)`.
Closing them is the whole of this phase.

### One contradiction found and corrected

`src/modules/evidence/index.ts` carried a list of builders "still deliberately absent", naming the
health-score, alert, AI-response and action builders — all four of which had been built in the phases
since, each at the point of writing rather than in that module. It was stale documentation *inside
the code*, which is the kind the next engineer trusts. It now says where each builder actually lives.
No behaviour changed. Recorded in ADR-096.

---

## 2. What was implemented

### Services (`src/modules/evidence/services/provenance.ts`, new)

```
getRecordProvenance(ctx, kind, recordId) → RecordProvenance
getDocumentEvidence(ctx, documentId)     → DocumentEvidence
```

`RecordProvenance` answers *"where did this row come from, and is it still counted?"*: the record
itself (date, description, amount, currency), its month, its **standing** (status, assurance,
superseded-by, rejected reason, and whether it counts towards the figures), the **import** that
brought it in with the range that import declared, and the **document** with the line within it.

`DocumentEvidence` answers *"what rests on this file?"*: the file, every import from it (committed
and rolled back alike, with the row counts its commit wrote), the number of records actually in the
figures, and the months it contributed to.

Both are pure reads over columns that already existed. Nothing is computed, and no relation is
invented: a record carries `source_document_id`, `import_batch_id`, `import_row_id` and `period_id`;
a batch carries its declared range, its `row_counts` and the `calculation_run_id` its commit
triggered.

The four record tables reach the reader as `ledger`, `bank`, `invoice`, `balance` — `RECORD_KINDS`.

### UI

| Surface | Change |
|---|---|
| `/app/[orgSlug]/evidence/record/[kind]/[recordId]` | **New page.** Four sections in the reader's words: *This record* · *Is it counted?* · *How it got here* · *Source document*. Reuses the existing `DocumentPanel`, so the file half behaves exactly as level 4 does. |
| `/app/[orgSlug]/evidence/[bundleId]` | **New "This row" column** on every records block: "Where from?" opens that row's history. "Source" is unchanged — it still opens the file in place, which is what a reader reconciling a figure wants. |
| `/app/[orgSlug]/data/documents/[documentId]` | **New "What rests on this file" card**: records in your figures, and the months it contributed to, each linking to that month's figures. |

No new component was created: the page is built from the existing `Card`/`CardHeader`/`CardBody`,
`Badge`, `PageHeader` and `DocumentPanel`. The brief's suggested component names were not adopted
because the design system already covers each of them, and the brief says not to add components the
existing patterns cover.

### Language

No database terminology reaches the reader. The URL carries `ledger`, not `ledger_entries`, and
`/evidence/record/ledger_entries/<id>` is a 404 rather than a synonym — asserted by a test. The
sections read "Is it counted?", "How it got here", "Where from?", "What rests on this file", "Months
it contributed to". Assurance is rendered in the §8.1 words ("Verified — read from a document you
provided"), never the enum.

---

## 3. Database changes

**None.** No migration was added. Every relation this phase reads was already a stored column, and
every index it needs already exists:

| Read | Index |
|---|---|
| record by id | `<table>_org_id_unique (organization_id, id)` |
| its import batch | `import_batches_org_id_unique` |
| its month | `fiscal_periods_org_id_unique` |
| a file's imports | `import_batches_document_lookup (organization_id, source_document_id)` |
| the months a file covers | `fiscal_periods_org_start_unique` |

Row counts are read off the batch where the commit wrote them rather than counted again, so a
document's evidence costs O(imports of that file) and never O(rows). The months are fetched in one
range query for all of a file's batches, not one query per batch — there is no N+1 here.

---

## 4. Security

Nothing in this phase relaxes anything, and nothing re-implements a control that already existed.

- **Organisation** comes from the request's `AccessContext` (`requireOrgId`) and never from an
  argument or a query string. Every read is filtered on it *and* goes through the caller's own
  client, so RLS decides independently.
- **Permission**: `getRecordProvenance` requires `financials.view`; `getDocumentEvidence` requires
  `documents.view`. The page requires the same through `requirePermission`, which renders the §7.4
  denied state with HTTP 403 (ADR-091).
- **Cross-tenant** is NOT FOUND, never a denial — a 403 would confirm the row exists for somebody
  (SECURITY_MODEL.md §14). Tested in both directions.
- **The client stop is delegated, not re-implemented.** The document half of a record's provenance
  goes through the existing `getDocumentReference`, which owns the `documents.view` rule: a client
  gets the line reference and `locked: true`, never a filename. Writing that check again here would
  have been a second place for it to drift.
- **Platform staff** inherit `app.accessible_org_roles()` unchanged: an unassigned employee resolves
  no organisation, so there is nothing for either service to read.
- **Storage** is untouched. No bucket, no policy, no signed-URL rule changed. The file itself is
  still only reachable through `/api/documents/[id]/url`, which mints a 60-second signed URL only
  after writing and re-verifying an audit row (ADR-043.5).

### Data quality

Both classifications are preserved and neither is upgraded:

- **Verified / Calculated / Estimated / Inferred** — the record's own `assurance_level`, shown in the
  §8.1 words.
- **Accepted / Rejected / Superseded** — `countsTowardsFigures` is `accepted && !superseded`, the
  same predicate the resolver applies to a whole selection. A rejected row says it is not in any
  figure and gives the reviewer's reason; a superseded row links to what replaced it. Neither is
  hidden, and neither is presented as authoritative.

---

## 5. Tests

### New — `test/integration/evidence-provenance.test.ts` (14)

| Group | Cases |
|---|---|
| A record says where it came from | counted row → import → file → **line 7**; superseded row names its replacement; rejected row gives the reason; hand-entered row says there is no file; invented id → NOT FOUND |
| Tenancy | B's record refused to A's owner; A's record refused to B's owner; B's document refused to A's owner — all NOT FOUND |
| Role | a client sees the record and the line but **not** the filename (`locked: true`); a client is refused document evidence outright |
| A file says what rests on it | a rolled-back import is listed but excluded from both the count and the months; kinds are named in the product's words with no table name in the payload; a fresh file has nothing resting on it; invented id → NOT FOUND |

### New — `e2e/evidence-provenance.spec.ts` (4)

A row in the drawer → "Where from?" → that record's history → its import and its file, clicked rather
than typed. An invented record, an invented kind (`ledger_entries` in the URL) and a malformed id are
all 404. Another organisation's record is 404, not a denial. A file's page states how many records
rest on it and which months, with each month linking to its figures.

### Regression — every gate

| Gate | Before Phase 8 | After |
|---|---|---|
| Typecheck | pass | **pass** |
| Lint | pass | **pass** |
| Unit | 1822 (61 files) | **1822 (61 files)** — unchanged, nothing in the engine moved |
| AI eval corpus | 132 | **132** |
| Integration | 519 (34 files) | **533 (35 files)** |
| Schema drift | pass | **pass** — 44 tables, 106 api functions; no migration added |
| pgTAP | 939 | **939** |
| Production build | pass | **pass** |
| Playwright | 52 | **56** |

Net new coverage: +14 integration, +4 Playwright. No test was weakened, skipped or deleted.

**One intermittent failure, investigated not excused.** The first full integration run failed
`ai-eval-record > … still match today's tools, key for key`. It passes alone, and it passed on a
second full run (533/533). It is **pre-existing**: the same test failed the same way earlier in this
project's history, before any Phase 8 work, and passed on the runs either side. Nothing in this phase
can reach it — the AI tools were not touched, and the only change to `modules/evidence/index.ts` is
additive exports plus a comment. The test seeds an organisation and runs the real engine, health and
alerts before comparing, which is the heaviest fixture in the suite on an 8 GB machine where the
Phase 1–7 audit already documented this class of timeout.

**Storage and RLS were re-verified rather than assumed**: `check:schema` confirms RLS forced on all
44 tables, zero write grants for `authenticated`, and no reachable `api_server` function; pgTAP's 939
include the tenancy and governance suites; the integration run includes `rls-isolation`,
`isolation-cases`, `org-scope` and `evidence-drawer`'s employee-assignment cases.

---

## 6. Known limitations

- **A record does not list the figures it feeds.** A record reaches a metric through aggregation, not
  through a stored link, so answering "which figures include this row" would mean re-running the
  engine's selection for every metric of the period. The honest link is the month, which the page
  gives. §8.6 forbids a reference that cannot be resolved, and this would have been one.
- **A file's months are its imports' DECLARED ranges**, not the dates of the rows inside it. That is
  deliberate and is the same range coverage and completeness are judged on (ADR-047.6), but a file
  declared for May whose rows all fall in April will say May.
- **`getDocumentEvidence` requires `documents.view`**, so a client cannot see what rests on a file.
  That follows CD-17 and `source_documents` RLS; it is a limit of the role, not of this service.
- **No reverse index from a record to the bundles citing it.** `evidence_items.ref_id` has an index
  (`evidence_items_by_ref`), so this is buildable, but nothing needs it yet and building it now would
  be a surface with no reader.
- **The two LOW findings carried from the Phase 1–7 audit are untouched** (route-table drift recorded
  in ADR-094; untyped health rule ids). Neither is in this phase's scope.

---

## 7. Architectural issues discovered

1. **Stale in-code documentation** in `modules/evidence/index.ts` (§1 above). Corrected.
2. **No index on `import_rows (committed_table, committed_record_id)`.** It is not needed today —
   records carry `import_row_id` directly, so every direction this phase walks is a primary-key
   lookup — but a future "which import row produced this record" that started from the record and
   searched `import_rows` would seq-scan. Recorded here rather than pre-emptively indexed, because an
   index with no query behind it is a cost with no reader.
3. **`calculation_runs.trigger_ref_id` is unindexed.** Same position: the batch carries
   `calculation_run_id` directly, so the useful direction is already a column read.
