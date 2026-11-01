# Department dashboard — copy of the client's prototype (owner, 2026-11-01)

Source of truth: the client's ChatGPT prototype, saved locally at `~/Downloads/apx-prototype/`
(`index.html`, `styles.css`, `app.js`, `model.js`, `operations.js`, `operations-model.js`, `growth.js`,
`clients.js`, `rendered-dom.html`). Copy every card, button, toggle, dialog and wording; replace the
sample data with the company's real data. Owner decisions (2026-11-01):

- All five departments built together (Financial Analysis, Banking, Data Capture, Manage Workflow,
  Client Management).
- Demo-only controls become real: the person's real role decides the view (no fake Client/Analyst
  switch — the identity shows the real role); "Give feedback" sends the note to APX staff inside APX;
  "Reset demo" is dropped; Help stays as a guide.
- Monthly targets: a new per-company record (`monthly_targets`, one document per `YYYY-MM`).
- Sector briefing (web research): left out for now — its buttons are hidden.
- Animate cards and charts (lines draw in, bars/donuts grow, cards rise); still under reduced motion.

## Route and state

`/app/<slug>/home` is the department dashboard. URL state (server-rendered):
`?dept=analysis|banking|capture|workflow|clients` · `?months=1|3|6` (default 6) ·
`?view=current|last` (Current = latest month with figures; Last Completed = latest complete month).
Client-only state: legend series visibility, Compare baseline, queue filter, growth rate / basis /
cost mode / investment, client search + status filter, dialogs.

## Prototype → APX mapping

| Prototype | APX (real) |
|---|---|
| Masthead: Give feedback, Private prototype label, help, Client/Analyst select, LAST LOGIN DEMO | Give feedback (→ APX staff), help guide, identity = real name + role, last login = previous `auth.sign_in` audit time |
| Department tiles 01–05 + More Apps | `?dept=` switch; More Apps window (existing) |
| Period 1/3/6 months, Current/Last Completed, period caption, Scenario select | real month windows; Scenario select lists "Actual figures" (saved What-if scenarios open their page) |
| Feedback / Export buttons | feedback dialog pre-set to the section; Export = CSV of the chart rows |
| Metrics ×3 per department, 3-month spark with labels | engine snapshots (see departments) |
| Key Report Indicators (analysis only) | financial-year totals (Marketing Section 03 domain), like-for-like when the year is partial |
| Main chart: legend toggles, Compare baseline, data table, tooltip, insight + figure | real monthly series; baseline = same months last year |
| Marketing vs Revenue + data table | window revenue vs marketing spend (accounts/campaigns) |
| Revenue mix donut | analysis: top customers / other sales / other income; banking: cash by account; capture: by import type; workflow: open actions by source; clients: customers by status |
| How can I Grow (analysis, banking) | baselines: latest whole financial year · window annualised; cost behaviour; investment; assumptions dialog — all Decimal, server-side rows per option |
| Client portfolio (clients only): search, status, profile dialog, record review | company customers (counterparties) — attention = overdue invoices; profile = real figures; record review = engagement item |
| Comparative Financials + historical table | last three financial years: sales vs total costs (sales − net profit) |
| Priorities & observations: filter, item dialog, Request analyst review / Mark as reviewed | real items per department (actions, alerts, import batches); request = engagement item; reviewed = action/alert status (permission-checked) |
| Compliance View + Review checks + Integration plan (Xero) | real checks: Xero not connected; data completion (uploads awaiting review); workflow review (open actions); statutory filings (VAT/CT dates, not verified) |
| Make the next move: workflow infographic (nodes switch dept), APAX dialog (prompts + ask), Monthly targets dialog (save, KPI checks), Templates dialog (report / pitch deck) | real counts; APAX question → APX AI analyst; targets stored per company; templates with real figures |
| Footer | APX Finance in motion · basis line |

## Build order
1. Port `styles.css` scoped under `.apx-dash` + animation keyframes.
2. View models + services per department (dashboard module), targets + feedback storage.
3. Components (structure and class names as the prototype), client components for interactions.
4. Page composition; shell identity additions.
5. Verify: tsc, lint, unit tests (`npm run test:unit` only), Playwright click-through of every control, screenshots vs prototype.
