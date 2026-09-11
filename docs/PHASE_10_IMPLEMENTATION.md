# MOTION — Phase 10: Action Centre

Date: 2026-09-12 · Branch `main`, on top of `a140a69` · Decision recorded: ADR-098
Scope: the Action Centre only. No Forecasting, Scenarios, Banking Intelligence, Commercial
Intelligence, Adviser/CFO, Funding Readiness or advanced Reporting.

> **A note on the brief.** The instruction text reached me truncated, cutting off partway through
> *"HEALTH SCORE INTEGRATION — Where appropriate, Health Score factors may link to: View details →
> Evidence"*. That sentence describes something that already exists (§7 below), so I have implemented
> against it as written and have **not** guessed at whatever followed. If the truncated tail asked
> for more, it is not in this phase and I have not silently invented it.

---

## 1. What Step 1 found

The brief was explicit that Phases 8 and 9 both reported action structures, and that I should find
out exactly what exists before building. Almost all of it does:

| Piece | Where | Built in |
|---|---|---|
| `actions` table — issue, recommendation, priority, owner, due date, status, outcome (notes/value/currency), dismissed reason, source, evidence bundle | `20260905000017` | plan Phase 12 |
| Evidence **cloned** at creation so an action keeps saying what it said | `app.clone_bundle_for_action` | ADR-063 |
| `api.create_action` · `_from_alert` · `_from_recommendation` · `assign_action` · `set_action_status` · `update_action` · `update_own_action` | `20260905000022`, `…000054` | Phases 12, 13 |
| Lifecycle with re-opening, and no delete — a dismissed action keeps its reason | `domain/types.ts` `canTransition` | plan Phase 12 |
| List page, detail page, status controls, assign control, create form | `app/[orgSlug]/actions/*` | plan Phase 12 |
| Alert → action control, pointing back so the button is not offered twice | `insights/alerts/[alertId]/convert-control.tsx` | plan Phase 12 |
| AI recommendation → **user-confirmed** action, refused unless the answer passed grounding | `createFromRecommendation`, ADR-032.5 | Phase 9 |
| `get_actions` AI tool | `domain/tools/money.ts` | Phase 9 |
| Home widget summary, client-moves-own-action journey | `getActionsSummary`, `journey-9-client` | plan Phases 12, 14 |

So Phase 10 created **no table, no second evidence path, no second lifecycle and no second
persistence mechanism.** Two things were genuinely wrong or missing.

---

## 2. The defect: priority was decided by nobody

`api.create_action_from_alert` copied the alert's title, explanation and recommended next step — and
then set:

```sql
coalesce((p_input ->> 'priority')::public.action_priority_enum, 'medium')
```

It never read `alerts.severity`. The only caller in the product, `createFromAlert(ctx, alertId)`,
sends no priority. **Every action converted from an alert was therefore `medium`** — a `critical`
cash-runway alert included — and the Action Centre, which sorts by priority then due date, placed it
below a task somebody had typed in by hand. The field was populated and the value was wrong, which is
the kind of defect a passing test suite does not notice.

### The rule now

| Alert severity | Action priority |
|---|---|
| `critical` | `critical` |
| `high` | `high` |
| `medium` | `medium` |
| `low` | `low` |
| `info` | `low` |

`info` has no counterpart among the four priorities; it maps to `low` because an informational alert
is the least urgent thing that could still be worth doing.

A caller-supplied priority is **ignored**, not rejected: the conversion is one click on an alert, and
failing it over a field the interface does not offer would be a worse answer than using the severity
the rule already decided. The service's parameter type no longer accepts `priority` at all, so the
interface cannot lie about what it does. **Changing it afterwards is `api.update_action`**, which
requires the permission and is audited — a considered change is possible; an unconsidered one is not.
The derivation (`severity` and the resulting `priority`) is written onto the
`alert.converted_to_action` audit row, so *"why is this critical?"* is answerable from the trail.

### Due dates

**No due date is proposed, deliberately.** Nothing in the alert rules carries one, and defaulting to
"seven days" would be a commitment MOTION invented on a business's behalf. Server-side, a due date is
optional; the value is cast to `date` in SQL, so a malformed string is refused there rather than
trusted from the browser. A past due date is accepted — recording work that is already late is a real
thing a business does, and the Overdue lens is what surfaces it.

## 3. The gap: the screen had no lenses

The page offered three status tabs — To do, Finished, Everything. Those answer *what exists*, not the
question a person opens the Action Centre with: **what is late, what is mine, what is urgent.**

`src/modules/actions/domain/views.ts` adds seven lenses — To do · Mine · Due soon · Overdue ·
Important · Finished · Everything — each with its count on the tab. The rules live in the module and
not in the page, because "due soon" and "needs attention" are statements about work and a page that
decided them would be a second place for them to be decided.

Two properties carry the product meaning, and both are refusals to invent a commitment:

1. **An action with no due date is in neither `due_soon` nor `overdue`.** It is undated, not late.
2. **`due_soon` looks forward only**, so an overdue action is in Overdue and not in both — which is
   what lets the two counts be read as two separate piles of work.

`DUE_SOON_DAYS = 7` is how far the screen looks ahead, **not** a date assigned to anybody's work:
nothing in this phase writes a `due_date`.

