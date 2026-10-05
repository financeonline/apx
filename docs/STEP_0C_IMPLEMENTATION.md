# Step 0C — real-validation path, FU-16, VAT consistency, Health assurance, timezone scheduling

Branch `fix/step0-import-type-mapping` (uncommitted), on `2783240`. Engine 5.0.0 → **7.0.0** (6.0.0 was never released). Health `health.config.v1` → `v2`.
Records: ADR-132 (FU-16 and run refs), ADR-133 (VAT footing and setting), ADR-134 (Health inferred cap, for sign-off), ADR-135 (hourly enqueue).

## 1. Real validation: blocked, and the path to unblock it

The authoring environment has no container runtime (no Docker Desktop, OrbStack, Colima, Podman or Lima) and no `gh` CLI. The existing `ci.yml` runs pgTAP, schema drift and integration on GitHub runners, but only for `main`.

Prepared:
- **`.github/workflows/validate-step0.yml`** runs on manual dispatch, or a push of a `fix/step0-*` branch. Four jobs:
  1. static, unit with the coverage gate, AI eval and build;
  2. a clean database: pgTAP, schema drift, integration and Playwright;
  3. an UPGRADE: start Supabase on the baseline's migrations, compute 5.0.0 figures with the baseline's code, apply the new migrations with `supabase migration up`, then pgTAP, drift and integration on the upgraded database;
  4. the 27-organisation engine comparison, baseline worktree against branch, uploaded as an artifact.
- **`scripts/validate-step0.sh clean|upgrade|compare`** — the same, locally with Docker.
- **`scripts/write-local-env.sh`** — writes `.env.local` from `supabase status`, and refuses any non-local URL.

## 2. FU-16 (ADR-132)

| Item | Status |
|---|---|
| Queued coalescing keeps the union (`refs`), full-range trigger dominates, scheduled gives way | Implemented (migration 0003, `periodsTouchedByAll`) |
| Atomic enqueue (`insert … on conflict do update`) | Implemented |
| One calculation per organisation at a time (claim serialised; skip an org with one running) | Implemented |
| Retry / lost-worker coalescing preserves the union | Implemented (merge function shared with 0002) |
| Found while fixing: banking-edit, supersede and opening-flag recalculations refused at `calculation_runs` insert | Fixed in the handler (`runTriggerRef`). Confirmed by reading the code; NOT yet reproduced on a real database |
| Tests | `calculation-coalescing.test.ts` (integration, not run); `run-trigger-ref.test.ts` (unit, run) |

## 3. VAT (ADR-133)

Both days figures now use one rule (`vatFooting`), from recorded facts:
- **Invoice basis:** the lists' gross totals. The purchase totals need a full purchase list establishing every month of the window (the FU-15 effective range), else `insufficient_history`. A partial list is never read as total costs.
- **Balance basis:** a flow only when its footing is gross. Otherwise `vat_basis_unknown`.
- **No default rate is ever used.**

The VAT-status setting is in place (`api.set_vat_registration`, Settings → VAT; unknown stays unknown; audited; queues a full recalculation). pgTAP 20 covers it but has not been run.

**Not changed:** `api.update_organization` still replaces the whole `settings` object, and changing the fiscal year or timezone still triggers no recalculation (both pre-existing; recorded as defects).

## 4. Health (ADR-134, for sign-off)

| Input assurance | Treatment |
|---|---|
| `verified` / `calculated` | No cap |
| `estimated` or proxy | Capped at 70: "based on bank data only" (unchanged) |
| `inferred` | Capped at 70 (the existing number): "includes figures read from a PDF by AI" |
| Both | One cap, both reasons |

The explanation renders the stored reason (`capNote`). Tests cover the score, the reason and the sentence shown.

## 5. Scheduling (ADR-131, ADR-135)

- **Enqueue:** hourly (`/api/jobs/scheduled`). An organisation is due when its latest SUCCEEDED run's `as_of` is before its local today, and the database allows one scheduled job per organisation and local date.
- **pgTAP 19** (not run) covers UTC−7, +5:30, +14 and −11, London spring-forward, Los Angeles fall-back (the repeated hour), hourly re-ticks, the waiting-job rule and suspended organisations.
- **Unit:** the rollover range (closed month recomputed after any number of missed days, by any trigger), and both cron routes.

