# MOTION — UX Architecture

Depends on: `MVP_SCOPE.md`, `RBAC_MATRIX.md`, `ROUTE_ARCHITECTURE.md`, `ARCHITECTURAL_DECISIONS.md` (ADR-019, CD-15, CD-16, CD-17)
Consumed by: `IMPLEMENTATION_PLAN.md`, `TEST_STRATEGY.md §11–12`

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-030, ADR-032, ADR-033, ADR-035, ADR-036, ADR-037, CD-32. Findings addressed: F-B-08, F-B-09, F-B-15, F-C-05, F-C-06, F-C-08, F-C-14, F-C-16, F-D-03, F-D-04, F-D-07, F-D-08, F-D-09, F-D-10, F-D-11, F-D-15, F-D-18. See `RED_TEAM_REVIEW.md`.

> **Revision 1.2 (red-team round 2, 2026-09-05).** Applies ADR-045.8, ADR-047.7 (the "Updating your numbers…" banner shows chunk progress: "{done} of {total} months", driven by `calculation_runs.progress`). Findings addressed: R2-C-04. A degraded analyst answer never shows removed sentences; the \"Not covered\" list renders server-generated topics only (\"Not covered: marketing spend for March — figure could not be verified\"). See `RED_TEAM_REVIEW.md §6`.

Audience for the product: the owner or manager of a small business who is not technical, does not read accounts for pleasure, and opens MOTION to find out whether things are fine and what to do if they are not. Every rule in this document exists to protect that person from being overwhelmed.

This is a UX *architecture*: structure, states, behaviour and language. Visual design (direction, type, palette) is decided in the fable-5 DESIGN phase before build (§12).

---

## 1. UX principles

Each principle is a rule the implementation can be checked against, plus the anti-pattern it forbids.

| Principle | Rule | Anti-pattern it forbids |
|---|---|---|
| **Clarity** | Every screen answers one of the five customer questions (§2) and says which one in its heading. One primary action per screen. | A dashboard that is a grid of twelve equal KPI tiles with no reading order. |
| **Confidence** | Every number carries its basis (where it came from) and its assurance level, and can be opened with one click into evidence. If a number cannot be trusted it is shown as "unknown" with a reason, never as zero. | Showing `£0` cash because opening balance is missing. |
| **Progressive disclosure** | Home shows level 1–2 by default; levels 3–4 are below the fold or behind "Show more"; records and documents live only in the Evidence Drawer. Nothing deeper than level 2 is visible without a deliberate click. | Transaction tables on the home page. |
| **Decision-making** | Every alert and every AI finding ends in a concrete next step that can be turned into an action with one click. Insights are ranked by money at stake, not by date. | Alerts sorted newest-first regardless of size. |
| **Simple language** | Headline UI uses plain words (§8); technical terms appear in tooltips and in Money sub-pages only. Reading level: a 14-year-old can follow it. | "Net cash movement deteriorated 12.4% PoP." |
| **Few primary actions** | The global header has exactly two controls besides navigation: the *Data* menu (whose primary item is *Add data*) and *Ask the analyst*. Each page has at most one primary button. | Toolbars with six icon buttons. |
| **Strong empty states** | Every page has a first-run state that explains what will appear here, what the user must do to fill it, and one button that does it (§6). | A blank table with "No rows". |
| **Clear explanations** | Every alert, health dimension and AI finding follows *What happened / Why it matters / What you can do* (§8.3). Every threshold that fired is shown in the explanation. | "Anomaly detected in expenses." |

---

## 2. The five customer questions → screens

| Question | Primary screen | Supporting screens | What the user sees first |
|---|---|---|---|
| How is my business doing? | **Home** | Money | Health score, one plain sentence, the headline numbers (CD-32) for the latest complete month |
| What changed? | **Insights** | Home trends | Ranked list of movements this period vs last, biggest first, each with "Why?" |
| Why did it change? | **Insights** drill-down and **AI Analyst** | Evidence Drawer | Drivers (accounts, customers, transactions) behind each movement; AI "Causes" section |
| What requires attention? | **Home → Top risks** and **Actions** | Insights (alerts filter) | Three highest-severity open alerts, outstanding actions |
| What should I do next? | **AI Analyst → Recommended actions** and **Actions** | Alerts' next step | Recommendations each with a "Create action" button |

Insights is the SOW's "Analysis" layer in the drill-down chain Dashboard → Analysis → Account/Customer/Category → Transaction → Source Document (SOW §8). The chain is implemented as: Home widget → Insights row → Evidence Drawer level 3 (records) → level 4 (document).

---

## 3. Navigation

### 3.1 Primary navigation (seven items + Settings)

