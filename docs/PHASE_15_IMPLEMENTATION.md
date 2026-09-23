# Phase 15 — Adviser / CFO Command Centre

Status: implemented on `main` from the Phase 14 baseline `f5334be`. Decisions: ADR-112 (access, read model, attention, surfaces), ADR-113 (adviser analyst). Not independently audited: this file was written by the implementing session and says what was built and what was verified, and nothing more.

## 1. Objective

Give every adviser-capable user — a MOTION employee, a super admin, and an owner or admin of several organisations — one secure screen over the organisations they may manage, answering first "which clients need my attention?", then what alerts and actions stand, and letting them drill into each client's existing pages. It is a projection over what MOTION already established. It is not a CRM, a second engine, a second alert or action lifecycle, or an unrestricted admin screen.

## 2. Architecture

```
api.my_organizations()  ──►  services/access.ts        the resolver: adviser roles only, else NotFound
        (RLS)                       │
                                    ▼
health_current ─┐            services/portfolio.ts     five scoped statements → PortfolioView
alerts ─────────┼──(ids + RLS)──►   │                   counts · attention queue · client rows · recent
actions ────────┘                   ▼
                             domain/attention.ts       fixed weights, deterministic order
                                    │
        /portfolio  /portfolio/alerts  /portfolio/actions  /portfolio/clients/[orgId]
                                    │
                             domain/briefing.ts        digest → model → groundBriefing
                             services/adviser.ts       begin turn (DB re-checks scope) · call · finish
                                    ▼
                             portfolio_ai_turns        own rows; written by api_server only
```

Module: `src/modules/portfolio` (`domain/` pure, `data/` reads, `services/` the resolver, the read model and the analyst). Pages: `src/app/portfolio/**`. Components: `src/components/portfolio`. One migration: `20260924000001_portfolio_ai.sql`.

## 3. Role model and authorisation contract (ADR-112 §1–2)

