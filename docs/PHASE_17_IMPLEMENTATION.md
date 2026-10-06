# MOTION — Phase 17 Implementation
## Intelligent Reporting (REQ-RP-02…07; Agreement Phase 1 §22; ADR-141)

**Status: BUILT LOCALLY — branch `feat/phase17-reporting`, on top of `fix/step0-outstanding-findings` (`41409b5`), which is itself awaiting independent re-review.** Nothing here is pushed, merged or deployed. This document is the developer's record. It is not an independent review.

### Legend

| Tag | Meaning |
|---|---|
| **AGREEMENT** | Phase 1 Statement of Work & Commercial Agreement (v2.0), §22 and Annexure A. |
| **DECIDED** | Decided by the product owner on 2026-10-06 (R17-1…R17-4, ADR-141). |
| **INTERPRETATION** | The agreement names the item without defining it. This is the developer's reading, and the owner has to confirm it in writing. |
| **BLOCKED** | Depends on work that may not start yet. |
| **EXCLUDED** | Outside Phase 1 by the agreement. |

---

## 1. Scope

| Report (Agreement §22) | Purpose (verbatim) | Status |
|---|---|---|
| Daily Executive Brief | Key movements, risks, opportunities and actions. | Built (§3) |
| Daily Challenges | Key movements, risks, opportunities and actions. | **INTERPRETATION / DECIDED (R17-2):** the brief's "What needs attention today" section (§3.3). |
| Weekly Intelligence Report | Financial changes, causes and unresolved issues. | Built (§4) |
| Weekly Development Comparison | *(no purpose given)* | **INTERPRETATION / DECIDED (R17-2):** the weekly report compares every interim figure with the week before (§4.2). |
| Monthly Management Report | Financial, cash, commercial and management analysis. | Exists (ADR-024), unchanged. The commercial section is **EXCLUDED**, because Commercial Intelligence (CRM) is out of Phase 1 (Agreement §5). |
| Accountant/CFO Report | Adviser-ready client intelligence. | Built (§6) |
| Funding Readiness Report | Indicative readiness assessment and evidence. | **Built locally, follows the Funding Readiness flag (ADR-145), not reviewed.** `report.compose` with kind `funding_readiness` freezes the latest month's CURRENT assessment (`funding_current` → `funding_assessments`) as `funding.v1`: score or "Insufficient data", coverage, the seven factors, what helps and hurts, what is missing, the actions, the disclaimer verbatim and the rules/engine/run. Nothing is recalculated. On screen and as a PDF; produced on request only (no schedule). While the flag is off the Reports page says so, `api.enqueue_job` refuses (NOT FOUND) and RLS hides earlier such reports (migrations 20261014000001/2). It inherits Phase 16's status: the assessment it reports is itself unreviewed and its prerequisite (ADR-120 recovery re-review and Health audit) is unmet. |
| Custom AI Report | User-selected period, questions and analytical dimensions. | Built (§7) |

## 2. Owner decisions (2026-10-06, ADR-141)

| # | Question | Decision |
|---|---|---|
| R17-1 | The engine computes complete months only. What are the daily and weekly reports built from? | **Both:** (a) events and the latest complete month, with no new calculation; and (b) a separate deterministic **interim** calculation of day- and week-level figures from dated records (§5). |
| R17-2 | What are "Daily Challenges" and "Weekly Development Comparison"? | Folded into the Daily Brief and the Weekly Report as sections. Recorded as an interpretation for the owner to confirm. |
| R17-3 | How are reports delivered? | On screen, as a PDF on request, **and** produced automatically on a schedule (daily, weekly) and listed under Reports. **No email:** there is no email provider, and adding one is a third-party integration outside Phase 1 (Agreement §5, §35). |
| R17-4 | How much may the AI write in the Custom AI Report? | Each question is answered by the existing AI Analyst under its existing grounding, refusal and evidence rules. The report is those answers in order. |

**Implementation note on R17-1(b).** The option offered was "extend the engine". The figures are instead computed in a **separate** pure module beside the monthly engine (`financial-engine/domain/interim.ts`, rules version `interim.v1`). Nothing the monthly engine produces reads it, and nothing it produces is stored as a metric snapshot. So the monthly engine version (15.0.0), its golden record and every monthly figure are unchanged, with no version bump and no regression record. That meets the decision (day and week figures exist) without changing a single monthly figure. The owner may prefer them in the engine proper; that would be a later, versioned change.

## 3. Daily Executive Brief

### 3.1 Window
A brief covers one **organisation-local** calendar day (`organizations.timezone`). Timestamps (alerts, actions) are compared with the UTC instants at which that day starts and ends (`core/periods/timezone.ts` `startOfLocalDay`, DST-correct). Dated records (transactions, invoices) are compared by date. For example, an alert first seen at 23:30 UTC on 7 September is on 8 September in London; the integration test pins this.