Desktop: left sidebar. Mobile: bottom tab bar (§10). The order is fixed and matches ADR-019.

| Item | Route | Purpose | "What you'll find here" (shown as tooltip and in empty state) | Visible to |
|---|---|---|---|---|
| Home | `/app/[orgSlug]/home` | Answer "how are we doing" in ten seconds | Your health score, headline numbers, top risks and what needs doing | All roles (`dashboard.view`) |
| Insights | `/app/[orgSlug]/insights` | What changed, why, and open alerts | Biggest changes this period, alerts, and the reasons behind them | All roles (`financials.view`) |
| Money | `/app/[orgSlug]/money` | The numbers in detail | Profit and loss, cash, bank activity, who owes you and who you owe | All roles (`financials.view`, `banking.view`) |
| Customers | `/app/[orgSlug]/customers` | Who the business depends on | Revenue by customer, concentration, overdue balances | All roles (`customers.view`) |
| Actions | `/app/[orgSlug]/actions` | Turn insight into work | Tasks assigned to people, with due dates and outcomes | All roles (`actions.view`) |
| Reports | `/app/[orgSlug]/reports` | Something to print or send | The Monthly Management Report | All roles (`reports.view`) |
| AI Analyst | `/app/[orgSlug]/analyst` | Ask questions in plain English | Answers with evidence, drawn only from your validated numbers | All roles (`ai.use`) |
| Settings (gear, bottom of sidebar) | `/app/[orgSlug]/settings` | Administration, kept out of the way | Organisation details (incl. fiscal year and currency), team, audit log | Owner, Admin, Super Admin (`settings.manage`). Employee and Client do not see the gear (ADR-037) |

Navigation items are hidden entirely when the role lacks the section permission (RBAC §5). They are never shown disabled.

Global header (all tenant pages): organisation switcher (left), period picker (centre, on pages that are period-scoped), the **Data** menu and the **Ask the analyst** shortcut (right), user menu (avatar).

**Data menu (ADR-037).** A single header button labelled *Data* whose primary item is **Add data** (`/data/imports/new`), followed by *Imports* (`/data/imports` — history, replace, roll back, export, recalculate), *Documents* (`/data/documents`) and *Accounts* (`/data/accounts` — category mapping). Shown to roles with `imports.review` (Owner, Admin, Employee, Super Admin); Client never sees it. This keeps the primary navigation at seven items while giving the adviser and the admin a one-click path to the pages they work in. There is no "Settings → Data": fiscal year and currency live on `/settings`; export and recalculate live on `/data/imports`.

### 3.2 Secondary navigation

| Parent | Sub-navigation | Routes |
|---|---|---|
| Money | Tabs: Profit & loss · Cash · Bank activity · Owed to you · You owe | `/money/profit-and-loss`, `/money/cash`, `/money/banking`, `/money/receivables`, `/money/payables` (`/money` redirects to Profit & loss) |
| Money (continued) | Two forward-looking pages reached from the Money index, not from the sidebar — §3.1's seven items are fixed and ADR-037 created the Data menu specifically to keep them there (ADR-099, ADR-100) | `/forecast` (what the finished months suggest the next three will look like), `/what-if` and `/what-if/[scenarioId]` (the same three months with stated changes applied) |
| Settings | Sub-pages: Organisation (name, fiscal year, currency, timezone) · Team · Audit log · Billing (feature flag) · Danger zone | `/settings`, `/settings/team`, `/settings/audit`, `/settings/billing`, `/settings/danger` |
| Data (header menu, not a sidebar item) | Add data · Imports · Documents · Accounts | `/data/imports/new`, `/data/imports`, `/data/imports/[batchId]`, `/data/documents`, `/data/documents/[documentId]`, `/data/accounts` |
| Reports | List → Monthly report for a period | `/reports`, `/reports/monthly/[period]` |
| AI Analyst | Conversation list (left rail on desktop) → conversation | `/analyst`, `/analyst/[conversationId]` |
| Evidence | Standalone deep-link page for a bundle (used by report links and share) | `/evidence/[bundleId]` |

Data pages are deliberately not in the sidebar: for the owner, importing is an occasional task; for the adviser and admin it is daily work, which is why the Data menu is always one click away in the header for those roles (ADR-037).

---

## 4. Home hierarchy

Home is read top to bottom. Each level is a horizontal band. The user should be able to stop reading after any band and have a complete picture at that depth.

**Default period (ADR-030).** Home, Insights and Reports open on the **latest complete month** (`fiscal_periods.is_complete`), the same rule the AI Analyst uses (`core/periods`), so the two never disagree. When the current month has partial data, Home shows one slim line under the period heading: "April so far: money in £6,000 · money out £4,100" with a link to the Cash page; no health score, comparisons or alerts are computed for a partial month.

