# PLAN — Phase 12: What-If Scenarios (REQ-SC-01…10)

Stack: fixed by the repo — Next.js 16 App Router, TypeScript strict, Supabase/Postgres with RLS, Vitest + pgTAP + Playwright. New module `src/modules/scenarios`; one migration.
Riskiest thing: a scenario that quietly contradicts the engine, or invents a relationship (a margin, a payment date, an interest rate) the data does not define. Mitigation, decided before code: a scenario is only a set of deltas applied to the **forecast's leaf levels**, re-composed through the **same** identity/cash-chain function the forecast uses — so the arithmetic cannot diverge — and any assumption whose leaf has no baseline makes the whole scenario unavailable with a stated reason. No spike: the mechanism is an extraction of code that already runs green.

1. [x] Extract `composeFromLevels` out of `forecast/domain/compose.ts` (per-period leaf levels → identities → cash chain); `composeForecast` becomes its caller. Behaviour-preserving.
   Verify by: `npm run test:unit` — the 33 Phase 11 forecast-baseline tests pass unedited.
2. [x] `scenarios/domain`: `config.ts` (bounds, the 8 kinds, cash defaults), `types.ts`, `assumptions.ts` (Zod parse, per-kind rules, conflict rules).
   Verify by: new `test/unit/scenario-assumptions.test.ts` green; bad input yields a named error, never 0.
3. [x] `scenarios/domain/apply.ts`: assumptions + forecast leaf levels + category baselines → baseline-vs-scenario cells via `composeFromLevels`; unavailability instead of a guess.
   Verify by: new `test/unit/scenario-apply.test.ts` green, incl. determinism, order-independence, and one case per assumption kind.
4. [x] Migration `20260921000001_scenarios.sql`: `scenario_runs` + `scenario_values`, RLS force, zero write grants, `api_server.finish_scenario`, `api.archive_scenario`, evidence kind `scenario`.
   Verify by: `npx supabase db reset && npx supabase test db` PASS and `npx tsx scripts/check-schema-drift.ts` reports 48 tables.
5. [x] `scenarios/data` + `scenarios/services`: `runScenario`, `loadScenario`, `listScenarios`, `archiveScenario`; permissions `dashboard.view` (read) / `intelligence.recompute` (write).
   Verify by: `npm run typecheck && npm run lint` exit 0.
6. [x] Route `/app/[orgSlug]/what-if` (+ `[scenarioId]`), linked from Forecast and Money; plain-language form, BASELINE vs SCENARIO, assumptions on the page.
   Verify by: `npm run build` exit 0 and the two routes listed in its output.
7. [x] AI: tool 19 `get_scenario` (read-only), refusal template split, `PROMPT_VERSION` → `analyst-v3.2`, corpus cases, re-record.
   Verify by: `npm run ai:eval` green with the recorded fixture stamped `analyst-v3.2`.
8. [x] Integration suite `test/integration/scenarios.test.ts`: storage, immutability, RBAC, employee assignment, tenant isolation, adversarial, AI tool.
   Verify by: `npm run test:integration` green.
9. [x] Playwright `e2e/journey-12-what-if.spec.ts`: a non-technical owner runs and saves a scenario; no database words on screen.
   Verify by: `npx playwright test journey-12` green.
10. [x] Documents: `docs/PHASE_12_IMPLEMENTATION.md`, ADR-100, and the DATABASE/AI/PRD/UX/SERVICE/MVP updates the drift gate and the reader need.
    Verify by: `npx tsx scripts/check-schema-drift.ts` exit 0 with the new tables and function documented.
11. [x] Full regression, every gate, reported verbatim.
    Verify by: typecheck, lint, unit, pgTAP, drift, integration, eval, build, Playwright all exit 0.