### 3.2 Sections (Agreement: key movements, risks, opportunities, actions)
| Section | Content | Source |
|---|---|---|
| Key movements | Interim figures for the day, each against the day before (§5) | interim calculator |
| Risks | Alerts raised or reopened during the day | `alerts.first_seen_at` / `reopened_at` |
| Opportunities | Invoices paid in full that day, and the latest month's favourable movements | interim calculator; Insights |
| What needs attention today | Open critical/high alerts (with counts for every severity), actions overdue (due on or before the day), actions due in the next 7 days | `alerts`, `actions` |
| Actions | Completed and created that day; alerts resolved that day | `actions.completed_at` / `created_at`; `alerts.status_changed_at` |
| The latest complete month | Headline cards, health score, adverse and favourable movements, exactly as Home and Insights show them | `buildHeadlineCards`, `loadHealthCard`, `loadInsights` |

### 3.3 Daily Challenges (R17-2)
This is "What needs attention today". "Open", "overdue" and "due soon" are **as of composition**, and the brief states when it was produced.

## 4. Weekly Intelligence Report

### 4.1 Window
A Monday-to-Sunday organisation-local week. The table enforces it (`reports_weekly_window`).

### 4.2 Sections (Agreement: financial changes, causes, unresolved issues)
| Section | Content |
|---|---|
| Financial changes this week | Interim figures for the week, each against the week before. This is the "Weekly Development Comparison" (R17-2). |
| Causes | Alerts raised during the week (each with its own explanation), and the latest month's biggest movements by money (Insights' ranking). |
| Unresolved issues | Standing alerts and overdue / due-soon actions, as for the brief. |
| Actions | Completed and created during the week. |
| The latest complete month | As for the brief. |

## 5. Interim figures (R17-1b) — `financial-engine/domain/interim.ts`, `interim.v1`

| Figure | Counts | Records |
|---|---|---|
| Money in / out / net cash movement | Accepted, current bank transactions dated in the window. **Own-account transfers (`cash_transfer`) are excluded,** as the monthly engine excludes them (ADR-028). | `bank` |
| Sales invoiced / bills received | Invoices issued in the window, net of credit notes | `invoice` |
| Invoices paid by customers / bills paid | Invoices **fully paid** on a date in the window. A part payment carries no date and is not counted, and the note says so. | `invoice` |
| Fell due unpaid (each side) | Invoices due in the window that still had a balance at composition, by that balance | `invoice` |

- **Live rows** follow the engine's rule: `record_status = 'accepted' and superseded_by is null`. Void invoices are left out.
- **Currency:** only the organisation's base currency is counted (CD-10), and the number of excluded records is stated.
- **Silence is not zero.** With no bank account, or no account whose data reaches into the window, the cash figures are *absent*, and the brief says why. If an account's data stops before the window ends, the figures are computed from what is there, marked **Incomplete**, and the account is named.
- **Coverage** of an account is the later of its latest live transaction and the end of its latest committed statement.
- **Evidence:** every figure carries its exact record count and its 25 largest records. Each record links to `/evidence/record/{bank|invoice}/{id}` (SOW §14).
- **Money** is shown to the penny for interim figures. Monthly cards keep the product's whole-pound display.
- **Labelling:** every brief and weekly report carries the interim disclaimer: these figures count what has been imported so far and will change.
- **Pure and deterministic:** the same rows in any order give the same output (unit test).

## 6. Accountant/CFO Report (REQ-RP-04)

