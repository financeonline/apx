# MOTION — Phase 10 final audit (independent): Action Centre

Date: 2026-09-12 · Tree `main` at `36d3ca4` (clean) · Stance: hostile; the implementation report was
treated as a set of claims to be broken, and the truncated implementation brief was set aside in
favour of the approved documents.

## Executive summary

The Action Centre closes the loop the SOW asks for — alert or AI insight → action → owner → due date →
status → outcome → evidence — on an architecture that already existed and was **not** duplicated.
The one defect Phase 10 reported fixing is real and is fixed: I converted a `critical` alert while
supplying `priority: low` and got a `critical` action, with the derivation on the audit row. Sixty-four
adversarial probes across tenancy, the five roles, employee assignment, ownership, IDOR, smuggled
fields, due dates, lifecycle, the AI path and the audit trail found **no way to read, write, complete,
assign or attach evidence across a tenant, and no way for a client to exceed status-and-outcome on
their own rows.** Every gate passed when I ran it.

**CRITICAL 0 · HIGH 0 · MEDIUM 1 · LOW 8.** The MEDIUM is an approved requirement the phase
disclosed but did not build — *create an action from a health dimension* (REQ-AC-10; plan Phase 12
item 2). It has no bearing on Phase 11 and the generic path covers the need today.

**READY FOR PHASE 11.**

---

## Scope and evidence reviewed

- Approved documents: `PRODUCT_REQUIREMENTS.md` REQ-AC-01…11 and REQ-IA-09; `RBAC_MATRIX.md §2.1`
  rows `actions.view/create/assign/update_own` and their ◐ notes; `SERVICE_ARCHITECTURE.md §4.13`;
  `UX_ARCHITECTURE.md` §2–3 (roles, `/actions` row, ActionCard variants); `IMPLEMENTATION_PLAN.md`
  Phase 12; `EVIDENCE_MODEL.md §5` (action row), `§8.8`; `SECURITY_MODEL.md §14`; ADR-032.5, 034,
  063, 092, 098.
- Code at `36d3ca4`: every `api.*` action function read from `pg_proc` (`create_action`,
  `create_action_from_alert`, `create_action_from_recommendation`, `assign_action`,
  `set_action_status`, `update_action`, `update_own_action`), `app.clone_bundle_for_action`,
  `app.require_org/require_permission`; RLS on `actions`; `modules/actions` (domain, repository,
  services, views); the four pages and three controls; the ActionCard; the audit label table; the
  Phase 10 migration.