**Bank-only variant (ADR-035).** When an organisation has bank data but no ledger, trial balance or invoices, Level 2 becomes three cards — **Money in**, **Money out**, **Change in cash** — plus a **Cash balance** card that reads "Enter your opening balance to see your cash balance" with an inline form when the balance is unknown. Revenue and profit cards appear only when a P&L source exists; until then the summary sentence says what the bank data shows and names the one upload that would unlock profit figures.

### Level 1 — Are we OK?
- **HealthScoreCard**: score 0–100, band label (0–39 At risk · 40–59 Needs attention · 60–79 Stable · 80–100 Strong), change vs last month, "based on N of 6 areas" when dimensions are missing.
- **One plain sentence** generated deterministically from templates (not by the AI) from current metric snapshots, e.g. "March was profitable, cash went up by £4,200, and two things need your attention." Templates live in `modules/health/domain/summary-templates.ts`.
- **Basis and freshness line**: "Based on your bank statements and sales invoices · Last data added 12 Mar 2026 · March 2026 (latest complete month)". Clicking "Based on…" opens the Data quality card (level 4).

### Level 2 — The headline numbers (CD-32)
**MetricCard**s in this order: **Sales** (revenue) · **Profit after direct costs** (gross profit; shown only when the organisation has cost-of-sales accounts, CD-05) · **Profit before interest and tax** (operating profit) with a visible second line "after interest and tax: £x" (net profit; never tooltip-only) · **Cash** (closing cash) · **Owed to you** (receivables) · **You owe** (payables). Six cards on desktop (five without gross profit), two per row on mobile. Each shows value, change vs previous complete month (amount and %), one **status badge** (§8.1) and a "Why?" link. When the change carries `basis_differs` (ADR-030) the card shows "compared on a different basis" in place of the percentage and the amount is greyed.

### Level 3 — What is moving and what needs doing
- **TrendChart**: 12 months of revenue, profit and closing cash (three series, toggleable).
- **Top risks**: up to three open alerts, highest severity first (AlertCard, compact).
- **Top opportunities**: up to three positive movements (largest favourable variances by money), each with "Why?".
- **Outstanding actions**: up to three open actions by due date (ActionCard, compact) with "See all".

### Level 4 — Supporting detail (collapsed by default on mobile)
- Owed to you / You owe (totals, overdue amounts, aging buckets as a small bar).
- Biggest expense movements (top five accounts by absolute change vs previous period).
- **Data quality card**: periods covered by which sources, unmapped accounts count, uncategorised bank transactions count, missing opening balances, rows awaiting review, last import. Each line links to the page that fixes it ("Improve your data" is never a generic link): unmapped accounts → `/data/accounts`; uncategorised transactions → `/money/banking?filter=uncategorised`; missing opening balance → the opening-balance form on `/money/cash`; rows awaiting review → the batch page.

### Rules that apply to every number on every page
- Formatting comes only from `core/money` (`formatMoney`, `formatPercent`, `formatChange`); components never format numbers themselves.
- Colour semantics: red/amber/green are reserved for status meaning (alert severity, health band, favourable/unfavourable change). No decorative use of those hues anywhere. Neutral ink for all other numbers.
- Favourable/unfavourable direction is metric-aware (`core/money/direction.ts`): a fall in expenses is favourable and green; a fall in revenue is unfavourable and red.
- Every number has a **"Why?"** affordance (small link or the whole card is clickable) that opens the **EvidenceDrawer** at the metric level for that period.
- Every number carries exactly one status badge (§8.1): the worst of its assurance level and data-quality state. Basis and warnings appear in the badge tooltip and at drawer level 1, never as additional badges on the card.
- Numbers that are not computable show "—" with a tooltip reason from `data_quality.missing`, never `0` and never blank.
- Every period-scoped page states the period in its heading ("March 2026") and shows the comparison period in the change tooltip.

---

## 5. Important components

Contract sketches only. Props are the data the component needs; components never call services or compute numbers (`SERVICE_ARCHITECTURE.md`).