The counts come from the same `inView` predicate as the lists, so a tab's number and the rows behind
it cannot disagree. A lens with nothing in it is greyed rather than hidden — *"nothing is overdue"* is
the most reassuring thing this page can say, and hiding the tab would make it unsayable. The header
sentence is plain: *"3 things need attention, and 1 is past its due date."*

Two reads serve the whole screen. A business's open actions are bounded by what people can actually
attend to, so the lenses are counted in memory rather than asked for one query each; "recently
completed" is capped at 20 because it is a reassurance, not an archive — the archive is Everything.

## 4. Permissions, tenancy and ownership

Unchanged and inherited. `actions.view` to read; `actions.create` to create and to move anything;
`actions.update_own` lets a client move **only their own**, which `canManage` decides from the row as
well as the role. Every page gate is `requirePermission` (403 + the §7.4 denied state, ADR-091) and
every mutation re-checks in SQL through `app.require_permission`, so a hidden button is never the
control. Organisation comes from the server-resolved `AccessContext`, never the browser; a cross-org
action id is `NOT_FOUND`. Assignable owners come from `api.org_members`, which is members and
currently-assigned employees only — a client cannot assign work to somebody with no standing in the
organisation, and a platform employee appears only where their assignment does.

## 5. Alert integration

Unchanged except for the priority rule. The action pins the **revision** that prompted it and clones
that revision's evidence bundle, so a later re-evaluation cannot rewrite why the decision was made.
The alert points back at the action, so the convert button is offered once.

## 6. AI integration

Unchanged, and already correct against the brief: the analyst **recommends**, the reader confirms on
a form, and only then is the action created. `api.create_action_from_recommendation` additionally
refuses unless the answer **passed** grounding (ADR-032.5) — a degraded or failed answer cannot be
laundered into a task that looks authoritative because it now has an owner and a due date. No action
is ever created silently.

## 7. Health Score integration

Health factors already link to evidence: `/home/health` renders each dimension's rules and each
figure links to its own snapshot's evidence, and the score itself links its bundle
(ADR-093 for the score, Phase 8 for the chain). That is what the truncated brief line describes, and
it needs nothing.

`action_source_enum` reserves `health_score` and the `same_org_ref_source` guard maps it (ADR-092),
so a one-click "create an action from this factor" is supportable. **I have not built it**, because
the health rules carry no recommendation text to seed such an action with, and the generic create
form plus the existing evidence link already let a user record the decision. Flagged in §10 rather
than guessed at.

## 8. Files changed

| File | Change |
|---|---|
| `supabase/migrations/20260912000001_action_priority.sql` | **new** — `create_action_from_alert` derives priority from severity |
| `src/modules/actions/domain/views.ts` | **new** — the seven lenses |
| `src/modules/actions/services/index.ts` | `loadActionCentre`; `createFromAlert` no longer takes a priority |
| `src/modules/actions/data/repository.ts` | `ActionFilter` gains `priority` and `dueOnOrBefore` |
| `src/modules/actions/index.ts` | exports |
| `src/app/app/[orgSlug]/actions/page.tsx` | lenses, counts, headline sentence |
| `test/unit/action-views.test.ts` | **new** — 10 cases |
| `test/integration/actions.test.ts` | +9 cases |
| `e2e/journey-10-action-centre.spec.ts` | **new** — 2 journeys |
| `docs/ARCHITECTURAL_DECISIONS.md` | ADR-098 |

## 8a. Regression gates

| Gate | Before Phase 10 | After |
|---|---|---|
| Typecheck | pass | **pass** |
| Lint | pass | **pass** |
| Unit | 1822 (61 files) | **1832 (62 files)** |
| AI eval | 146 | **146** |
| Integration | 538 (35 files) | **546 (35 files)** |
| Schema drift | pass | **pass** — 44 tables, 106 api functions |
| pgTAP | 939 | **939** |
| Production build | pass | **pass** |
| Playwright | 55 passed, 1 skipped | **57 passed, 1 skipped** |

No test was weakened, skipped by edit or deleted. The one Playwright skip is the same declared
precondition carried from Phase 8 (a cross-organisation ledger id that the full-suite ordering does
not always leave behind); it passes when its project runs alone, and the boundary it covers is proved
unconditionally at the service level.

## 9. Database changes

One migration, no schema change: `api.create_action_from_alert` replaced. No column, table,
constraint or index was added — every field the brief names already existed.

## 10. Known limitations

- **No one-click "create an action from this health factor."** `health_score` is reserved in the
  enum and guarded by the polymorphic trigger, so it is supportable; the health rules carry no
  recommendation text to seed it, so the generic create form is the honest path today.
- **No owner filter on the screen.** `ActionFilter.ownerUserId` supports it and the **Mine** lens
  covers the case a person actually asks about; a picker of everybody would be the advanced query
  builder the brief says not to build.
- **`due_soon` is fixed at 7 days**, not configurable. A setting would be a business rule with no
  owner.
- **A past due date is accepted at creation.** Recording already-late work is legitimate; the Overdue
  lens is how it surfaces.
- **Priority on an AI-sourced action still comes from the model's recommendation.** There is no alert
  rule to contradict on that path, so nothing deterministic exists to derive it from; the reader
  confirms it on the form before the action is created.
- **The two LOW findings from the Phase 1–7 final audit remain open** (route-table drift; untyped
  health rule ids).