- Probes: 64 adversarial calls with minted JWTs for ten actors (owner, admin, two clients, suspended
  admin, stranger, another organisation's owner, assigned employee, expired employee, super admin).
- Suites run by me: typecheck, lint, unit, AI eval, pgTAP, the full integration suite, schema drift,
  production build, the evidence Playwright project alone, journeys 9 and 10 with the accessibility
  sweep.

## Requirements reconstructed from the source of truth

Because the brief was truncated, the standard used is the documents, not the prompt:

| Requirement | Source | Status |
|---|---|---|
| Fields: issue, recommendation, priority (C/H/M/L), owner (person), due date, status (open/in progress/completed/dismissed), evidence, outcome | REQ-AC-02…09 | **present**, pre-existing schema |
| Convert recommendations into actions — **from AI, alert, health** | REQ-AC-10; plan Phase 12 item 2 | AI ✔ alert ✔ **health ✗** (M-1) |
| Outstanding actions on the dashboard | REQ-AC-11 | ✔ Home widget via `getActionsSummary` |
| Client: read-and-participate, updates own actions, cannot create/assign | REQ-IA-09; RBAC ◐ | ✔ proved server-side |
| Assignee must be a member/employee of the org | RBAC `actions.assign` note | ✔ proved (stranger, other org, suspended, expired, invented → refused) |
| Never delete; never let a client reassign; never create from a degraded/failed answer | §4.13 "Never" | ✔ no delete path exists; ✔; ✔ proved |
| Audit `action.created`, `.assigned`, `.status_changed`, `.completed` | §4.13 | created/assigned/status_changed/updated ✔; `.completed` not distinct (L-5) |

---

## Findings

### MEDIUM

**M-1 · Create-from-health-dimension is in the approved scope and is not built.** REQ-AC-10 reads
"Create-from AI/alert/health" and `IMPLEMENTATION_PLAN.md` Phase 12 item 2 lists "health dimension"
beside alert and AI. The pieces are all present — `action_source_enum.health_score`, the
`same_org_ref_source` mapping to `health_scores` (ADR-092), `evidence_kind_enum.health_score`,
`app.clone_bundle_for_action` accepting any bundle — and nothing wires them: no `api.create_action_from_health_score`,
no control on `/home/health`. `PHASE_10_IMPLEMENTATION.md §7` disclosed this and gave a fair reason
(the health rules carry no recommendation text to seed an action with), but the approved documents
name it as MVP scope, so it is a gap and not a choice. **Not blocking for Phase 11**: Forecasting has
no dependency on it, a user can create an action about a health finding through the generic form,
and the health page already links each factor to its evidence. It should be scheduled rather than
carried.

### LOW

**L-1 · The completed↔dismissed transition rule exists only in TypeScript.** `canTransition` forbids
`completed → dismissed` and the reverse ("two accounts of the same work"), and the service enforces
it — but `api.set_action_status` accepts any `p_status`. I moved an action `completed → dismissed`
with a direct RPC and it succeeded, leaving `completed_at` NULL beside a dismissal. ADR-026's rule is
that every business rule is in SQL; this one is not. No security or tenancy consequence.

**L-2 · A dismissal never records a reason.** `dismissed_reason` exists, `set_action_status` accepts
it, nothing requires it, and the Dismiss button carries no field for it. The module's own header
says an action "is dismissed with a reason". The list therefore cannot answer "why did we drop
this?", which is the question the field exists for.

**L-3 · "Today" is UTC, not the organisation's.** `/actions`, `/actions/[id]` and `/home` compute
`todayInTimeZone(systemClock, 'UTC')`; `organizations.timezone` exists and `AccessContext` does not
carry it. Overdue and due-soon can be wrong by up to a day's difference at the boundary for an
organisation east of UTC. Display only; nothing is written.

**L-4 · `ActionCard` re-implements `isOverdue`.** Lines 57–59 restate the domain predicate inline.
The two agree today; a component holding a business rule is the thing the `no-arithmetic-in-components`
family of rules exists to prevent, and this one is a date rather than money so nothing catches it.

**L-5 · The audit trail is complete but thinner than the contract says.** `set_action_status` writes
`before = null`, so a status row says what it became and not what it was; `action.completed`
(§4.13) is not emitted as its own action — completion is a `status_changed` with `status =
completed`. WHO/WHAT/WHEN are all recoverable (the actor is on every row; I checked none are null,
and none carry a secret), so this is a documentation mismatch plus a convenience loss.

**L-6 · A malformed due date reaches the reader as a generic error.** The date is cast in SQL, which
correctly refuses `not-a-date` (22007) and `2026-02-30` (22008); those SQLSTATEs are not in the
`toMotionError` map (only 22023 and 23514 are), so a direct call sees "something went wrong" rather
than "that is not a date". The browser's `<input type="date">` prevents it in normal use.

**L-7 · The Playwright cross-organisation skip is data-dependent, and the reports mis-describe it.**
`evidence-provenance.spec.ts` skips when no other organisation has a ledger. Phases 8, 9 and 10 each
said it "passes 15/15 when the project runs alone"; when I ran the project alone it skipped
(14 passed, 1 skipped). Whether it runs depends on what earlier runs left in the database. The
boundary it covers is proved unconditionally in `evidence-provenance.test.ts` and `ai-tools.test.ts`,
so coverage is not lost — but a test whose execution depends on leftovers should seed its own foreign
row, and the reports should not have called it deterministic.

**L-8 · A super admin can be made the owner of any organisation's action.** `app.org_role_of(sa, org)`
returns `super_admin` for every organisation, so `assign_action` accepts a platform super admin who
is not a member. The RBAC note says "member/employee of the org". Defensible — a super admin has
standing everywhere by design and the assignment is audited — but it is wider than the note's words.

---

## Area-by-area

### Action model
All nine fields pre-existed on `actions` and every relationship is a real column: `source_type` +
`source_id` under the polymorphic guard (`ai → ai_messages`, `alert → alerts`, `health_score`,
`report`, `user → -`), `evidence_bundle_id` under a composite FK to `evidence_bundles`, `owner_user_id`
validated against `app.org_role_of`. Phase 10 added no table, column, constraint or index, and its one
migration replaces one function. No duplicate architecture.

### Lifecycle
Open → In progress → Completed / Dismissed, with re-opening from either terminal state (a deliberate,
documented choice: work turns out unfinished). No delete anywhere — verified by grep and by the SQL
surface. `completed_at` is set on completion and cleared on re-open. L-1 and L-2 above.

### Alert → action — the high-priority area
Proved through the real function, not the UI:

| Probe | Result |
|---|---|
| `critical` alert, caller sends `priority: low` | action is **critical**; `due_date` NULL |
| `info` alert | action is **low** |
| audit row `alert.converted_to_action` | carries `severity: critical, priority: critical` |
| evidence | action bundle `kind = action`, items **copied**; adding an item to the alert's bundle afterwards left the action's unchanged |
| back-reference | `alerts.action_id` points at the action; the convert control is replaced by a link |
| A's owner converts B's alert | NOT FOUND |
| client converts an alert | PERMISSION DENIED |

The service's `createFromAlert` type no longer accepts a priority, so the interface cannot lie. No
due date is proposed — I confirmed nothing outside `domain/views.ts` references `DUE_SOON_DAYS` or
writes a date.

### AI → action
The model has **no write tool** (grep of `modules/ai` for any action mutation: none). Creation is
`createFromRecommendation` behind a form the reader submits. A `degraded` answer → refused (22023);
the same through the generic `create_action` with an `ai` source → refused; index out of range → NOT
FOUND; a client → denied; B's owner on A's message → NOT FOUND. Evidence is cloned from the answer's
bundle with `origin_message_id` preserved (§8.8).

### Health Score → action
See M-1. The factor → evidence link required by the truncated brief line exists (`health-explain.tsx`
links each metric's snapshot; the score links its bundle).

### Evidence
One system. `app.clone_bundle_for_action` reads the source bundle **scoped to the organisation**
(`b.organization_id = p_org`) and copies items into a new `action` bundle; the source id comes from
the alert's current revision, never from the caller. A's owner cannot read B's alert bundle (RLS,
0 rows). The detail page's "The figures behind this" opens the cloned bundle through the Phase 8
drawer. Deleted-source handling is the drawer's (a pinned row shows its badge); no new path.

### RBAC — proved server-side, not inferred from buttons

| Operation | owner | super admin | admin | employee (assigned) | client |
|---|---|---|---|---|---|
| view | ✔ | ✔ | ✔ | ✔ | ✔ (all of the org's, owner shown as "Someone here") |
| create | ✔ | ✔ | ✔ | ✔ | ✗ `actions.create` |
| assign | ✔ | ✔ | ✔ | ✔ | ✗ `actions.assign` — even to self |
| change priority / due date / text | ✔ | ✔ | ✔ | ✔ | ✗ `actions.create` — smuggled fields in `update_own` ignored |
| change status / add outcome | any row | any row | any row | any row | **own rows only** — another client's row refused |
| delete | none | none | none | none | none |

Every page gate is `requirePermission` (403 + denied state) and every mutation re-checks in SQL.

### Tenant isolation and IDOR
A's owner against B's action: edit, complete, assign, `update_own`, create-in-B — all NOT FOUND; B
against A likewise; A reads 0 of B's rows. Replacing an action id, an alert id, a message id or a
bundle id with another organisation's in every mutation produced NOT FOUND, never a 403 (§14).

### Employee assignment
Assigned employee at aal2: edits A ✔, reads 0 of B, cannot edit/create/assign in B (NOT FOUND).
Same employee at aal1: NOT FOUND. Expired assignment: NOT FOUND. Cannot be assigned as an owner of A
once expired; the active one can.

### Client security
Cannot create, assign, reprioritise, redate, or move anyone else's action; smuggling `priority`,
`title`, `owner_user_id` and `organization_id` into `update_own_action` changes nothing (verified
by reading the row back). Sees colleagues as "Someone here" — `ownerName` resolves only with
`users.view`. Document access is unchanged from Phase 8 (locked at the filename).

### Due dates
Optional; cast in SQL so the browser is not trusted; malformed and impossible dates refused (L-6 on
the message); past dates accepted at creation, which is a defensible reading of "handle" and is how
already-late work is recorded. Undated actions appear in neither Due soon nor Overdue (unit-proved);
Due soon looks forward only, so an overdue action is in exactly one pile (unit- and journey-proved).
`DUE_SOON_DAYS = 7` is a query window: nothing writes it. L-3 on the timezone.

### UX
The list answers the brief's five questions on one card — priority badge, status badge, owner
("You" / name / "Someone here" / "Nobody yet"), due date, title — with an "Overdue" marker, and a
one-sentence headline ("3 things need attention, and 1 is past its due date"). Lenses carry counts
and grey out at zero rather than hiding. The detail page reads *What prompted it · What was
suggested · The figures behind this · What came of it · Move it along*. Completion is one button with
an optional sentence. Empty state names the three ways an action appears. Error state is the tenant
boundary; no dedicated loading state (server-rendered). The accessibility sweep passes the Action
Centre at 320/375/768/1440 with zero serious axe violations. No new screen was added. Minor: the
due date renders as raw `YYYY-MM-DD` (L-4's neighbour, not counted separately).

### Lenses
Seven, with counts from the same `inView` predicate as the rows. Exclusivity of Overdue and Due soon
proved; Mine excludes finished and unowned; Important is critical+high. No owner picker — Mine is the
lens the brief's "My Actions" asks for.

### Ownership
`assignableOwners` = `api.org_members` filtered to active; SQL independently requires
`app.org_role_of(owner, org)` non-null. L-8 on the super-admin edge.

### Audit logging
Present for every mutation, actor never null, no secrets. L-5.

### Regression
All green on my own runs at `36d3ca4`: typecheck, lint, unit 1832, AI eval 146, pgTAP 939,
integration 546 (35 files, including engine determinism, health, alerts, evidence, org-scope, RLS
isolation, isolation-cases), schema drift, build, journeys 9 and 10 plus the accessibility sweep
(21). Phases 1–9 are intact.

### Test quality
The security boundaries are proved by negative tests at the SQL layer, not by hidden buttons:
`actions.test.ts` covers the client-moves-only-own rule and the alert→priority rule across every
severity including the ignored override; my probes reproduced all of it and extended it to the
employee and IDOR cases. Gaps worth closing: no test for the completed→dismissed SQL path (L-1), no
test that the dismiss flow records a reason (L-2), and the data-dependent skip (L-7).

### Architecture quality
No duplicate architecture. The lens rules are in the module; the page renders. `createFromAlert`
narrowed its own type rather than accepting a field it ignores. One duplicated rule (L-4), one rule
in the wrong layer (L-1), one stale claim in three reports (L-7), one doc/impl naming mismatch (L-5).

## Known limitations carried forward
M-1 (health source); the two LOWs from the Phase 1–7 final audit (route-table drift; untyped health
rule ids) remain open and are not this phase's.

---

## Final decision

CRITICAL: 0 · HIGH: 0 · MEDIUM: 1 (non-blocking; scheduled work) · LOW: 8

**READY FOR PHASE 11**