```ts
HealthScoreCard { score: number | null; band: 'at_risk'|'needs_attention'|'stable'|'strong'|null;
  changeVsPrevious: number | null; dimensionsUsed: number; dimensionsTotal: number;
  period: PeriodLabel; onExplain(): void }

MetricCard { label: string; plainLabel: string; value: Money | null; secondaryLine?: { label: string; value: Money | null } /* e.g. net profit under operating profit */;
  change?: { amount: Money; ratio: number | null; favourable: boolean | null; basisDiffers: boolean };
  status: StatusBadge /* one badge, derived per §8.1 from assurance + data quality */; basis: MetricBasis; dataQuality: DataQuality; period: PeriodLabel;
  whyHref: string /* opens EvidenceDrawer for (metricKey, periodId) */ }

TrendChart { series: Array<{ key: string; label: string; points: Array<{ period: PeriodLabel; value: number | null }> }>;
  unit: 'money'|'ratio'; highlightPeriod?: PeriodLabel; tableFallbackId: string /* renders an sr-only + toggleable data table */ }

AlertCard { alert: { id; severity; title; explanation; period; recommendedNextStep; status; evidenceBundleId; actionId? };
  compact?: boolean; canManage: boolean; onAcknowledge; onResolve; onDismiss; onCreateAction }

ActionCard { action: { id; title; priority; ownerName?; dueDate?; status; sourceType }; compact?: boolean; canEdit: boolean; onStatusChange }

EvidenceDrawer { bundleId: string; entry: 'statement'|'metric'|'calculation'|'records'|'document';
  /* Levels shown as a breadcrumb: Statement → Metric → Calculation → Records → Document.
     Client role: the Document level renders a locked state (CD-17); others render the viewer with page reference. */ }

ImportWizard { batchId?: string; importType?: ImportType;
  steps: StepId[] /* derived per importType, ADR-037: bank_statement → ['upload','account','review','confirm'] (account step captures bank account + statement opening balance, "I don't know" allowed, and sign convention only when the saved mapping lacks it);
     general_ledger / trial_balance / pnl_report / balance_sheet → ['upload','choose-type','map-columns','map-accounts','review','confirm'] (trial balance adds the cumulative/movement confirmation, ADR-027);
     sales_invoices / purchase_invoices → ['upload','choose-type','map-columns','review','confirm'];
     steps whose answers come from a saved mapping are skipped and shown as "Using your saved mapping from 12 May · change" */
  fastPath: boolean /* zero issues and no PDF pages to confirm → review renders as one line "312 rows, nothing to check" with Commit as the primary button */
  /* Each step is a route segment so refresh/back works: /data/imports/new?step=… */ }

ReviewTable { rows: ImportRowView[]; filters: 'all'|'errors'|'warnings'|'duplicates'|'needs-review';
  issueGroups: Array<{ category: 'Dates'|'Amounts'|'Duplicates'|'Missing'|'Accounts'|'Document'; count: number; codes: string[] /* codes in tooltip only */ }>;
  onDecision(rowId, 'keep'|'skip'|'fixed', reason?); bulk: ['keep-all-exact-with-reason','keep-all-fuzzy','skip-all-errors'];
  showSourcePreview: boolean /* PDF page image side-by-side, CD-11 */; balances: { opening: Money | null; closing: Money | null; source: 'statement'|'typed'|'ai-read'|'none' } }

AnalystChat { conversationId?: string; messages: AnalystMessageView[]; quota: { remainingToday: number };
  /* Structured answer renderer: sections Direct answer · Key findings · Causes · Risks · Opportunities · Recommended actions · Confidence · Not covered · Evidence.
     The Direct answer is a Statement like any other (ADR-032): it carries a kind badge and a "Why?" link.
     Each statement carries exactly one kind badge from the canonical table in §8.1.
     Sections are revealed progressively from the single validated answer event; nothing is rendered before validation (ADR-032.4).
     "Create action" appears on a recommendation only when message.groundingStatus === 'passed'; otherwise the button is absent and the Confidence line explains why.
     Each message has "Report this answer". */ }

PeriodPicker { value: PeriodId; available: PeriodOption[] /* only months with accepted data; the latest complete month is marked */; onChange }
/* Monthly only in MVP (ADR-030.6); quarter/year granularity is post-MVP and requires materialised aggregate snapshots. */
OrgSwitcher { organisations: Array<{ slug; name; role: EffectiveRole; badge?: 'adviser' }>; current: slug }
PermissionGate { permission: Permission; fallback?: 'hide'|'denied-state'; children }
EmptyState { icon; title; body; primaryAction?: { label; href }; secondary?: { label; href } }
DataQualityBadge { completeness: number; warnings: string[]; assurance: AssuranceLevel; size: 'sm'|'md' }
```

Component rules:
- All the components above ship with Storybook-style fixture pages under `/dev/components` (non-production route) so states in §6–7 can be verified visually before data exists.
- `MetricCard`, `AlertCard`, `ActionCard`, `HealthScoreCard` have compact and full variants; no other variants.
- `TrendChart` always renders an accessible table (toggle "Show as table") with the same data (§11).

---

## 6. Empty states (exact copy)

Copy is UK English, second person, no exclamation marks. Each has one primary action.