## 6. Fresh results (isolated copy, portable Node 24.21, 2026-10-05)

| Check | Result |
|---|---|
| Typecheck | PASS |
| Lint | PASS |
| Unit | 2,284 / 2,284 |
| Coverage gate | PASS (engine domain 99.8% lines / 96.12% branches; health domain 99.43% / 94.28%) |
| AI eval (recorded) | 253 / 253 |
| Production build | PASS (includes `/api/jobs/scheduled`) |

**Blocked: no Docker.** pgTAP (including the new 17–20), integration (including the new two), schema drift, Playwright, the upgrade-path run, and the 27-organisation comparison.

## 7. Remaining defects

| ID | Defect |
|---|---|
| FU-5, ADR-124 R-1 | NULL rather than wrong; need anchor decisions |
| FU-11 | Evidence only |
| ORG-SETTINGS (new) | `api.update_organization` overwrites `settings` wholesale, and a fiscal-year or timezone change queues no recalculation |
| The opening cash after an AI-read month | Not downgraded (ADR-130 limitation) |

## 8. Separate in-session review (same model, fresh context — NOT independent)

A review agent with no shared working context re-read the full diff against the Phase 16 gate. Its findings and their disposition:

| # | Finding | Disposition |
|---|---|---|
| 1 | `app.merged_calculation_payload` not definer → `00_structure` fails | Fixed: added to the pure-helper list (jsonb arithmetic, no table) |
| 2 | pgTAP 19 used a zero-argument signature | Fixed (`timestamptz`) |
| 3 | pgTAP 19 Pago Pago hour boundary wrong | Fixed (10:59 → 0, 11:00 → 1, 12:00 → 0) |
| 4 | One invalid timezone stops the hourly enqueue for every tenant | Fixed: the enqueue joins `pg_timezone_names`; a trigger refuses unknown timezones on write |
| 5 | A lost worker on its last attempt was re-queued unclaimable and froze the organisation's queue slot | Fixed: it becomes `dead` and is audited |
| 6 | SQL refused "10%Off Ltd" which TypeScript allows; a refusal left the batch half-prepared | Fixed: the regex is aligned; the wizard fails the batch with a sentence (unit test) |
| 7 | `app.normalize_name` folds non-ASCII letters ("Müller" = "Möller"); a non-Latin name normalises to empty | **Open:** pre-existing normaliser, now on the automatic path. Empty names fail visibly (`IMP-CP-016`); collisions are silent. Needs a Unicode normaliser and a re-derivation migration (decision) |
| 8 | No current fiscal period → the scheduled run computed nothing | Fixed: the enqueue creates today's period (`app.ensure_periods`) |
| 9 | Days figures unavailable for every ledger/TB organisation until a VAT status is set | Product consequence of ADR-133; the setting now exists |
| 10 | `api.update_organization` could write or erase `vat_registered` | Fixed: refused in a patch, preserved on replace; a fiscal-year, timezone or settings change now recalculates |
| 11 | `finish_job` twin lookup unlocked (self-healing 23505) | Open, LOW |
| 12 | A scheduled payload's `as_of` is pinned at enqueue; `api.enqueue_job` merges with `\|\|` | Open, LOW (self-heals next hour) |
| 13 | A deferred non-calculation job with a twin lost its payload | Fixed: merged `payload \|\| twin` |
| 14 | `claim_job` takes a global advisory lock; the hourly cron needs a Vercel plan with hourly crons | Accepted (claims are milliseconds); plan dependency noted |
| 15 | Stale docs | Fixed (0B records annotated; ADR-131 amended) |

Fresh results after the fixes: typecheck, lint, unit 2,285/2,285, coverage gate, AI eval 253/253 and the production build all pass. Every database-side fix above is still unrun.

## 9. Interim behaviour during validation (not final acceptance)

### Days figures: the combinations that remain supported