One client, for the latest complete month with figures. It contains:
- the Command Centre's attention reasons (`portfolio/domain/attention.ts`, the same rules, so the report and the portfolio cannot disagree);
- the month as Home shows it;
- health area by area (score, or the exclusion reason in the Health panel's words), with a year of scores and the health disclaimer;
- open alerts by severity (critical/high/medium listed);
- actions: open, overdue, urgent, and completed in the last 30 days with their recorded outcomes;
- data quality: when data was last added, how far each bank account's statements reach, and which of the last twelve months have no figures.

It is composed by the queue on request (`reports.generate`) and stored. A portfolio-wide pack across clients is not part of this phase.

## 7. Custom AI Report (R17-4, REQ-RP-06)

1. The person chooses a complete month, optional areas, and up to **5** questions: the agreement's §12 list, or their own, each at most 500 characters.
2. The browser sends each question **in turn** to `POST /api/ai/chat` — the analyst's own route, so the same grounding, refusals, evidence and **quota** apply — in one conversation. The month and areas are written into the question in words ("For August 2026, looking at cash: …").
3. `finishCustomReport` reads that conversation **back from storage**. It must be the caller's (`findConversation`). The server takes each named answer, and the question before it, from the stored messages; the browser supplies only message ids. Ids outside the conversation, repeats and user turns are refused.
4. If a turn is refused (quota, permission), the run stops. The person can save what was answered.
5. An unanswered or degraded answer stays in the report as such. The report never looks more certain than its answers were.

The report is **private to its author**: `reports_select` hides another person's `custom_ai` row, as `ai_conversations` is per user. It is rendered on screen by the analyst's own `AnswerView`.

## 8. Storage, jobs and scheduling

- **`public.reports`** (migration `20261010000003`): append-only (`app.append_only_guard_cascadable`), RLS forced, readable with `reports.view` (custom: author only). Recomposing writes a new row; the list shows the latest per (kind, window) and how many versions exist. Stored content is versioned (`brief.v1`, `adviser.v1`, `custom.v1`), and a renderer refuses a version it does not know.
- **Why stored:** a brief lists what was open *that day*. Recomposing it a week later would tell a different story.
- **No names in stored content.** A stored brief is readable by clients, who may not learn colleagues' names (`users.view`), so actions carry `assigned: true/false` only. Import details (an `imports.review` matter) are not stored; only "data last added", which Home already shows everyone, is.
- **Links** are stored with an `{org}` placeholder and resolved when shown, because a job has no slug and a slug can change.
- **`api_server.record_report`:** service role only, scoped (ADR-090), checks the actor's permission (`reports.generate`; custom: `reports.view` + `ai.use`), and is audited `report.composed`.
- **PDFs:** `report_files.report_id` (new; `period_id` now nullable, and `report_files_subject` requires one or the other). `api_server.record_report_pdf` derives `{org}/r/{report}/{file}.pdf`. The existing download route, audit-first signing and orphan sweep apply unchanged (the sweep's depth of 3 reaches the new path). The PDF renders the **stored** content (`pdf-composed.ts`, `pdf-custom.ts`; `pdf-kit.ts` wraps long lines).
- **`report.compose` job:** composes and stores. "Scheduled" comes from the job row (`requested_by is null`), never from the payload.
- **`api.enqueue_job`:** `report.compose` with `reports.generate`, for a finished day, a finished Monday-to-Sunday week, or the adviser report. `report.render` also accepts a `reportId`, resolved under the reports policy.
- **Schedule:** `api_server.enqueue_scheduled_reports(p_now)` runs from the existing hourly `/api/jobs/scheduled` tick. For each active organisation with at least one succeeded calculation, the first tick after local midnight queues yesterday's brief, and on a local Monday it also queues last week's report. This happens once per organisation, kind and window, whether a job of any state or a stored report already exists. A failure to queue reports never stops the recalculation, nor the reverse.
- **Purge:** `reports` is in the deletion order (after `report_files`). While adding it, the order was found to be **missing eleven earlier tables**, so any organisation that had used forecasts, scenarios, the commercial records or completeness attestations could not be purged. This is fixed separately in migration `20261010000001`, with the purge test now seeding a row in each.
- **Monthly list fix:** an adviser or custom report's PDF also names a month. `listReportFiles` now lists monthly-management PDFs only, so the monthly list can never offer one.

## 9. RBAC and tenant isolation

| Who | Read daily/weekly/adviser | Read custom | Request compose / PDF | Custom report |
|---|---|---|---|---|
| owner, admin, employee (assigned), super admin | ✓ | own only | ✓ | ✓ (`ai.use`) |
| client | ✓ | own only | ✗ | ✓ (`ai.use`) |

- Another organisation's report id is NOT FOUND, never FORBIDDEN, both on read and on a PDF request.
- No authenticated role can insert into `reports`.
- `api_server.*` is not executable with a user JWT.

## 10. Tests and gates (local)

| Suite | File | Count |
|---|---|---|
| Unit | `interim-figures.test.ts` (figures worked by hand) | 14 |
| Unit | `local-day.test.ts` (DST, half-hour and +14 offsets) | 11 |
| Unit | `phase17-brief.test.ts` (assembly, custom pairing, three PDFs) | 11 |
| Unit | `report-labels.test.ts` (labels identical to the Health panel and the analyst) | 4 |
| Unit | `nightly-route.test.ts` (hourly tick queues both; either failure is reported, the other still runs) | updated |
| pgTAP | `23_phase17_reports.test.sql` | 14 |
| Integration | `phase17-reports.test.ts` (figures, timezone, equality with Home card for card, versions, RBAC, append-only, PDF in Storage, custom privacy and pairing, schedule) | 26 |
| Integration | `org-purge.test.ts` (one row in every tenant table, including `reports`) | 11 |
| E2E | `journey-18-reports.spec.ts` (brief produced, drilled to the transaction, PDF; custom report built and saved) | 2 |

The full gate results are recorded in the handover note, not here.

## 11. Known limitations and open items

- **Funding Readiness Report:** built locally behind `features.funding_readiness` (§1); not scheduled; unreviewed, as Phase 16 is.
- **Monthly report commercial section:** EXCLUDED (§1).
- **R17-2** interpretations await the owner's written confirmation.
- **R17-1(b)** is computed beside the engine, not in it (§2). The owner may ask for it in the engine.
- **Part payments** have no date and so are not in "paid in the window".
- **Email delivery** is not built (R17-3). It needs a provider, which is outside Phase 1.
- **The Accountant/CFO Report** is per client; a cross-client portfolio pack is not built.
- **Custom AI Report in e2e:** no model is reachable in the local journey, so the journey proves the flow (turns recorded, report saved with unanswered entries) but not a grounded answer. Grounding itself is the analyst's existing, separately tested behaviour.
- **The base branch** (`fix/step0-outstanding-findings`) is still awaiting independent re-review, and its open findings remain open.