**Home, first run (no committed data)**
> **Let's get your first numbers on screen.**
> MOTION works from files you already have. Upload a bank statement (CSV or PDF) or an export from your accounting software and we'll show you how the business is doing, what's changed and what needs attention.
> *Start with a bank statement to see your cash position. Add a ledger export, trial balance or invoice list when you can, and we'll add profit and customer figures.*
> [Add data]   Secondary link: *What files can I upload?*

**Home, bank data only (first run after a statement)**
> **Here's what your bank statement tells us.**
> Money in, money out and the change in cash for March. To see your cash balance, enter the balance at the start of the statement. To see profit and customers, add a ledger export or your invoice lists.
> [Enter opening balance]   Secondary: [Add data]

**Home, data uploaded but not yet committed**
> **Your import is waiting for review.**
> We found 312 rows in `march-statement.csv`. Check the 4 items we flagged, then confirm, and your numbers will appear here.
> [Review import]

**Insights, fewer than two periods of data**
> **We need two months to show what changed.**
> Insights compares this month with last month. Add another month of data and this page will show you the biggest movements and why they happened.
> [Add data]

**Insights, no adjacent month (gap in data)**
> **Comparing March with January.**
> We don't have February yet, so changes are shown against the nearest earlier month we do have. Add February to compare month to month.
> [Add data]

**Money → Owed to you / You owe, no invoices**
> **No invoices yet.**
> Upload a sales invoice list or purchase invoice list to see who owes you, who you owe, and what's overdue. If you only use bank statements, this page will stay empty — that's fine.
> [Add data]

**Customers, no invoices or customer-tagged entries**
> **We don't know your customers yet.**
> Customer insights come from invoices. Upload your sales invoice list and we'll show you who your biggest customers are and how much you rely on them.
> [Add data]

**Actions, none**
> **Nothing to do right now.**
> Actions appear here when you turn an alert or an analyst recommendation into a task, or create one yourself.
> [Create an action]   (hidden for Client role)

**AI Analyst, no committed data**
> **The analyst needs some numbers first.**
> Once you've added at least one month of data, you can ask questions like "Why did profit fall?" or "Which expenses went up the most?" and get answers backed by your own records.
> [Add data]

**AI Analyst, data present, no conversations**
> **Ask anything about the numbers.**
> Suggested: *How did we do in March?* · *Which expenses went up the most?* · *Who are our biggest customers?* · *What should I focus on this month?*
> (Suggestions are buttons that send the question.)

**Reports, before the first full month**
> **Your first monthly report will be ready once a full month of data is in.**
> Reports are generated from the same numbers you see on Home, so nothing here will surprise you.
> [Add data]

**Insights → Alerts filter, no open alerts**
> **No open alerts.**
> That means nothing crossed the thresholds we watch this month. You can see resolved and dismissed alerts under *History*.

**Portfolio (employee), no assignments**
> **You haven't been assigned to any organisations yet.**
> A MOTION administrator assigns organisations to you. When that happens they'll appear here.

**Platform → Organizations, none**
> **No organisations yet.** [Create the first organisation]

---

## 7. Loading, error, success and denied states

### 7.1 Loading
| Context | Behaviour |
|---|---|
| Any card/table | Skeleton with the same dimensions as the loaded state (no layout shift). Skeletons never exceed 3 s before a "Taking longer than usual" line appears. |
| Home | Level 1–2 skeletons stream first (server components), levels 3–4 stream after. |
| AI Analyst | While tools run, a status line shows plain text ("Checking March cash…") derived from tool names, never raw JSON. The answer itself arrives as one validated event and is then revealed section by section in contract order; no narrative is shown before validation (ADR-032.4). |
| Import | Progress bar with stage names (Uploading → Checking file → Reading rows → Finding issues) and row counts; large imports (queued, CD-22) show "We'll email you when it's ready" plus the batch page keeps polling. PDF extraction waiting on the provider shows "Waiting for the extraction service — we'll keep trying for up to an hour" with pages done / pages left (ADR-033). |
| Recalculation after commit | Banner on every page: "Updating your numbers…" while a `calculation.run` job for the organisation is queued or running (the banner keys off the job, never off `calculation_runs.status`, ADR-031); stale figures are shown greyed with a "being updated" tag rather than hidden. |