| Days figure | Balance comes from | Flow comes from | VAT status | Result |
|---|---|---|---|---|
| receivables_days | invoices (a full sales list each month of the window) | the same lists' gross totals | any | **stated** |
| receivables_days | balance sheet / TB / ledger | ledger / TB / P&L revenue | not registered | **stated** |
| receivables_days | balance sheet / TB / ledger | ledger / TB / P&L revenue | registered | unavailable, `vat_basis_unknown` |
| receivables_days | balance sheet / TB / ledger | ledger / TB / P&L revenue | not set | unavailable, `vat_basis_unknown` |
| receivables_days | balance sheet / TB / ledger | bank proxy, not netted (no default rate, or not registered) | any | **stated** |
| receivables_days | balance sheet / TB / ledger | bank proxy netted by the default rate | registered with a rate | unavailable, `vat_basis_unknown` |
| receivables_days | balance sheet / TB / ledger | invoice-basis revenue (net) | any | unavailable, `vat_basis_unknown` |
| payables_days | the same rows, with purchase lists and expense base instead of sales and revenue | | | the same results |

Also unavailable whatever the VAT status:
- an open-items list in the receivables window (`open_items_only`);
- a month of the window not established by a full list (`insufficient_history`);
- the current month to date.

This is conservative and interim. It is NOT acceptance that ledger-based VAT-registered businesses go without days figures. Restoring them needs recorded tax per line (a VAT-control-account method) or an approved estimate labelled `estimated`, which is a product decision.

### Health cap of 70 for AI-read inputs: implemented, product approval outstanding

Computed with the real scorer (`computeHealthScore`), the same inputs scored once as verified and once with the cash inputs inferred:

| Business | Verified | Cash AI-read |
|---|---|---|
| Strong or typical cash flow | Cash Flow 95, total 78 (stable) | Cash Flow **70** (capped, "includes figures read from a PDF by AI"), total **72** (stable): −25 × 25% weight ≈ −6 |
| Weak cash flow | Cash Flow 25, total 60 | Cash Flow 25 (the cap is a ceiling, never raises a score), total 60; the reason is still shown |

### Unicode names: RELEASE BLOCKER (reproduced)

Reproductions (`test/unit/import-wizard-path.test.ts`, "names outside ASCII"), run on the real wizard against the stored key `app.normalize_name`:

1. "Müller GmbH" and "Möller GmbH" in one file were booked to ONE auto-created customer. This was a silent merge.
2. A file row "Möller GmbH" was silently matched to an existing "Müller GmbH".
3. "株式会社トヨタ" and "شركة الأمل" reduce to the empty key: they were never created, and the row was refused with the generic IMP-CP-016.

**Interim guard (in this branch).** The import path compares the stored-key match letter by letter (`letterNameKey`: NFKC, every script):
- a mismatch stops the row with **IMP-CP-017** (never merged);
- a name the key cannot hold stops with **IMP-CP-018**;
- the same customer in capitals or with different punctuation still matches;
- no existing customer is read differently, merged or rewritten.

**Still a blocker.**
- Valid customer names in Arabic, Japanese, Greek, Cyrillic and so on cannot be imported at all.
- Accented names that share a key with an existing customer cannot be imported.
- Ledger ACCOUNT names created by imports go through the same key, unguarded.

**Proposed collision-safe migration (not applied).**
1. Dry run first: `scripts/sql/unicode-names-dry-run.sql`. It is read-only; its one temporary view is rolled back. It reports:
   - rows with an empty stored key;
   - rows whose key drops letters;
   - collisions the NEW key would create;
   - invoice rows already booked to a counterparty whose name differs in letters (past silent merges).
   It also runs in the validation workflow against the test database.
2. Add `normalized_name_v2` (the NFKC every-script key) beside the old key. Build the new unique index CONCURRENTLY, and only if report 3 is empty for every organisation.
3. Switch the import path and `app.derive_normalized_name` to v2. Keep v1 read-only for one release.
4. Never auto-merge. Rows that report 4 lists go to a review queue (`customers.edit`); a person decides to split or keep.
5. Drop v1 after a release with zero report-4 rows.