| Role | Command Centre | Over |
|---|---|---|
| Super admin (aal2) | yes | every organisation not deleted |
| Employee (aal2) | yes | organisations with an active, in-window assignment |
| Owner | yes | organisations where the membership role is `owner` |
| Admin | yes | organisations where the membership role is `admin` |
| Client | **no** — uniform 404 on every `/portfolio` path | — (own organisation's pages only, unchanged) |
| Stranger / signed out | 404 / redirect to sign-in | — |

The set is the database's (`app.accessible_org_roles()` through `api.my_organizations()`), filtered to those four roles. Middleware no longer 404s members on `/portfolio`; the layout does, after asking the database. No new role, no new permission, no permission changed.

## 4. Employee assignment

`organization_assignments` is reused unchanged. An employee's portfolio is exactly the assigned organisations; revoking an assignment removes the organisation and its facts on the next request (no new sign-in), and revoking the last one removes the portfolio (proved in `portfolio.test.ts`). An employee at aal1 has no portfolio, because `app.accessible_org_roles()` grants a platform employee nothing at aal1.

## 5. Tenant isolation

Three layers agree, and the tests exercise all three:
1. the resolver never hands a page an organisation the caller does not advise (the client-detail page 404s on any other id);
2. every read statement carries the authorised ids;
3. RLS decides the rows. `portfolio.test.ts` bypasses the resolver and puts a foreign organisation's id straight into the statements: the employee gets none of its health, alerts or actions, and the counts move by nothing.

The adviser analyst's scope is re-checked in the database (`api_server.portfolio_ai_begin_turn` with `app.org_role_of`) before any row exists.

## 6. Portfolio queries (ADR-112 §3)

| Statement | Table | Predicate | Cap |
|---|---|---|---|
| organisations | `api.my_organizations()` | RLS | — |
| health | `health_current ⋈ health_scores`, `fiscal_periods` (complete) | `organization_id in (ids)` + RLS | latest 2 complete months per org, in memory |
| standing alerts | `alerts` | ids, `status in (open, acknowledged)` | 1,000 |
| open actions | `actions` | ids, `status in (open, in_progress)` | 1,000 |
| recently finished | `actions` | ids, `status in (completed, dismissed)`, `updated_at ≥ now − 7 days` | 50 |

Indexes used: `alerts_status_severity (organization_id, status, severity)`, `actions_worklist (organization_id, status, priority, due_date)`, `health_scores_by_period`. The statement count is the same for four clients and forty; no per-organisation loop exists anywhere in the module. Measured on the journey fixture and the integration fixtures the page renders in well under a second; no query plan was profiled on a large portfolio (§16 of this file).

## 7. Health, alerts, actions — integration, not duplication

- **Health**: the Phase 6 score as written (`health_scores` via `health_current`), band from the health module's own `bandFor`, trend from the previous complete month. No score → "Not yet scored", never a zero.
- **Alerts**: the alert engine's rows; severity and status as written; drill-down to `/app/[slug]/insights/alerts/[id]` where acknowledging and resolving live; evidence via the alert's current revision bundle.
- **Actions**: the Phase 10 rows; lenses reuse `inView`, `isOverdue`, `byUrgency`; drill-down to `/app/[slug]/actions/[id]` where the lifecycle lives. Nothing is created, assigned or moved from the Command Centre.
- **Attention** (ADR-112 §4): weights 100 critical alert · 80 health band fell · 70 health at risk · 60 overdue action · 50 high alert · 45 suspended · 40 urgent action · 30 score fell ≥ 10 · 20 needs attention; order = max, sum, name.

## 8. AI (ADR-113)

Digest built from the authorised view → one model call with the briefing tool forced → references and numbers held to the digest → recorded. The model has no tools. Eight eval cases; ten integration cases with a recording fake model, including the model being handed a scope of two while a third organisation with a "secret" alert exists, and the database refusing a forged scope.

## 9. Evidence

No new evidence store. Every alert and action row links to its organisation's existing evidence bundle (`/app/[slug]/evidence/[bundleId]`); health links to the organisation's Home, where the explainability panel and its bundle live; the analyst's citations resolve to real alert and action ids in the scoped organisations and render as links into those pages. Any financial number an adviser reaches from here is shown on the organisation's own pages, with their basis, assurance and drill-down.

## 10. Performance

See §6. Server-side parallel loading (`Promise.all` over the four data statements after the resolver). Caps are stated on the page as counts so nothing is silently truncated. Not done: profiling on a portfolio of hundreds of organisations; pagination of the client list (25 in the queue, the full list rendered).

## 11. UX

First screen: the attention queue, then the counts, then every client, then recent changes (brief §15). At `< md` the client list renders as cards; the alert and action tables scroll inside their wrapper, not the page. Verified by the journey at 375 and 768 px: page-level horizontal overflow is 0 on `/portfolio`, `/portfolio/alerts`, `/portfolio/actions`, `/portfolio/analyst` and a client page; screenshots at 1440/768/375 in `e2e/.shots` (ignored). The Command Centre is reachable from the tenant header ("Command Centre", shown to holders of `assignments.view`) and from the organisation picker.

## 12. Test strategy

| Suite | File | What it proves |
|---|---|---|
| Unit | `test/unit/portfolio-attention.test.ts` | attention rules, order, band/score rules, adviser-role filter |
| Integration | `test/integration/portfolio.test.ts` (14) | role × portfolio matrix (six callers), aggregate counts over the authorised population only, adversarial foreign ids with the resolver bypassed, assignment revoked mid-session |
| Integration | `test/integration/portfolio-ai.test.ts` (10) | what the model is handed, what the database accepts as a scope, what the server keeps of an answer |
| Eval | `test/eval/portfolio-eval.test.ts` (8) | the brief's eight cases against the digest/grounding contract |
| pgTAP | `supabase/tests/14_portfolio.test.sql` (9) | table privileges, forced RLS, policies, api_server grants |
| Playwright | `e2e/journey-15-command-centre.spec.ts` | owner of two organisations: queue, drill-down, alerts, actions, analyst page, 375/768 px; client: 404 on every `/portfolio` path |

Not covered in the browser: a platform employee's session (needs TOTP), covered at the database and API instead.

## 13. Security model

No migration touches an existing table, policy, grant or permission. The new table has forced RLS (own rows or super admin), no user write privilege, and is written only by two `api_server` functions callable by the service role, which re-validate the actor. The model receives no data outside the caller's resolved scope. Middleware keeps the session and MFA gates for the `/portfolio` family; the layout renders the uniform 404 for anyone without a portfolio.

## 14. Known limitations

- No daily quota on adviser questions (the AI quota is per organisation); a 10/min per-user throttle only.
- The adviser analyst carries no financial figures beyond the health score by design; it points to the client's pages.
- A platform employee's browser journey is not e2e-tested (TOTP); the boundary is proven at the database and API.
- No pagination of the client list; caps are portfolio-wide and stated as counts.
- "Last data date" is not shown; the client row states the latest scored month instead.
- Journeys create the second organisation through `api.create_organization` with the owner's JWT claims set on the SQL session, because onboarding is a first-organisation form.