### 7.2 Errors
| Situation | State |
|---|---|
| File rejected at upload (type/size/virus) | Inline under the dropzone: what was wrong and what to try ("This looks like a scanned PDF. We can keep it as a document, but to see the numbers please export a CSV from your bank."). |
| Import parse/validation failed entirely | Batch page shows the error summary in plain words, a **Try again** button (re-runs from the last good stage), a link to the mapping step, and "Contact support" (opens mail with batch id prefilled). Nothing is discarded. |
| Commit interrupted (worker lost) | Batch returns to review with "We couldn't finish saving this import. Nothing was saved; please confirm again." and a **Confirm** button (ADR-031.3). |
| Duplicate found at confirm time | "Another import added N of these rows while you were reviewing"; the rows are re-flagged and review reopens (ADR-029.5). |
| Calculation run failed | Banner: "We couldn't update your numbers. Your data is safe; we're looking into it." Owners/Admins get a **Retry** (`intelligence.recompute`); the previous current snapshots remain visible. |
| AI unavailable / timed out | The chat shows "The analyst isn't available right now" and renders a **Facts we can show you** card from current snapshots for the asked period (deterministic, no model), so the user is never left with nothing. |
| AI grounding failed twice | Canonical behaviour is `AI_ARCHITECTURE.md §7.5` (ADR-032.5): statements that could not be verified are **removed**, listed under **Not covered** in plain words ("We couldn't verify a figure about payroll"), and the banner reads "Some of this answer couldn't be verified against your data, so we've left it out." No "(unverified)" inline markers; no Create action buttons. |
| Network offline | Toast "You're offline" and read-only view of cached page; actions disabled with reason. |
| Session expired | Modal "You've been signed out for security. Sign in again to continue." preserving the current URL. |
| Unknown error | "Something went wrong on our side. Please try again." with a request id for support. Never a stack trace. |

### 7.3 Success
| Event | Feedback |
|---|---|
| Import committed | Full-width success card on the batch page: "We've updated your numbers. 308 rows added from March 2026." [Go to Home] · [Import another file]. Toast on Home when arriving. |
| Action created | Toast "Action created and assigned to Priya" with **View** link. |
| Alert resolved/dismissed | Card animates out; undo available for 8 s. |
| Alert re-evaluated after acknowledgement | Card shows "Updated since you acknowledged it" with the previous and current figures (ADR-034 revisions); a severity increase re-opens it with a toast. |
| Invite sent | Toast "Invitation sent to name@company.com". |
| Settings saved | Inline "Saved" next to the field; no modal. |

### 7.4 Permission denied and not found
- A page the role cannot view (deep link): friendly state "You don't have access to this page. Ask an owner or admin of *Acme Ltd* if you need it." [Back to Home]. No detail about what the page contains.
- An organisation the user cannot access, or that does not exist: identical 404 "We couldn't find that page" (never confirm the organisation exists, RBAC §5).
- An action button the role lacks is hidden, not disabled (RBAC §5). `PermissionGate` enforces this in one place.
- Suspended organisation: every page shows a banner "This organisation is suspended. Contact MOTION support." and only Home is reachable.

---

## 8. Language rules

### 8.1 Plain words
UK English throughout ("organisation", "categorise", "cheque"). Internal enum values, table names, metric keys and rule keys are never rendered. Headline UI uses the plain phrase; the technical term is available in a tooltip and is used on Money sub-pages, in Reports and in the AI's Evidence section, where an accountant may be reading.

| Technical term | Headline UI | Notes |
|---|---|---|
| Revenue | Sales | Tooltip: "Revenue" |
| Gross profit / margin | Profit after direct costs / margin after direct costs | Shown only when the organisation has cost-of-sales accounts (CD-05) |
| Operating profit | Profit | Tooltip: "Operating profit — before interest and tax" |
| Net profit | Profit after interest and tax | |
| Cash inflows / outflows | Money in / Money out | |
| Net cash movement | Change in cash | |
| Closing cash | Cash | Tooltip: "Cash in the bank at the end of March" |
| Receivables | Owed to you | |
| Payables | You owe | |
| Working capital | Working capital | No plain equivalent; explained in tooltip |
| Customer concentration | How much you rely on your top customers | |
| Period-over-period variance | Change since last month | |
| Basis: bank / ledger / invoices / period_balances | From bank statements / From your accounts / From invoices / From your reports | Tooltip text, drawer level 1; never a card badge |

**Canonical status and kind labels (ADR-037).** This is the single table every other document cites (`AI_ARCHITECTURE.md §6`, `EVIDENCE_MODEL.md §7`). A number carries exactly one status badge; an analyst statement carries exactly one kind badge.

| Status (worst of assurance + data quality) | Badge label | Tooltip |
|---|---|---|
| `verified`, completeness ≥ 0.9 | *(no badge)* | "From your records" |
| `calculated`, completeness ≥ 0.9 | Calculated | "Worked out from your records" |
| any level, completeness < 0.9 or warnings | Partial data | "Some data is missing or uncategorised — tap for details" |
| `estimated` (incl. cash-basis proxy) | Estimate | "Estimated from bank activity; may include VAT and timing differences" |
| `inferred` (AI-read PDF rows) | Please check | "Read from a document by AI and awaiting confirmation" |
| not computable (`value = NULL`) | — | reason from `data_quality.missing` |

