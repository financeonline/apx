# Phase 15 — Adviser / CFO Command Centre

Status: implemented on `main`. The Phase 14 baseline was `f5334be`, the first implementation `bab3a68`, and the remediation of that commit's independent audit is ADR-114. Decisions: ADR-112 (access, attention, surfaces), ADR-113 (adviser analyst), ADR-114 (integrity closure). This file was written by the implementing session. It says what was built and what was verified, and is not an independent audit.

## 1. Objective

Give every adviser-capable user one secure screen over the organisations they may manage. That means a MOTION employee, a super admin, and an owner or admin of several organisations. The screen answers first "which clients need my attention?", then what alerts and actions stand. From there the user drills into each client's existing pages. It is a projection over what MOTION already established. It is not a CRM, a second engine, a second alert or action lifecycle, a second evidence store, or an unrestricted admin screen.

## 2. Architecture

```
api.my_organizations()        services/access.ts        adviser roles only; else, for an active aal2
        (RLS resolver)  ──►   (+ resolvePlatformRole)   platform account, an EMPTY portfolio; else NotFound
                                     │
api.portfolio_summary  ──(ids, one statement, uncapped)──►  counts · health (latest 2 complete) · attention
alerts / actions       ──(ids + RLS, ordered, capped 500)──►  detail lists that carry their full total
recent alerts / actions ─(ids + RLS, 7 days, capped 50)───►  recent changes
                                     │
     /portfolio   /portfolio/alerts   /portfolio/actions   /portfolio/clients/[orgId]   /portfolio/analyst
                                     │
                     domain/briefing.ts   digest of facts → forced submit_briefing → claim-level grounding (ADR-115)
                     domain/quantities.ts every quantitative claim a sentence makes (digits, words, fractions, multipliers)
                     services/adviser.ts  begin turn (DB re-checks scope, throttles) · model · finish turn
                                     ▼
                     portfolio_ai_turns   readable only while the author CURRENTLY advises the whole scope
```

Code: `src/modules/portfolio` (`domain/` pure, `data/` reads, `services/` resolver, read model, analyst), `src/app/portfolio/**`, `src/components/portfolio`. Migrations: `20260924000001_portfolio_ai.sql`, `20260925000001_portfolio_integrity.sql`.

## 3. Role model and authorisation contract

See `ROUTE_ARCHITECTURE.md §5.1` for every caller. In short:

| Role | Command Centre | Over |
|---|---|---|
| Super admin (aal2) | yes | every organisation not deleted |
| Employee (active, aal2) | yes — an empty state until the first assignment | active, in-window assignments |
| Owner / admin | yes | organisations held in that role |
| Client | no — uniform 404 on every `/portfolio` path | — (own organisation's pages, unchanged) |
| aal1 platform account / suspended / stranger | no (MFA redirect / 404 / 404) | — |

The set is the database's own: `app.accessible_org_roles()` through `api.my_organizations()`, filtered to the four adviser roles. The database twin used by the aggregate and by the AI-turn policy is `app.adviser_org_ids()`. No role or permission was added or changed.

## 4. Employee assignment

`organization_assignments` is reused unchanged:
- An employee's portfolio is exactly the assigned organisations.
- Revoking one removes it, its counts and its facts on the next request.
- Revoking the last leaves an empty Command Centre.
- Reassigning restores access.

All of this is proved in `portfolio.test.ts` and `portfolio-ai.test.ts`.

## 5. Tenant isolation

Every read is scoped three ways, and the tests exercise each:
1. **The resolver.** No page is handed an organisation the caller does not advise, and a client page 404s on any other id.
2. **The statements.** Every statement carries the authorised ids, and the aggregate intersects them with `app.adviser_org_ids()`.
3. **RLS.** It decides the rows.

The tests put foreign ids straight into the statements with the resolver bypassed, and nothing of the foreign organisation is returned or counted. An unauthorised organisation with hundreds of critical alerts and overdue actions changes no count (`portfolio-scale.test.ts`).

## 6. Portfolio reads (ADR-114)

| Read | Source | Scope | Size |
|---|---|---|---|
| organisations | `api.my_organizations()` | RLS resolver | one row per organisation |
| **all counts + health** | `api.portfolio_summary(orgs, today, due_soon_until)` | `orgs ∩ app.adviser_org_ids()` | one row per organisation; **uncapped**; health = latest and previous complete scored month, ranked in SQL |
| alert detail | `alerts` | ids + RLS, open/acknowledged | worst first, ≤ 500, with the full total |
| action detail | `actions` | ids + RLS, open, lens as predicate | `byUrgency` order, ≤ 500, with the full total |
| recent feeds | `alerts`, `actions` | ids + RLS, last 7 days | ≤ 50 each |

**Aggregate strategy:**
- No count anywhere in the Command Centre is derived from a detail list: not the page headings, the strip, the lens tabs, the client rows, or the attention reasons.
- A capped list says so in the page: "Showing the first N of M, worst first. Every count on this page is the full number."
- PostgREST's `max_rows` (1,000) is never relied on for correctness. Detail reads set their own limit below it, and the aggregate returns one row per organisation.

## 7. Health, alerts, actions — integration, not duplication

- **Health** is the Phase 6 score as written, with the band from the health module's `bandFor`. The trend compares against the previous complete *scored* month, which the page names. A client with no scored complete month reads "Not yet scored", never zero; a score on an incomplete month is ignored.
- **Alerts** are the alert engine's rows. Severity and status are as written; open and acknowledged count as standing. The drill-down goes to `/app/[slug]/insights/alerts/[id]`, where the lifecycle lives.
- **Actions** are the Phase 10 rows. Overdue, due soon (`DUE_SOON_DAYS`) and urgent are the Action Centre's rules, evaluated in the aggregate and the lens predicates. The drill-down goes to `/app/[slug]/actions/[id]`. Nothing is created, assigned or moved from the Command Centre.
- **Attention** (ADR-112 §4) uses fixed weights: 100 critical alert · 80 health band fell · 70 at risk · 60 overdue action · 50 high alert · 45 suspended · 40 urgent action · 30 score fell ≥ 10 · 20 needs attention. Order is max, then sum, then name. Every reason comes from the aggregate.

## 8. AI (ADR-113, ADR-114 §5, ADR-115)

- **Data boundary.** The server loads the caller's authorised view and builds a digest of it. The model sees that digest and nothing else. It has **no data or database tools** and exactly **one forced structured-output tool**, `submit_briefing`.
- **Scope re-check.** The turn opens in the database, which re-checks the scope against the actor with `app.org_role_of` and charges a **10 per minute per user** throttle before any model call.
- **Grounding (ADR-115).** Every number the digest states is a fact with an id, subject, metric, period, unit and value (and, where it applies, a required noun, excluded qualifiers and a direction). The model cites fact ids per headline, summary and note.
  - **What counts as a claim.** `domain/quantities.ts` reads every quantitative claim in a sentence: digits and number words through the AI module's claim grammar (one grammar, §7.9), then fractions ("one and a half"), multipliers ("doubled", "halved", "3x" — unit `multiple`), "one"/"zero"/"no" before a counted noun or unit, and each claim's unit (`%`, `pc`, `pct`, months, points, money; `pp` and days are units no fact has).
  - **Binding.** Each claim must be bound to ONE cited fact with the same exact value, unit, metric (read from the claim's own clause), subject (the client the sentence names), period and direction.
  - **Unbindable claims.** Hedged figures ("about 20%"), claims with no exact value ("a third", "three times higher") and magnitudes with no figure ("sharply", "significantly") bind to nothing.
  - **Titles.** A cited alert or action title may be quoted, exactly and in quotation marks; it is text, never a fact, and a title with a unit against it is refused.
  - **Removal.** A sentence with any unbound claim is removed and the turn is `degraded`; one valid claim never rescues another. Foreign clients and citations are dropped. A malformed answer is `failed` and never rendered.
- **The badge.** *Grounded* is shown only for a turn the server stored `passed`; *Partly grounded* for `degraded`. The page reads `grounding_status`; nothing on the client decides it.
- **Stored turns** are readable only while the author currently advises every organisation in the turn's scope (or by a super admin at aal2).
- **No daily quota** exists for adviser questions. That is a documented limitation, not a control: quotas are per organisation.
- **No financial figures** are in the digest beyond health scores and counts. The analyst says so and points to the client's pages.

## 9. Evidence

There is no new evidence store:
- Alert and action rows link to their organisation's existing evidence bundles.
- Health links to the organisation's Home, where the explainability panel and its bundle live.
- The analyst's citations resolve to real alert and action ids in the scoped organisations.

## 10. Performance

- **Overview:** 1 resolver call + 1 aggregate + 2 recent feeds.
- **Alerts / actions pages:** the overview reads plus one capped detail read.
- **Client page:** the overview reads plus two capped detail reads for that organisation only.

No statement loops per organisation. The aggregate uses the existing `alerts_status_severity`, `actions_worklist` and `health_scores_by_period` indexes. **No latency benchmark has been run**, so no timing claim is made. The scale tests (1,053 alerts, 1,023 actions, 49 organisations with 24 scored months each) prove correctness, not speed.

## 11. UX

The first screen shows the attention queue (the first 25, with a note if more), then counts, then every client, then recent changes. Below `md` the client list renders as cards; the alert and action tables scroll inside their wrapper, never the page. At 375, 768 and 1440 px page-level horizontal overflow is 0 on every Command Centre page (journey-15; the audit probe). The four main pages are in the permanent axe and overflow sweep (`e2e/accessibility.spec.ts`). The counts strip is a list (the earlier `dl` misuse is fixed).

## 12. Test strategy

| Suite | File | What it proves |
|---|---|---|
| Unit | `test/unit/portfolio-attention.test.ts` | attention rules over aggregate counts, order, band/score rules, adviser-role filter |
| Integration | `test/integration/portfolio.test.ts` | role × portfolio matrix, counts over the authorised population, forged ids with the resolver bypassed, revocation, the unassigned employee's empty state (aal2) vs 404 (aal1, suspended) |
| Integration | `test/integration/portfolio-scale.test.ts` | > 1,000 alerts and actions (counts, attention, capped lists that say so), unauthorised volume, 45 × 24 scored months, health edge cases |
| Integration | `test/integration/portfolio-ai.test.ts` | what the model is handed, what the database accepts as a scope, what the server keeps (incl. a figure in words stored `degraded`, and a numeric title that cannot launder a figure), stored-turn access after revocation / reassignment / multi-organisation / client / other adviser |
| Unit | `test/unit/portfolio-quantities.test.ts` | the quantity reader (ADR-115): digits, every percent spelling, number words, fractions, multipliers, "one"/"no" before a counted noun, approximation and unquantified magnitude, periods/ordinals/references/names that are not quantities, quoted titles set aside and a title used as a figure refused, clauses |
| Eval | `test/eval/portfolio-eval.test.ts` | the eight brief cases; the fact-specific grounding cases (MEDIUM-D); and the claim-level cases (ADR-115): figures in words with and without their fact (A–F), multipliers, direction, two claims in one sentence, wrong metric/period/organisation with a matching number, hedged and unquantified language, alert and action titles containing numbers, and honest answers that must still pass |
| pgTAP | `supabase/tests/14_portfolio.test.sql` | privileges, forced RLS, policies (incl. current-access read), api/api_server grants |
| Playwright | `e2e/journey-15-command-centre.spec.ts`, `e2e/accessibility.spec.ts` | owner of two organisations end to end; client refused; the analyst labels a stored `degraded` turn *Partly grounded* and never *Grounded* (ADR-115); 375/768 px; axe and overflow on the Command Centre |

Every ADR-114 blocker test was run against `bab3a68` (its code and its migrations) and failed there for the defect it targets. The ADR-115 tests were run against `71fd748`'s grounder: 33 of the new eval cases and both new integration cases fail there; the independent audit's ten grounding probes (3 of which failed on `71fd748`) all pass.

## 13. Security model

- **Existing tables and policies.** No migration changes an existing table's policy or grant, except the Phase 15 table's own read policy (ADR-114 §4).
- **New objects.** `api.portfolio_summary` is security definer and scopes itself to the caller's adviser organisations. `app.adviser_org_ids()` reads the one resolver.
- **The turn table.** It has forced RLS, no user write privilege, and `api_server`-only writes that re-validate the actor.
- **Middleware.** It keeps the session and MFA gates. The portfolio layout renders the uniform 404 for anyone without a portfolio and the empty state for an eligible platform account without clients.

## 14. Known limitations

- No daily quota on adviser questions; the 10/min per-user throttle is the only limit.
- The adviser analyst carries no financial figures beyond health scores and counts.
- Grounding reads metric, period and subject per clause (ADR-115). Two claims inside ONE clause with no break between them share that clause's words, so two same-unit values could cross only when both exist in cited facts of metrics that clause names.
- "None" is not read as zero, and relative periods ("this quarter", "last month") are not read as periods.
- The grounder fails closed: an unquoted title containing a number, two counts joined without a clause break, or a pronoun-only sentence in the headline or notes stating a client's figure is removed. The prompt (`adviser-v2.1`) steers the model away from each.
- No live Claude model has been run against the adviser analyst (no API key in the build environment). Every grounding test uses the deterministic validator and a fake transport; the validator does not depend on the model.
- A platform employee's browser session is not e2e-tested because it needs TOTP; the boundary is proven at the database and API.
- No pagination of the client list, and no "last data date" column; the latest scored month is shown.
- Health trend compares with the previous complete *scored* month, which may not be the calendar month before; the page names both months.
- Acknowledged alerts count as standing and can place a client in the attention queue. Tenant Home's top risks show open alerts only (ADR-112 choice).
- No latency benchmark has been run (§10).