| Statement kind | Badge label |
|---|---|
| `verified_fact` | Fact |
| `deterministic_calculation` | Calculated |
| `estimate` | Estimate |
| `inference` | Analysis |
| `recommendation` | Recommendation |

The review screen groups issues by plain category (Dates · Amounts · Duplicates · Missing · Accounts · Document); issue codes such as `IMP-DATE-003` appear only in tooltips and support exports.

### 8.2 Formatting
- Percentages to one decimal place ("12.4%"). Ratios never shown as decimals.
- Currency with the organisation's symbol and thousands separators ("£12,400"); pence shown only on Money sub-pages, evidence and reports ("£12,400.50").
- Negative money as "−£1,200" (true minus sign), never parentheses in headline UI; parentheses allowed in report tables.
- Dates "12 Mar 2026"; period labels "March 2026"; quarters "Q1 2026 (Jan–Mar)".
- Changes: "+£2,100 (+8.3%) vs February". Absent comparison: "no comparison yet".

### 8.3 Explanation pattern
Every alert, health-dimension note and AI finding is rendered in three labelled parts:
1. **What happened** — one sentence with the numbers and the period. "Marketing spend was £6,300 in March, up £2,900 (85%) on February."
2. **Why it matters** — one sentence linking to profit, cash or risk. "That's a third of March's profit."
3. **What you can do** — one concrete step, with a *Create action* button where a next step exists. "Check whether the extra spend brought in new customers; if not, review the campaign."

Alerts also show the threshold that fired in the tooltip ("We flag expense categories that rise more than 30% and £1,000 month on month").

---

## 9. Role-specific UX expectations

### 9.1 Owner
- **Lands on** Home of their last-active organisation (or `/onboarding` on first sign-in).
- **Sees** everything: all seven sections, Settings (all sub-pages including Team, Audit log, Danger zone), Add data, documents, exports.
- **Primary tasks** Read Home weekly; review alerts; ask the analyst; assign actions; add monthly data; invite their bookkeeper as Admin.
- **Distinctive** Ownership-transfer flow and organisation deletion live under Settings → Danger zone with two-step confirmation. Sees "MOTION advisers" list with a *Remove access* control (CD-16, RBAC).

### 9.2 Admin
- **Lands on** Home.
- **Sees** the same as Owner except Billing and Danger zone; Team page cannot invite or demote owners (ceiling rules render those controls hidden).
- **Primary tasks** Imports and review; account mapping; categorising bank transactions; managing admins/clients; creating actions.
- **Distinctive** Data pages are their home ground, reached from the header Data menu; `/data/imports` shows a work queue (rows awaiting review, unmapped accounts, uncategorised transactions).

### 9.3 Client
- **Lands on** Home.
- **Sees** Home, Insights, Money, Customers, Actions, Reports, AI Analyst. **Does not see** the Data menu, Settings (except their own `/account`), Data pages, import rows, documents (Evidence Drawer stops at Records with a locked Document level: "Source documents are available to owners and admins"), export buttons, audit log.
- **Primary tasks** Read; ask the analyst; update the status and outcome of actions assigned to them; acknowledge alerts.
- **Distinctive** Actions page defaults to the "Assigned to me" filter. No create buttons anywhere except within their own action's status control.

### 9.4 Platform Employee (MOTION adviser)
- **Lands on** `/portfolio`: one card per assigned organisation with name, health score and band, open critical/high alerts count, last data date, and "Open". The list is one aggregate query filtered by the adviser's accessible organisations (ADR-038.13), so forty clients load as fast as four.
- **Inside an organisation** sees Home through AI Analyst, the Data menu (Add data, Imports, Documents, Accounts), documents, exports; **does not see** the Settings gear at all, invite or role controls, or the member list (assignee pickers show names only).
- **Distinctive** Persistent context banner at the top of every tenant page: "You are viewing **Acme Ltd** as a MOTION adviser" with a *Back to portfolio* link. Org switcher lists assigned organisations grouped separately with an "adviser" badge. Their name appears with a "MOTION adviser" badge wherever it is shown to tenant users (assignee lists, audit entries).
- **Primary tasks** Import and review client files; run analysis; raise and assign actions; generate the monthly report.

### 9.5 Super Admin
- **Lands on** `/platform` (organisations overview with counts, failed jobs, open AI feedback). Platform users must have enrolled TOTP; without it every `/platform` and `/portfolio` request redirects to `/account/mfa` (ADR-038.8).
- **Platform shell** is a separate layout (different header colour, "Platform" wordmark) so a super admin always knows which world they are in.
- **Inside a tenant** (via `/platform/organizations/[orgId]` → "Open as admin") sees everything; a persistent red-bordered banner reads "Platform access — this session is being recorded in Acme Ltd's audit log" (CD-13).
- **Primary tasks** Create organisations, invite first owners, grant platform roles, assign employees, review AI feedback, watch jobs, search audit.
- **Distinctive** Destructive controls (suspend, purge, revoke roles) require typed confirmation of the organisation slug.

---

## 10. Mobile behaviour (320–768 px)

- **Bottom tab bar** with five items: Home · Insights · Money · Actions · Analyst, plus **More** (sheet listing Customers, Reports, Settings, the Data menu items (Add data · Imports · Documents · Accounts) for roles that have them, Account, Switch organisation). Roles that lack a tab's permission get the next item promoted; the bar never shows an empty slot.
- **Home** levels 1–2 fit the first viewport at 375×812; levels 3–4 collapse into "Show more" sections.
- **Charts** simplify: TrendChart becomes a single-series sparkline with a series selector; tooltips become tap-to-reveal; the table fallback is one tap away.
- **Tables become cards**: ledger, bank activity, invoices and review tables render as stacked cards with the primary figure prominent; column choosers are removed.
- **Import wizard** is mobile-capable (upload from Files/Photos works), but on the review step a notice reads "Reviewing on a larger screen is easier — we've saved your progress" with the batch continuing on any device.
- **Evidence Drawer** becomes a full-screen bottom sheet with the level breadcrumb pinned at the top; the PDF viewer uses native scrolling with page jump.
- **AI Analyst** is a full-screen chat; suggested questions are horizontally scrollable chips; the structured answer renders as accordions with Direct answer and Recommended actions expanded by default.
- Minimum touch target 44×44 px; no hover-only affordances (the "Why?" link is always visible on mobile).
- No horizontal scrolling of the page at any width; wide content scrolls inside its own container.

---

## 11. Accessibility

- WCAG 2.2 AA. Colour contrast ≥ 4.5:1 for text, ≥ 3:1 for status colours against their backgrounds; status is never conveyed by colour alone (icon + text label always accompany severity and band).
- Full keyboard operability: sidebar and tabs are `nav` landmarks; Evidence Drawer and sheets trap focus and restore it on close; the chat input supports Enter to send and Shift+Enter for newline.
- Visible focus rings on every interactive element (shadcn/ui defaults retained, never removed).
- Every chart has an accessible data table alternative (`TrendChart.tableFallbackId`) and an `aria-label` summarising the trend in words ("Revenue rose from £38,000 in April 2025 to £45,200 in March 2026").
- Live regions announce import progress, recalculation completion and streaming AI sections politely.
- `prefers-reduced-motion` disables chart animations, drawer transitions and the alert-resolve animation.
- Forms: labels always visible, errors inline and associated via `aria-describedby`, no placeholder-as-label.
- Language attribute `en-GB`; number and date formatting via `core/money` and `core/periods` respects it.

---

## 12. Design token direction (input to the DESIGN phase)

This document does not fix the visual design. Per fable-5, direction, typography and palette are decided and written down in the DESIGN phase before any component is built. Constraints the DESIGN phase must respect:

- **Register**: calm, trustworthy, plain-spoken (BRIEF.md). The product must feel like a steady adviser, not a trading terminal.
- **Type**: one humanist sans for UI with tabular figures for all numbers (tabular-nums is mandatory in every numeric cell); an optional display face for the health-score numeral only.
- **Colour**: a neutral base (warm or cool grey scale) with a single brand accent for primary actions and links; red/amber/green reserved for status (§4 rules); charts use a three-colour ordered palette plus neutral for comparison series, all passing 3:1 against the background in light and dark.
- **Density**: generous line height and spacing on Home and Insights; denser tables allowed on Money sub-pages and review screens.
- **Components**: shadcn/ui primitives restyled to the tokens; no hand-rolled dropdowns or dialogs.
- **Dark mode**: supported from the start via CSS variables; status colours re-tuned for dark backgrounds.
- **Motion**: only functional motion (drawer open, streaming reveal, undo countdown); durations ≤ 200 ms.

Output of the DESIGN phase: a `DESIGN.md` naming the direction, font pair, palette tokens and chart palette, produced in Phase 0/1 alongside identity work so that no customer-facing page is built unstyled (ADR-039, `IMPLEMENTATION_PLAN.md`).
