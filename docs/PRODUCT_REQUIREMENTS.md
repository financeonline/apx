# MOTION — Product Requirements Register

Source: `docs/SOW_v2_extracted.md` (MOTION Financial Intelligence System SOW, "Version 2.0") plus the Principal Architect role brief.
Depends on: `ARCHITECTURAL_DECISIONS.md` (CD-xx, ADR-xxx), `MVP_SCOPE.md`
Consumed by: `IMPLEMENTATION_PLAN.md`, `TEST_STRATEGY.md`, acceptance sign-off

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026 to ADR-039 and CD-32 to CD-35; new rows are listed in the "Revision 1.1 changes" section at the end and are numbered after the existing rows in each group (no renumbering). Findings addressed: F-A-01, F-A-04, F-A-08, F-A-11, F-A-12, F-B-01, F-B-02, F-B-03, F-B-04, F-B-05, F-B-08, F-B-15, F-C-01, F-C-03, F-C-13, F-C-16, F-D-02, F-D-07, F-D-12 and the sales/purchase report gap. See `RED_TEAM_REVIEW.md`.

## How to read this register

Every functional statement in the SOW is one row. SOW wording is preserved as closely as the table format allows; paraphrase is only used where the SOW gives a heading rather than a sentence. Rows marked *Derived from role brief* come from the architect's brief (five roles, seven-item navigation, five customer questions, MVP journey) and are binding to the same degree as the SOW. Rows marked *Architectural* are requirements this architecture adds because a SOW requirement cannot be met without them; each cites the ADR or CD that justifies it.

MVP column values:
- **MVP** — inside the line drawn in `MVP_SCOPE.md`.
- **MVP-limited** — inside MVP with a stated reduction.
- **Post-MVP (Pn)** — delivered in SOW §21 Phase n or later.

"Open question" cites the CRITICAL DECISION (CD-xx) in `ARCHITECTURAL_DECISIONS.md` that must be answered before the row can be accepted.

## Requirement counts

| Group | Total | MVP (incl. limited) | Post-MVP | Open questions |
|---|---|---|---|---|
| Identity & Access | 11 | 11 | 0 | 3 |
| Multi-Tenancy | 9 | 9 | 0 | 2 |
| Organization Management | 8 | 7 | 1 | 2 |
| Data Import | 16 | 16 | 0 | 3 |
| Documents | 6 | 6 | 0 | 1 |
| Financial Data | 9 | 8 | 1 | 3 |
| Banking | 11 | 7 | 4 | 3 |
| Calculations | 16 | 13 | 3 | 5 |
| Business Health | 12 | 10 | 2 | 1 |
| Alerts | 13 | 13 | 0 | 1 |
| AI Analyst | 25 | 23 | 2 | 2 |
| Evidence | 12 | 12 | 0 | 0 |
| Actions | 11 | 11 | 0 | 0 |
| Forecasting | 5 | 0 | 5 | 1 |
| Scenarios | 10 | 0 | 10 | 0 |
| Commercial Intelligence | 14 | 0 | 14 | 3 |
| Adviser/CFO functionality | 10 | 2 | 8 | 1 |
| Funding Readiness | 11 | 0 | 11 | 0 |
| Reporting | 7 | 1 | 6 | 0 |
| Platform Administration | 9 | 9 | 0 | 1 |
| Audit/Security | 12 | 12 | 0 | 2 |
| Testing | 12 | 12 | 0 | 1 |
| Production Operations | 12 | 12 | 0 | 3 |
| **Total** | **271** | **194** | **77** | **38** |

---

## 1. Identity & Access

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-IA-01 | Authentication shall use Supabase Auth. | SOW §4 | SOW requirement | MVP | — | — |
| REQ-IA-02 | Users can authenticate and receive role-appropriate access. | SOW §23 | SOW requirement | MVP | REQ-IA-04, REQ-IA-05 | — |
| REQ-IA-03 | Users must only access companies/entities for which they have explicit permission. | SOW §5 | SOW requirement | MVP | REQ-MT-01, ADR-002 | — |
| REQ-IA-04 | There are five user-facing access levels: Owner, Super Admin, Admin, Client, My Employee; Owner and Super Admin are never merged. | Role brief | Derived from role brief | MVP | ADR-002 | — |
| REQ-IA-05 | Authorization is enforced through identity + organization membership/assignment + role + permission + database RLS + server-side checks; frontend role checks alone are never relied on. | Role brief; SOW §5 | Derived from role brief | MVP | ADR-003, RBAC §4 | — |
| REQ-IA-06 | Internal platform employees have explicit organization assignments and cannot see every organization. | Role brief; SOW §18 | Derived from role brief | MVP | `organization_assignments`, TENANCY §5 | CD-02, CD-16 |
| REQ-IA-07 | Roles and permissions shall be enforced server-side as well as in the user interface. | SOW §5 | SOW requirement | MVP | ADR-003 | — |
| REQ-IA-08 | An organization must always retain at least one owner; ownership transfer is a two-step flow; no user may elevate their own role. | Role brief (Owner) | Architectural | MVP | CD-14, RBAC §3 | CD-14 |
| REQ-IA-09 | Client role is read-and-participate: views intelligence, uses AI, updates own actions; cannot import, edit financials, manage users or settings. | Role brief (Client) | Architectural | MVP | RBAC §2.1 | CD-15 |
| REQ-IA-10 | Sign-in supports email + password and magic link; password reset; session refresh. | SOW §4 | Architectural | MVP | SECURITY §4 | — |
| REQ-IA-11 | Platform staff accounts cannot simultaneously be members of customer organizations. | Role brief | Architectural | MVP | RBAC §3.5, DB trigger `platform_user_exclusivity` | — |

## 2. Multi-Tenancy

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-MT-01 | The application shall be designed as a multi-tenant SaaS platform; company/entity isolation is mandatory. | SOW §5 | SOW requirement | MVP | ADR-001 | — |
| REQ-MT-02 | Supabase Row Level Security shall enforce tenant isolation at the database layer. | SOW §5 | SOW requirement | MVP | DB §11, `app.accessible_org_ids()` | — |
| REQ-MT-03 | The application shall prevent cross-company data leakage. | SOW §5 | SOW requirement | MVP | REQ-MT-02, composite FKs (TENANCY §6) | — |
| REQ-MT-04 | A new company can be created and securely isolated. | SOW §23 | SOW requirement | MVP | `organizations`, TENANCY §2 | — |
| REQ-MT-05 | Tenant hierarchy is Platform → Organization; no Entity or Business Unit level in MVP. | SOW §5, §29 | Architectural | MVP | ADR-001 | CD-29 |
| REQ-MT-06 | Every tenant-owned table carries `organization_id`, has RLS enabled and forced, and indexes lead with `organization_id`. | SOW §5 | Architectural | MVP | TENANCY §6 | — |
| REQ-MT-07 | Tenant-to-tenant foreign keys are composite on `(organization_id, id)` so cross-organization references are impossible even under service role. | SOW §5 | Architectural | MVP | TENANCY §6 | — |
| REQ-MT-08 | Organization context is derived server-side from the URL slug; organization ids are never accepted from the client body. | SOW §5 | Architectural | MVP | ADR-014, TENANCY §7 | — |
| REQ-MT-09 | Enterprise plans for larger groups are supported later by grouping organizations, not by adding hierarchy. | SOW §29 | SOW requirement | Post-MVP (P15+) | CD-29 | CD-29 |

## 3. Organization Management

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-OM-01 | Phase 1 delivers a company/workspace model. | SOW §21 | SOW requirement | MVP | `organizations` | — |
| REQ-OM-02 | Organizations can be created self-serve (creator becomes first owner) or by a Super Admin who invites the owner. | SOW §23 | Architectural | MVP | TENANCY §2 | — |
| REQ-OM-03 | Owners and Admins can invite, remove and change roles of members within the role ceiling; Employees cannot. | Role brief | Derived from role brief | MVP | RBAC §2.2 | — |
| REQ-OM-04 | Only a Super Admin can assign an Employee to an organization; the Owner can revoke the assignment. | Role brief; SOW §18 | Derived from role brief | MVP | `organization_assignments` | CD-16 |
| REQ-OM-05 | Organization settings (name, legal name, fiscal-year start month, base currency, alert preferences) are managed by Owner/Admin. | Role brief | Derived from role brief | MVP | `settings.manage` | CD-09, CD-10 |
| REQ-OM-06 | Organization lifecycle is active → suspended → pending_deletion (30-day grace) → deleted with purge of Storage objects. | SOW §5 | Architectural | MVP | CD-23, `jobs.org.purge` | CD-23 |
| REQ-OM-07 | Every organization is seeded with a standard chart of accounts (one account per standard category) at creation. | SOW §7 | Architectural | MVP | ADR-004, CD-04 | — |
| REQ-OM-08 | Administrative controls are separated into Settings; customers never see platform administration. | Role brief | Derived from role brief | MVP | ADR-019 | — |
| REQ-OM-09 | Billing plans (direct SaaS, professional, enterprise) are managed per organization. | SOW §29 | SOW requirement | Post-MVP (P17+) | `organizations.plan`, `billing.manage` | — |

## 4. Data Import

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-DI-01 | The system shall support initial ingestion of CSV files. | SOW §6 | SOW requirement | MVP | `import_batches` | — |
| REQ-DI-02 | The system shall support initial ingestion of XLSX spreadsheets. | SOW §6 | SOW requirement | MVP | — | — |
| REQ-DI-03 | The system shall support initial ingestion of PDF bank statements and financial documents. | SOW §6 | SOW requirement | MVP-limited: text-layer PDFs parsed deterministically, Claude-assisted extraction requires row-level review, scanned PDFs stored only | CD-11, ADR-011 | CD-11 |
| REQ-DI-04 | The system shall support ingestion of invoices and receipts. | SOW §6 | SOW requirement | MVP-limited: invoice lists as CSV/XLSX; receipts stored as documents with optional manual ledger entry; no OCR | `invoices`, `source_documents` | — |
| REQ-DI-05 | The system shall support ingestion of trial balances. | SOW §6 | SOW requirement | MVP | `period_balances` | CD-03 |
| REQ-DI-06 | The system shall support ingestion of general ledgers. | SOW §6 | SOW requirement | MVP | `ledger_entries` | CD-04 |
| REQ-DI-07 | The system shall support ingestion of P&L and balance sheet reports. | SOW §6 | SOW requirement | MVP | `period_balances` | CD-03 |
| REQ-DI-08 | The system shall support ingestion of sales and purchase reports. | SOW §6 | SOW requirement | MVP | `invoices`, `ledger_entries` | — |
| REQ-DI-09 | The import engine performs upload, validation, mapping, duplicate detection and traceability. | SOW §3, §21 | SOW requirement | MVP | IMPORT_ENGINE.md | — |
| REQ-DI-10 | Imported records shall preserve source traceability, including source file, import batch and source reference/page where available. | SOW §6 | SOW requirement | MVP | `source_document_id`, `import_batch_id`, `import_row_id`, `source_ref` | — |
| REQ-DI-11 | Data statuses shall include, where applicable: Verified, Calculated, Estimated, Inferred, Incomplete, Needs Review, Duplicate, Rejected. | SOW §6 | SOW requirement | MVP | ADR-016 (`assurance_level` + `record_status`) | — |
| REQ-DI-12 | Invalid and duplicate data is surfaced rather than silently discarded. | SOW §23 | SOW requirement | MVP | `import_rows` retained; CD-12 | CD-12 |
| REQ-DI-13 | Supported financial files can be uploaded and validated. | SOW §23 | SOW requirement | MVP | REQ-DI-01..08 | — |
| REQ-DI-14 | Column mappings can be saved per organization and reused; the importer suggests mappings from headers. | SOW §6 ("mapping") | Architectural | MVP | `import_mappings` | — |
| REQ-DI-15 | Import commit is a single transaction, enqueues recalculation, and can be rolled back without deleting rows. | SOW §23 | Architectural | MVP | ADR-012 | — |
| REQ-DI-16 | A file with a SHA-256 already committed in the organization is blocked with a link to the earlier batch. | SOW §23 | Architectural | MVP | `source_documents.sha256` unique | — |

## 5. Documents

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-DO-01 | File storage shall use Supabase Storage. | SOW §4 | SOW requirement | MVP | bucket `source-documents` | — |
| REQ-DO-02 | Source documents shall be access-controlled. | SOW §5 | SOW requirement | MVP | `documents.view`; Storage RLS (TENANCY §8) | CD-17 |
| REQ-DO-03 | File uploads shall be validated and safely stored. | SOW §5 | SOW requirement | MVP | SECURITY §8 | — |
| REQ-DO-04 | Source data shall be part of the financial data engine's scope. | SOW §3 | SOW requirement | MVP | `source_documents` | — |
| REQ-DO-05 | Documents are downloadable only through short-lived signed URLs minted after a permission check, and every download is audited. | SOW §5 | Architectural | MVP | ADR-013, `audit_events` | — |
| REQ-DO-06 | Documents are classified by kind (bank statement, general ledger, trial balance, P&L, balance sheet, sales/purchase report, invoice, receipt, other). | SOW §6 | Architectural | MVP | `source_documents.document_kind` | — |

## 6. Financial Data

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-FD-01 | The Financial Data Engine covers accounting, revenue, expenses, customers, suppliers, invoices, payments and source data. | SOW §3 | SOW requirement | MVP | ADR-004 | — |
| REQ-FD-02 | Phase 2 delivers financial, banking, sales, purchase, document and classification schemas. | SOW §21 | SOW requirement | MVP | DATABASE_ARCHITECTURE.md | — |
| REQ-FD-03 | Every imported account is mapped to one of the standard categories; unmapped accounts are `uncategorised` and dependent metrics are marked incomplete, never silently excluded. | SOW §7 | Architectural | MVP | CD-04 | CD-04 |
| REQ-FD-04 | Customers and suppliers are stored as counterparties with a kind. | SOW §3, §12 | Architectural | MVP | `counterparties` | — |
| REQ-FD-05 | Financial records are never hard-deleted while the organization exists; corrections supersede, imports roll back by soft rejection. | SOW §5, §23 | Architectural | MVP | ADR-012 | — |
| REQ-FD-06 | One base currency per organization; every amount column stores a currency code. | SOW §7 | Architectural | MVP-limited: single currency | CD-10, ADR-006 | CD-10 |
| REQ-FD-07 | Calendar months are the atomic period; fiscal-year start month is configurable. | SOW §7, §12 | Architectural | MVP | ADR-007 | CD-09 |
| REQ-FD-08 | MOTION sits above existing accounting and business systems rather than replacing every specialist system. | SOW §1 | SOW requirement | MVP (principle) | — | — |
| REQ-FD-09 | Invoice line items and products/services are captured for product contribution. | SOW §7, §16 | SOW requirement | **Built (P14)**: `products`, `invoice_lines` (Σ ≤ invoice net), split form on the customer page | `invoice_lines` | CD-08, ADR-102 |

## 7. Banking

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-BK-01 | Bank account overview. | SOW §15 | SOW requirement | **Built (P13)**: `/money/banking` accounts with statement balance, in/out/net, freshness, reconciliation; add-account form | `bank_accounts`, `api.bank_period_summary` | ADR-101 |
| REQ-BK-02 | Balances and cash trends. | SOW §15 | SOW requirement | **Built (P13)**: engine cash figures + statement balances as facts; three-month trend | `closing_cash`, `opening_cash` | CD-06, ADR-101 |
| REQ-BK-03 | Inflows and outflows. | SOW §15 | SOW requirement | MVP | `cash_inflows`, `cash_outflows`; transfers excluded | CD-28 |
| REQ-BK-04 | Transaction categorisation. | SOW §15 | SOW requirement | **Built (P13)**: the keyword ladder now RUNS inside every calculation (banking pass); user override on the transaction page | `bank_transactions.category_account_id`, `category_history` | ADR-101 |
| REQ-BK-05 | Recurring payments. | SOW §15 | SOW requirement | **Built (P13)**: detected by the pass, listed on `/money/banking` and through tool 21 | `recurring_payment_groups` | ADR-101 |
| REQ-BK-06 | Unusual transaction detection. | SOW §15, §13 | SOW requirement | **Built (P13)**: the deterministic alert rules surface under "Things to notice" and tool 22, with transfer look-alikes | Alert rules (REQ-AL-03) | ADR-101 |
| REQ-BK-07 | Liquidity indicators. | SOW §8, §15 | SOW requirement | **Built (P13)**, limited by design: cash available, runway, net movement, three-month trend, cash concentration across accounts; each says "not enough data" rather than guessing; no invented ratios | CD-20 | ADR-101 |
| REQ-BK-08 | Reconciliation status. | SOW §15 | SOW requirement | **Built (P13)** as CD-20 defines it: per account and month from the statement batch (reconciled / does not reconcile / not checked / no statement) and the engine's statement cross-check at organisation level. Line-by-line matching to ledger entries remains post-MVP | CD-20 | CD-20, ADR-101 |
| REQ-BK-09 | Bank transaction drill-down to source data. | SOW §15 | SOW requirement | **Built (P13)**: figure → drawer → rows; transaction page → record page → statement (`documents.view`) | `source_ref`, evidence UI | ADR-101 |
| REQ-BK-10 | Live bank connectivity shall be implemented only through supported secure integrations; the system shall not claim live connectivity where none exists. | SOW §15 | SOW requirement | **Honoured (P13)**: no provider exists; every banking page and tool states "imported statements, not connected" with the last import date; the vocabulary of a connection is tested absent | CD-21 | ADR-101 |
| REQ-BK-11 | Banking intelligence includes cash movement, recurring payments, anomalies and reconciliation (module scope). | SOW §3 | SOW requirement | **Built (P13)** per REQ-BK-01…09 | — | ADR-101 |

## 8. Calculations

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-CA-01 | Financial calculations shall be deterministic, testable and independent of the language model; the LLM shall not be the authoritative calculator. | SOW §7, §11 | SOW requirement | MVP | ADR-008, ADR-010 | — |
| REQ-CA-02 | Revenue and revenue growth. | SOW §7 | SOW requirement | MVP | `revenue`, `revenue_growth_mom`, `revenue_growth_yoy` | CD-03 |
| REQ-CA-03 | Gross profit and gross margin. | SOW §7 | SOW requirement | MVP | `gross_profit`, `gross_margin` | CD-05 |
| REQ-CA-04 | Operating expenses and operating profit. | SOW §7 | SOW requirement | MVP | `operating_expenses`, `operating_profit` | CD-05 |
| REQ-CA-05 | Net profit and net margin. | SOW §7 | SOW requirement | MVP | `net_profit`, `net_margin` | CD-05 |
| REQ-CA-06 | Cash inflows, outflows and net cash movement. | SOW §7 | SOW requirement | MVP | `cash_inflows`, `cash_outflows`, `net_cash_movement` | CD-28 |
| REQ-CA-07 | Opening and closing cash. | SOW §7 | SOW requirement | MVP | `opening_cash`, `closing_cash` | CD-06 |
| REQ-CA-08 | Receivables and payables. | SOW §7 | SOW requirement | MVP | `receivables`, `payables`, `*_days`, `*_overdue` | CD-07 |
| REQ-CA-09 | Working capital. | SOW §7 | SOW requirement | MVP | `working_capital` | — |
| REQ-CA-10 | Contribution margin. | SOW §7 | SOW requirement | MVP | `contribution_margin`, `contribution_margin_ratio` | CD-05 |
| REQ-CA-11 | Customer/product/service contribution where data supports it. | SOW §7 | SOW requirement | **Built (P14)**: product/service contribution from sales and purchase lines, "unavailable" without a cost line; customer contribution remains the engine's (revenue less recorded customer costs) | `customer_revenue`, `customer_contribution`, `api.product_period_summary` | CD-08, ADR-102 |
| REQ-CA-12 | Revenue, cost and customer concentration. | SOW §7 | SOW requirement | MVP | `customer_concentration_top1/top5`, `revenue_concentration_hhi`, `supplier_concentration_top1/top5` | — |
| REQ-CA-13 | Period-over-period variance. | SOW §7 | SOW requirement | MVP | `{base}.variance.{prev_period\|same_period_last_year\|trailing_3m_avg}` | — |
| REQ-CA-14 | Budget/forecast variance where applicable. | SOW §7 | SOW requirement | Built locally (ADR-142): budget against actual beside the engine (`budget_variance.v1`); forecast variance via Phase 11 | ADR-142 | CD-27 |
| REQ-CA-15 | Financial metrics are calculated deterministically; dashboard figures originate from application data/calculation services. | SOW §23 | SOW requirement | MVP | `metric_snapshots`, `calculation_runs` | — |
| REQ-CA-16 | Each metric records its basis (period_balances / ledger / invoices / bank), assurance level and data quality; sources are never summed across for one metric-period. | SOW §7, §11 | Architectural | MVP | ADR-005 | CD-03 |

## 9. Business Health

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-BH-01 | MOTION shall provide an explainable 0–100 Business Health Score. | SOW §3, §9 | SOW requirement | MVP | `health_scores` | CD-19 |
| REQ-BH-02 | The score is an analytical indicator and shall not be represented as a lending decision or guarantee. | SOW §9 | SOW requirement | MVP | UX disclaimer copy | — |
| REQ-BH-03 | Dimension: Profitability (margins, profit trend, contribution). | SOW §9 | SOW requirement | MVP | REQ-CA-03..05, 10 | — |
| REQ-BH-04 | Dimension: Cash Flow (cash movement, liquidity pressure, cash trend). | SOW §9 | SOW requirement | MVP | REQ-CA-06, 07 | — |
| REQ-BH-05 | Dimension: Revenue Growth (growth, recurring revenue, volatility and concentration). | SOW §9 | SOW requirement | MVP-limited: recurring revenue only where invoice data supports it | REQ-CA-02, 12 | — |
| REQ-BH-06 | Dimension: Cost Control (cost/revenue ratios, variance and unusual expenditure). | SOW §9 | SOW requirement | MVP | REQ-CA-04, 13; alerts | — |
| REQ-BH-07 | Dimension: Customer Quality (customer contribution, concentration and retention where available). | SOW §9 | SOW requirement | MVP-limited: retention requires 12+ months of invoice data | REQ-CA-11, 12 | — |
| REQ-BH-08 | Dimension: Marketing Efficiency (CAC, revenue/contribution per acquisition where available). | SOW §9 | SOW requirement | Built locally, health.config.v5, not reviewed (ADR-147); thresholds PROPOSED | Commercial Intelligence | — |
| REQ-BH-09 | Dimension: Banking Health (balance trends, inflow/outflow behaviour and transaction anomalies). | SOW §9 | SOW requirement | MVP | REQ-BK-02..06 | — |
| REQ-BH-10 | Dimension: Funding Readiness (indicative financial and banking readiness factors). | SOW §9 | SOW requirement | Built locally, health.config.v5, for every organisation, not reviewed (ADR-147) | Funding Readiness | — |
| REQ-BH-13 | Each dimension shall expose the underlying metrics, rules, positive factors, negative factors and data-quality status. | SOW §9 | SOW requirement | MVP | `health_scores.breakdown` | — |
| REQ-BH-12 | Dimensions with insufficient data are excluded and weights renormalised; the score states how many dimensions it is based on; weights and rules are versioned. | SOW §9 | Architectural | MVP | ADR-017, CD-19 | — |

## 10. Alerts

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-AL-01 | Rules-based identification of material financial and banking changes. | SOW §3, §13 | SOW requirement | MVP | `alerts` | CD-18 |
| REQ-AL-02 | Unusual expense increases. | SOW §13 | SOW requirement | MVP | `expense_by_category`, variance | — |
| REQ-AL-03 | Unusual bank transactions. | SOW §13 | SOW requirement | MVP | `bank_transactions` | — |
| REQ-AL-04 | Revenue decline. | SOW §13 | SOW requirement | MVP | `revenue.variance.*` | — |
| REQ-AL-05 | Margin deterioration. | SOW §13 | SOW requirement | MVP | `gross_margin`, `net_margin` | — |
| REQ-AL-06 | Cash deterioration. | SOW §13 | SOW requirement | MVP | `closing_cash`, `cash_runway_months` | — |
| REQ-AL-07 | Receivables/payables deterioration. | SOW §13 | SOW requirement | MVP | `receivables_days`, `payables_days`, `*_overdue` | — |
| REQ-AL-08 | Customer or supplier concentration. | SOW §13 | SOW requirement | MVP | REQ-CA-12 | — |
| REQ-AL-09 | Unusual recurring payments. | SOW §13 | SOW requirement | MVP | `recurring_payment_groups` | — |
| REQ-AL-10 | Duplicate transactions. | SOW §13 | SOW requirement | MVP | `dedupe_hash` | — |
| REQ-AL-11 | Large transaction deviations. | SOW §13 | SOW requirement | MVP | `bank_transactions`, `ledger_entries` | — |
| REQ-AL-12 | Significant period variance. | SOW §13 | SOW requirement | MVP | REQ-CA-13 | — |
| REQ-AL-15 | Each alert shall contain severity, explanation, affected metric, period, evidence and recommended next step; alerts contain evidence and severity (acceptance). | SOW §13, §23 | SOW requirement | MVP | `alerts` columns; `evidence_bundle_id` | — |

## 11. AI Analyst

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-AI-01 | AI layer is the Claude API through a secure server-side abstraction; API keys are never exposed to the browser. | SOW §4, §5 | SOW requirement | MVP | ADR-023 | — |
| REQ-AI-02 | The AI Financial Analyst is a core product capability; it shall not operate as a generic chatbot; it shall interpret validated financial calculations and structured evidence. | SOW §10 | SOW requirement | MVP | ADR-010 | — |
| REQ-AI-03 | Supported question: Why did profit increase or decrease? | SOW §10 | SOW requirement | MVP | get_metric_trend, get_expense_changes | — |
| REQ-AI-04 | Supported question: Why is cash falling? | SOW §10 | SOW requirement | MVP | get_cash_analysis | — |
| REQ-AI-05 | Supported question: Which expenses increased the most? | SOW §10 | SOW requirement | MVP | get_expense_changes | — |
| REQ-AI-06 | Supported question: Which customers are most profitable? | SOW §10 | SOW requirement | MVP-limited: answered as revenue contribution with an explicit caveat | get_customer_profitability; CD-08 | CD-08 |
| REQ-AI-07 | Supported question: Where is the business losing money? | SOW §10 | SOW requirement | MVP | get_expense_changes, get_metric | — |
| REQ-AI-08 | Supported question: Which products/services have the strongest contribution? | SOW §10 | SOW requirement | **Built (P14)**: tool 24 `get_product_contribution` | REQ-FD-09 | ADR-102 |
| REQ-AI-09 | Supported question: What changed this month? | SOW §10 | SOW requirement | MVP | get_business_summary | — |
| REQ-AI-10 | Supported question: What risks require attention? | SOW §10 | SOW requirement | MVP | get_alerts, get_health_score | — |
| REQ-AI-11 | Supported question: What should management focus on? | SOW §10 | SOW requirement | MVP | get_alerts, get_actions | — |
| REQ-AI-12 | Supported question: Can the business afford a proposed expenditure? | SOW §10 | SOW requirement | Built locally, not reviewed (ADR-146): `check_affordability` reports MOTION's cash check of a stated amount against the forecast (affordable / tight / not affordable); without an amount the analyst asks for one. Also on the What-if page | get_cash_analysis | — |
| REQ-AI-13 | Supported question: What happens if revenue or costs change? | SOW §10 | SOW requirement | **Delivered (P12, ADR-100)**: the analyst READS a saved scenario through tool 19; working a new one out is the deterministic engine's job and the analyst refuses it by name, pointing at the What-if page | Scenarios | — |
| REQ-AI-14 | Standard response structure: Direct answer, Key findings, Causes/drivers, Risks, Opportunities, Recommended actions, Confidence/data-quality notes, Evidence and source trail. | SOW §10 | SOW requirement | MVP | `ai_messages.structured_response` | — |
| REQ-AI-15 | The AI shall never invent financial figures, transactions or source records. | SOW §11, §23 | SOW requirement | MVP | Numeric grounding check (ADR-010) | — |
| REQ-AI-16 | The AI shall not present estimates as verified facts. | SOW §11 | SOW requirement | MVP | `assurance_level` propagated in tool outputs | — |
| REQ-AI-17 | The AI shall distinguish facts, calculations, estimates, inferences and recommendations. | SOW §11 | SOW requirement | MVP | Response contract claim types | — |
| REQ-AI-18 | The AI shall not bypass user permissions or company isolation; it does not access unauthorised company data. | SOW §11, §23 | SOW requirement | MVP | Tools run with caller's `AccessContext` | — |
| REQ-AI-19 | Material financial figures shall originate from deterministic calculation services. | SOW §11 | SOW requirement | MVP | Tools read `metric_snapshots` only | — |
| REQ-AI-20 | Material AI conclusions shall be traceable to evidence. | SOW §11, §23 | SOW requirement | MVP | `evidence_bundles` per answer | — |
| REQ-AI-21 | AI prompts and outputs shall be designed to resist prompt-injection attempts and data leakage. | SOW §11 | SOW requirement | MVP | AI_ARCHITECTURE.md defences | — |
| REQ-AI-22 | The system shall provide a mechanism to report incorrect insights. | SOW §11 | SOW requirement | MVP | `ai_feedback` | CD-25 |
| REQ-AI-23 | AI Financial Analyst answers supported financial questions using validated data (acceptance). | SOW §23 | SOW requirement | MVP | REQ-AI-03..12 | — |
| REQ-AI-28 | Claude operates only through a closed set of typed server-side tools; no model-generated SQL; tool calls are logged. | Role brief | Derived from role brief | MVP | `ai_tool_calls`, ADR-010 | — |
| REQ-AI-29 | AI usage is quota-limited per organization and rate-limited per user. | SOW §26 (API limits) | Architectural | MVP | CD-24 | CD-24 |

## 12. Evidence

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-EV-01 | Material conclusions shall be inspectable through an evidence layer. | SOW §12 | SOW requirement | MVP | `evidence_bundles`, `evidence_items` | — |
| REQ-EV-02 | Evidence element: Financial metric. | SOW §12 | SOW requirement | MVP | item_type `metric_snapshot` | — |
| REQ-EV-03 | Evidence element: Calculation. | SOW §12 | SOW requirement | MVP | item_type `calculation_run` | — |
| REQ-EV-04 | Evidence element: Transaction. | SOW §12 | SOW requirement | MVP | item_type `ledger_entry` | — |
| REQ-EV-05 | Evidence element: Invoice. | SOW §12 | SOW requirement | MVP | item_type `invoice` | — |
| REQ-EV-06 | Evidence element: Bank transaction. | SOW §12 | SOW requirement | MVP | item_type `bank_transaction` | — |
| REQ-EV-07 | Evidence element: Customer. | SOW §12 | SOW requirement | MVP | item_type `counterparty` | — |
| REQ-EV-08 | Evidence element: Supplier. | SOW §12 | SOW requirement | MVP | item_type `counterparty` | — |
| REQ-EV-09 | Evidence element: Source document. | SOW §12 | SOW requirement | MVP | item_type `source_document` | — |
| REQ-EV-10 | Evidence element: Accounting period. | SOW §12 | SOW requirement | MVP | item_type `fiscal_period` | — |
| REQ-EV-11 | A user should be able to move from an AI statement to the calculation and then to the underlying records/source document. | SOW §12 | SOW requirement | MVP | Evidence drawer UI | — |
| REQ-EV-13 | Progressive drill-down: Dashboard → Analysis → Account/Customer/Category → Transaction → Source Document. | SOW §8 | SOW requirement | MVP | ADR-009 query descriptors | — |

## 13. Actions

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-AC-01 | The Action Centre shall convert intelligence into accountable execution; turn insights into assigned, trackable management actions. | SOW §3, §17 | SOW requirement | MVP | `actions` | — |
| REQ-AC-02 | Field: Issue — problem or opportunity that triggered the action. | SOW §17 | SOW requirement | MVP | `actions.issue` | — |
| REQ-AC-03 | Field: Recommendation — AI or user-defined recommendation. | SOW §17 | SOW requirement | MVP | `actions.recommendation` | — |
| REQ-AC-04 | Field: Priority — Critical / High / Medium / Low. | SOW §17 | SOW requirement | MVP | `actions.priority` | — |
| REQ-AC-05 | Field: Owner — assigned person/team. | SOW §17 | SOW requirement | MVP-limited: person only (teams Post-MVP, CD-26) | `actions.owner_user_id` | — |
| REQ-AC-06 | Field: Due Date — target completion date. | SOW §17 | SOW requirement | MVP | `actions.due_date` | — |
| REQ-AC-07 | Field: Status — Open / In Progress / Completed / Dismissed. | SOW §17 | SOW requirement | MVP | `actions.status` | — |
| REQ-AC-08 | Field: Evidence — linked analysis/source evidence. | SOW §17 | SOW requirement | MVP | `actions.evidence_bundle_id` | — |
| REQ-AC-09 | Field: Outcome — result/value after completion, where applicable. | SOW §17 | SOW requirement | MVP | `actions.outcome_notes`, `outcome_value` | — |
| REQ-AC-10 | Users can convert recommendations into actions. | SOW §23 | SOW requirement | MVP | Create-from AI/alert/health | — |
| REQ-AC-11 | Outstanding management actions appear on the dashboard. | SOW §8 | SOW requirement | MVP | Home widget | — |

## 14. Forecasting

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-FC-01 | Forecasting shall support revenue, expenses, operating profit, cash, receivables and payables where sufficient data exists. | SOW §3, §14 | SOW requirement | Post-MVP (P11) | `forecast.*` | — |
| REQ-FC-02 | Forecast engine and actual-vs-forecast views. | SOW §21 | SOW requirement | Post-MVP (P11) | REQ-FC-01 | — |
| REQ-FC-03 | Budget import (period, account/category, amount). | SOW §7 | Architectural | Built locally (ADR-142): import type `budget` through the wizard into `budget_lines` | ADR-142 | CD-27 |
| REQ-FC-04 | Budget/forecast variance metrics. | SOW §7 | SOW requirement | Built locally (ADR-142): `/money/budget` and analyst tool 27; not engine metrics (owner decision) | REQ-CA-14, ADR-142 | — |
| REQ-FC-05 | Forecast outputs carry assurance level `estimated` and are never shown as verified. | SOW §11 | Architectural | Post-MVP (P11) | ADR-016 | — |

## 15. Scenarios

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-SC-01 | What-If Scenarios: user-defined assumptions and baseline-vs-scenario analysis. | SOW §3, §14 | SOW requirement | **Delivered (P12, ADR-100)** | REQ-FC-01 | — |
| REQ-SC-02 | Scenario change: revenue increases/decreases. | SOW §14 | SOW requirement | **Delivered (P12, ADR-100)** | — | — |
| REQ-SC-03 | Scenario change: payroll changes. | SOW §14 | SOW requirement | **Delivered (P12, ADR-100)** | standard category `payroll` | — |
| REQ-SC-04 | Scenario change: supplier cost changes. | SOW §14 | SOW requirement | **Delivered (P12, ADR-100)** | — | — |
| REQ-SC-05 | Scenario change: marketing spend changes. | SOW §14 | SOW requirement | **Delivered (P12, ADR-100)** | standard category `marketing` | — |
| REQ-SC-06 | Scenario change: hiring. | SOW §14 | SOW requirement | **Delivered (P12, ADR-100)** | — | — |
| REQ-SC-07 | Scenario change: pricing changes. | SOW §14 | SOW requirement | **Delivered (P12, ADR-100)** | — | — |
| REQ-SC-08 | Scenario change: debt and repayment assumptions. | SOW §14 | SOW requirement | **Delivered (P12, ADR-100)** | — | — |
| REQ-SC-09 | Outputs shall show BASELINE versus SCENARIO and clearly expose assumptions. | SOW §14 | SOW requirement | **Delivered (P12, ADR-100)** | — | — |
| REQ-SC-10 | What-if scenario engine and saved scenarios. | SOW §21 | SOW requirement | **Delivered (P12, ADR-100)** | — | — |

## 16. Commercial Intelligence

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-CI-01 | Commercial intelligence shall connect commercial activity with financial outcomes: Traffic → Lead → Opportunity → Customer → Revenue → Cost → Contribution. | SOW §16 | SOW requirement | **Built (P14)** (lead onward; traffic has no source yet) | `counterparties` seam, `opportunities`, `campaigns`, `invoice_lines` | CD-01, ADR-102 |
| REQ-CI-02 | CRM and customer records. | SOW §3, §16 | SOW requirement | **Built (P14, minimal)**: counterparties remain the record; products bought, win path and opportunities added to the customer page; not a CRM replacement (REQ-CI-14) | `counterparties` | CD-01, ADR-102 |
| REQ-CI-03 | Sales pipeline. | SOW §16 | SOW requirement | **Built (P14)**: `/customers/sales`, five stages, tool 26 | `opportunities` | ADR-102 |
| REQ-CI-04 | Products/services. | SOW §16 | SOW requirement | **Built (P14)**: `/customers/products` | `products` | ADR-102 |
| REQ-CI-05 | Marketing campaigns. | SOW §16 | SOW requirement | **Built (P14)**: `/customers/marketing`, monthly spend | `campaigns`, `campaign_spend` | ADR-102 |
| REQ-CI-06 | Marketing channels. | SOW §16 | SOW requirement | **Built (P14)** | `marketing_channels` | ADR-102 |
| REQ-CI-07 | Customer profitability. | SOW §16 | SOW requirement | **Built-limited (P14)**: the engine's `customer_contribution` on the customer page with the CD-08 note; equals revenue until customer costs are recorded | CD-08 | CD-08, ADR-102 |
| REQ-CI-08 | Campaign profitability. | SOW §16 | SOW requirement | **Built (P14)**: credited revenue less spend, labelled as such | `campaign_spend` | ADR-102 |
| REQ-CI-09 | Acquisition cost. | SOW §16 | SOW requirement | **Built (P14)**: campaign spend ÷ customers won through it in the window, both named; null with reason otherwise | — | ADR-102 |
| REQ-CI-10 | Conversion. | SOW §16 | SOW requirement | **Built (P14)**: cohort created in the window; both denominators named | — | ADR-102 |
| REQ-CI-11 | Customer concentration (commercial view). | SOW §16 | SOW requirement | **Built (P14)**: overview shows top-1/top-5 and the twelve-month top-5 trend, measured not judged | REQ-CA-12 | ADR-102 |
| REQ-CI-12 | Sales performance. | SOW §16 | SOW requirement | **Built (P14)**: won/lost/won value by month beside engine revenue | — | ADR-102 |
| REQ-CI-13 | Marketing Analysis: analyse, monitor and report on marketing performance of current activities and spend; review market opportunities and advise on measures to improve marketing strategy. | SOW §3 | SOW requirement | Post-MVP (P14), requires mini-SOW | CD-26 | CD-01, CD-26 |
| REQ-CI-14 | Full CRM replacement and advanced attribution are post-MVP expansion. | SOW §22 | SOW requirement | Post-MVP (P14+) | — | — |

## 17. Adviser/CFO functionality

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-AD-01 | An authorised adviser shall be able to monitor multiple client companies. | SOW §18 | SOW requirement | MVP-limited: `/portfolio` list of assigned organizations with health score and open alert count | `organization_assignments` | CD-02 |
| REQ-AD-02 | Client isolation and explicit assignment permissions are mandatory. | SOW §18 | SOW requirement | MVP | TENANCY §5 | — |
| REQ-AD-03 | Client portfolio dashboard. | SOW §18 | SOW requirement | Post-MVP (P15) | REQ-AD-01 | — |
| REQ-AD-04 | Client health scores (portfolio view). | SOW §18 | SOW requirement | Post-MVP (P15); MVP shows score per card | — | — |
| REQ-AD-05 | Clients requiring attention. | SOW §18 | SOW requirement | Post-MVP (P15) | — | — |
| REQ-AD-06 | Client alerts (cross-client). | SOW §18 | SOW requirement | Post-MVP (P15) | — | — |
| REQ-AD-07 | Client AI analysis (cross-client). | SOW §18 | SOW requirement | Post-MVP (P15); MVP AI is per organization | — | — |
| REQ-AD-08 | Client reports (cross-client). | SOW §18 | SOW requirement | Post-MVP (P15) | — | — |
| REQ-AD-09 | Outstanding actions (cross-client). | SOW §18 | SOW requirement | Post-MVP (P15) | — | — |
| REQ-AD-10 | Advisory opportunities. | SOW §18 | SOW requirement | Post-MVP (P15) | — | — |

## 18. Funding Readiness

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-FR-01 | MOTION shall provide an indicative Funding Readiness Assessment based on available financial, banking and business information. | SOW §3, §19 | SOW requirement | Phase 16 — built locally (ADR-145), behind `features.funding_readiness` (off by default); not independently reviewed | — | — |
| REQ-FR-02 | It shall not constitute a lending decision, approval or guarantee; funding readiness is indicative and does not guarantee funding. | SOW §19, §26 | SOW requirement | Phase 16 — built locally (ADR-145), behind `features.funding_readiness` (off by default); not independently reviewed | Disclaimer copy | — |
| REQ-FR-03 | Factor: Revenue and profitability. | SOW §19 | SOW requirement | Phase 16 — built locally (ADR-145), behind `features.funding_readiness` (off by default); not independently reviewed | — | — |
| REQ-FR-04 | Factor: Cash flow. | SOW §19 | SOW requirement | Phase 16 — built locally (ADR-145), behind `features.funding_readiness` (off by default); not independently reviewed | — | — |
| REQ-FR-05 | Factor: Banking behaviour. | SOW §19 | SOW requirement | Phase 16 — built locally (ADR-145), behind `features.funding_readiness` (off by default); not independently reviewed | — | — |
| REQ-FR-06 | Factor: Existing debt. | SOW §19 | SOW requirement | Phase 16 — built locally (ADR-145), behind `features.funding_readiness` (off by default); not independently reviewed | standard categories `loan`, `long_term_liability` | — |
| REQ-FR-07 | Factor: Receivables and payables. | SOW §19 | SOW requirement | Phase 16 — built locally (ADR-145), behind `features.funding_readiness` (off by default); not independently reviewed | — | — |
| REQ-FR-08 | Factor: Financial consistency. | SOW §19 | SOW requirement | Phase 16 — built locally (ADR-145), behind `features.funding_readiness` (off by default); not independently reviewed | — | — |
| REQ-FR-09 | Factor: Data completeness. | SOW §19 | SOW requirement | Phase 16 — built locally (ADR-145), behind `features.funding_readiness` (off by default); not independently reviewed | `data_quality` | — |
| REQ-FR-10 | The output shall show readiness score, positive factors, negative factors, missing information, improvement actions and evidence. | SOW §19 | SOW requirement | Phase 16 — built locally (ADR-145), behind `features.funding_readiness` (off by default); not independently reviewed | — | — |
| REQ-FR-11 | Lender marketplace/matching is post-MVP expansion. | SOW §22 | SOW requirement | Post-MVP (P16+) | — | — |

## 19. Reporting

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-RP-01 | Monthly Management Report: financial, cash, commercial and management analysis. | SOW §20 | SOW requirement | MVP-limited: financial, cash and management sections; commercial section Post-MVP (P14) | ADR-024 | — |
| REQ-RP-02 | Daily Executive Brief: key movements, risks, opportunities and actions. | SOW §20 | SOW requirement | Phase 17 — built locally (ADR-141); Daily Challenges is its attention section (R17-2) | ADR-141 | — |
| REQ-RP-03 | Weekly Intelligence Report: financial changes, causes and unresolved issues. | SOW §20 | SOW requirement | Phase 17 — built locally (ADR-141); week-on-week comparison (R17-2) | ADR-141 | — |
| REQ-RP-04 | Accountant/CFO Report: adviser-ready client intelligence. | SOW §20 | SOW requirement | Phase 17 — built locally, per client (ADR-141) | REQ-AD-*, ADR-141 | — |
| REQ-RP-05 | Funding Readiness Report: indicative readiness assessment and evidence. | SOW §20 | SOW requirement | Phase 17 — built locally behind `features.funding_readiness`, not reviewed (ADR-141, ADR-145) | REQ-FR-* | — |
| REQ-RP-06 | Custom AI Report: user-selected period, questions and analytical dimensions. | SOW §20 | SOW requirement | Phase 17 — built locally (ADR-141, R17-4) | ADR-141 | — |
| REQ-RP-07 | Intelligent Reporting module: daily, weekly, monthly, adviser and funding-readiness reports. | SOW §3, §21 | SOW requirement | Phase 17 — built locally (REQ-RP-05 behind the Funding Readiness flag) | ADR-141 | — |

## 20. Platform Administration

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-PA-01 | Platform administration uses a separate platform/admin experience. | Role brief | Derived from role brief | MVP | ADR-019, `/platform` | — |
| REQ-PA-02 | Super Admin can create, suspend and archive organizations and toggle feature flags. | Role brief; SOW §23 | Derived from role brief | MVP | `platform.orgs.manage` | — |
| REQ-PA-03 | Super Admin can grant and revoke platform roles. | Role brief | Derived from role brief | MVP | `platform.users.manage` | — |
| REQ-PA-04 | Super Admin can assign Employees to organizations and revoke assignments. | Role brief | Derived from role brief | MVP | `assignments.manage` | — |
| REQ-PA-05 | Super Admin can monitor background jobs and retry failures. | SOW §21 (Phase 18) | Architectural | MVP | `jobs`, `platform.jobs.view` | — |
| REQ-PA-06 | Platform staff review reported incorrect insights. | SOW §11 | SOW requirement | MVP | `ai_feedback`, `platform.ai_feedback.review` | CD-25 |
| REQ-PA-07 | Super Admin can search the platform-wide audit log. | SOW §5 | Architectural | MVP | `audit.view` (all) | — |
| REQ-PA-08 | Super Admin can set per-organization AI quotas and global defaults. | SOW §26 | Architectural | MVP | `platform_settings`, `organizations.settings` | — |
| REQ-PA-09 | Post-MVP modules ship dark behind per-organization feature flags. | SOW §22 | Architectural | MVP | ADR-025 | — |

## 21. Audit/Security

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-AS-01 | Security: Row Level Security, role-based access control and tenant isolation. | SOW §4 | SOW requirement | MVP | SECURITY_MODEL.md | — |
| REQ-AS-02 | API keys and sensitive credentials shall never be exposed to the browser. | SOW §5 | SOW requirement | MVP | SECURITY §5 | — |
| REQ-AS-03 | Important data changes and material system-generated events shall be auditable. | SOW §5 | SOW requirement | MVP | `audit_events`, ADR-015 | — |
| REQ-AS-04 | Developer shall protect credentials and tenant data. | SOW §25 | SOW requirement | MVP | SECURITY §5 | — |
| REQ-AS-05 | Critical/high security issues are resolved before production release. | SOW §23 | SOW requirement | MVP | SECURITY §18 checklist | — |
| REQ-AS-06 | Phase 18 delivers security audit, AI evaluation, performance and production readiness. | SOW §21 | SOW requirement | MVP | IMPLEMENTATION_PLAN.md | — |
| REQ-AS-07 | Audit log is append-only; no role can update or delete audit events. | SOW §5 | Architectural | MVP | ADR-015 | — |
| REQ-AS-08 | Super Admin reads of tenant data outside `/platform` are audited and visible to the organization's owner. | Role brief | Architectural | MVP | CD-13 | CD-13 |
| REQ-AS-09 | Owners and Admins can view their organization's audit log. | SOW §5 | Architectural | MVP | `audit.view` | — |
| REQ-AS-10 | Document downloads and data exports are audited. | SOW §5 | Architectural | MVP | CD-17 | CD-17 |
| REQ-AS-11 | Client and third-party source data remains subject to its applicable ownership and rights; the executed agreement governs IP, confidentiality, data processing and liability. | SOW §27 | SOW requirement | MVP (contractual) | — | — |
| REQ-AS-12 | Material features, integrations, workflows, reports or external services not in the SOW go through written change control. | SOW §28 | SOW requirement | MVP (process) | CD-26 | — |

## 22. Testing

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-TS-01 | Unit tests for financial calculations. | SOW §24, §21 (Phase 4) | SOW requirement | MVP | Golden datasets (CD-30) | CD-30 |
| REQ-TS-02 | Database constraints. | SOW §24 | SOW requirement | MVP | pgTAP | — |
| REQ-TS-03 | RLS and tenant isolation. | SOW §24 | SOW requirement | MVP | pgTAP, multi-JWT integration | — |
| REQ-TS-04 | Import parsing and validation. | SOW §24 | SOW requirement | MVP | Fixture files | — |
| REQ-TS-05 | API/service validation. | SOW §24 | SOW requirement | MVP | Zod schemas | — |
| REQ-TS-06 | AI behaviour and failure cases. | SOW §24 | SOW requirement | MVP | Eval set, adversarial suite | — |
| REQ-TS-07 | Evidence mapping. | SOW §24 | SOW requirement | MVP | — | — |
| REQ-TS-08 | Critical user journeys. | SOW §24 | SOW requirement | MVP | Playwright | — |
| REQ-TS-09 | Responsive UI. | SOW §24 | SOW requirement | MVP | 320–1440 px sweep | — |
| REQ-TS-10 | Security checks. | SOW §24 | SOW requirement | MVP | SECURITY §18 | — |
| REQ-TS-11 | Type checking, linting, automated tests and production build complete successfully. | SOW §23 | SOW requirement | MVP | CI | — |
| REQ-TS-12 | Permission matrix parity between TypeScript and the database is tested on every CI run. | Role brief | Architectural | MVP | ADR-003 | — |

## 23. Production Operations

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-PO-01 | Frontend: Next.js, TypeScript, Tailwind CSS and shadcn/ui. | SOW §4 | SOW requirement | MVP | ARCHITECTURE.md | — |
| REQ-PO-02 | Backend: Next.js server-side services/API routes and Supabase. | SOW §4 | SOW requirement | MVP | — | — |
| REQ-PO-03 | Database: Supabase PostgreSQL. | SOW §4 | SOW requirement | MVP | — | — |
| REQ-PO-04 | Charts: Recharts or equivalent suitable charting library. | SOW §4 | SOW requirement | MVP | — | — |
| REQ-PO-05 | Architecture: modular services separating UI, data access, calculations, intelligence and AI. | SOW §4 | SOW requirement | MVP | ADR-022 | — |
| REQ-PO-06 | Dashboard shows data quality and refresh status. | SOW §8 | SOW requirement | MVP | `calculation_runs`, `import_batches` | — |
| REQ-PO-07 | Developer documents configuration and deployment requirements; maintains code quality and documentation; reports blockers and technical risks promptly. | SOW §25 | SOW requirement | MVP | — | — |
| REQ-PO-08 | Long-running work (extraction, recalculation, purge, report render) runs through a database-backed job queue; imports over 5,000 rows are queued. | SOW §21 | Architectural | MVP | ADR-020, CD-22 | CD-22 |
| REQ-PO-09 | Hosting is Vercel + Supabase cloud in the region matching customer jurisdiction. | SOW §4 | Architectural | MVP | CD-22, CD-23 | CD-22, CD-23 |
| REQ-PO-10 | External data-provider availability, API limits, pricing and third-party terms are outside the application's control; data quality depends partly on supplied source information. | SOW §26 | SOW requirement | MVP (limitation surfaced in UI copy) | — | — |
| REQ-PO-11 | MOTION does not itself constitute accounting, audit, tax, legal, investment or lending advice; this is stated in product copy. | SOW §26 | SOW requirement | MVP | UX copy | — |
| REQ-PO-12 | Client provides approved requirements, branding assets, third-party access, sample data where permitted, milestone review and timely feedback. | SOW §25 | SOW requirement | MVP (process) | CD-30 | CD-30 |

Sections of the SOW cited above for completeness: §1 Project Overview (REQ-FD-08), SOW §2 Product Objective (five core questions, mapped to screens in `UX_ARCHITECTURE.md §2`; the DATA → … → OUTCOME principle is ARCHITECTURE.md §1), §3 Scope (module rows), §4 Technology, §5 Security, §6 Import, §7 Calculations, §8 Dashboard, §9 Health, §10 AI, §11 Governance, §12 Evidence, §13 Alerts, §14 Forecasting/Scenarios, §15 Banking, §16 Commercial, §17 Actions, §18 Adviser, §19 Funding, §20 Reporting, §21 Phases, §22 MVP, §23 Acceptance, §24 Testing, §25 Responsibilities, §26 Exclusions, §27 IP, §28 Change Control, §29 Commercial Strategy, SOW §30 Acknowledgement & Signatures (no functional requirement; noted for CD-01 — the later "Copy" file lacks this section). Partner Ecosystem and Social Responsibility/ESG (SOW §3, §22) are recorded as Post-MVP in `MVP_SCOPE.md §4` and carry no functional rows here; Investment Opportunities and Team Management System (SOW §3) are covered by CD-26. The role brief's derived requirements for the seven-item navigation and five customer questions are specified in `UX_ARCHITECTURE.md §2–3`, and the MVP journey is defined in `MVP_SCOPE.md §1`.

---

## Non-functional requirements

| ID | Area | Requirement | Measure |
|---|---|---|---|
| NFR-01 | Performance — dashboard | Home renders with all current-period figures from `metric_snapshots` | p95 server render < 800 ms; LCP < 2.5 s on 4G |
| NFR-02 | Performance — AI | First streamed token after tool calls | p95 < 6 s; hard timeout 60 s; tool calls capped at 8 per answer (CD-24) |
| NFR-03 | Performance — import | Synchronous commit | ≤ 5,000 rows commit within 30 s; larger batches queued (CD-22) |
| NFR-04 | Performance — recalculation | Full 36-month recalculation for an organization with 100k ledger entries | < 5 min in the job worker, with L0 aggregation performed in SQL (`app.aggregate_periods`) so worker CPU scales with periods × dimensions, not rows; proven by spike S5 before Phase 6; fallback runtime per CD-34 (ADR-031.4) — Revision 1.2: each calculation chunk (≤ 12 months) completes in ≤ 1,500 CPU-ms and ≤ 60 s wall-clock in the job runtime; a 36-month run completes end to end in ≤ 5 minutes (ADR-041, ADR-047.7) |
| NFR-05 | File limits | Per file 25 MB; per import 50,000 rows; XLSX up to 20 sheets; PDF up to 200 pages | Validation errors above limits |
| NFR-06 | Availability | Application availability (excluding Supabase/Vercel platform incidents) | 99.5% monthly target for MVP |
| NFR-07 | Data residency | Supabase project and Storage in the region matching customer jurisdiction; no cross-region replication of tenant data | CD-23 |
| NFR-08 | Backup / recovery | Supabase point-in-time recovery enabled; Storage versioning; restore drill before launch | RPO 24 h, RTO 4 h for MVP |
| NFR-09 | Accessibility | WCAG 2.2 AA for all customer-facing pages | Automated axe scan clean; keyboard pass on critical journeys |
| NFR-10 | Browser support | Last 2 versions of Chrome, Edge, Safari, Firefox; iOS Safari and Android Chrome | Playwright matrix |
| NFR-11 | Responsive | Usable from 320 px to 1440 px+ without horizontal scroll | Responsive sweep |
| NFR-12 | Precision | Money exact to the cent; no floating point on money paths | ADR-006; lint rule |
| NFR-13 | Determinism | Same inputs and engine version give identical `input_fingerprint` and values | Golden-dataset double run |
| NFR-14 | Audit retention | `audit_events` retained 7 years (metadata, IP and user agent redacted on organization purge, ADR-038.9); financial import rows and every `metric_snapshots` row referenced by evidence, health scores or alerts retained for the life of the organization (ADR-031.5) | CD-23 |
| NFR-15 | AI cost control | Per-org daily message quota (default 100), per-user 10/min, per-org monthly token ceiling shared with PDF extraction, `ai_extraction_pages_per_day` (default 300); all held in `platform_org_settings`, not tenant-writable | CD-24, ADR-033, ADR-038.5 |
| NFR-16 | Observability | Error tracking, structured logs with `request_id`, job failure alerts | SECURITY §15 |
| NFR-17 | Security baseline | OWASP ASVS Level 2; no table write privilege for `authenticated`; TOTP mandatory for platform users | SECURITY §18, ADR-026, ADR-038.8 |

## Revision 1.1 changes (red-team round 1)

New requirement rows added by the review. They belong to the groups named in their ids and are binding at the same level as Architectural rows. Existing rows are unchanged unless listed under "Amended".

| ID | Requirement | SOW § | Type | MVP | Dependencies | Open question |
|---|---|---|---|---|---|---|
| REQ-AS-13 | The `authenticated` database role holds no INSERT, UPDATE or DELETE privilege on any table; every user-initiated mutation is a SECURITY DEFINER `api.*` function that derives the actor from the session, checks `app.has_permission`, enforces governance and record invariants, and writes the audit event. | SOW §5 | Architectural | MVP | ADR-026, `DATABASE_ARCHITECTURE.md §14` | — |
| REQ-AS-14 | Background jobs are enqueued only through `api.enqueue_job` with a job-type → permission map; the worker scopes every job to the `jobs.organization_id` column, never to payload; `org.purge` is enqueued only by the deletion trigger with a 30-day delay and re-verified at run time. | SOW §5 | Architectural | MVP | ADR-026.4, ADR-038.12 | — |
| REQ-AS-15 | Platform users (super admin and employee) must enrol TOTP; platform surfaces require `aal2`; magic-link sign-in is refused for platform users; suspend, purge, role grants and assignment creation require re-authentication within 10 minutes. | SOW §5 | Architectural | MVP | ADR-038.8 | — |
| REQ-AS-16 | Organization and membership suspension are enforced inside the RLS helper functions (`app.org_role` returns `suspended_member`), not only in the application layer. | SOW §5 | Architectural | MVP | ADR-038.2 | — |
| REQ-AS-17 | Any `/platform` surface that renders tenant content writes `org.data_viewed` with the surface and target; audit payloads are collapsed until expanded. | Role brief | Architectural | MVP | ADR-038.6, CD-13 | — |
| REQ-AS-18 | On organization purge, `audit_events.metadata`, `ip` and `user_agent` are redacted; metadata keys are an allow-list of ids per action. | SOW §5 | Architectural | MVP | ADR-038.9, CD-23 | — |
| REQ-AS-19 | Every polymorphic reference column is guarded by a `same_org_ref` trigger and every plain FK on a tenant table is org-composite; pgTAP enumerates and enforces both. | SOW §5 | Architectural | MVP | ADR-034 | — |
| REQ-DO-07 | Storage objects are never readable or listable with the user JWT; all reads are 60-second signed URLs minted by `core/storage/signer.ts` after a permission check and an audit event; deletion removes the object. | SOW §5 | Architectural | MVP | ADR-038.1 | — |
| REQ-DO-08 | Rendered report PDFs live in the private `reports` bucket with a `report_files` row; download resolves by `(organization_id, id)`, is audited, and the prefix is deleted on purge. | SOW §20 | Architectural | MVP | ADR-038.7 | — |
| REQ-DO-09 | `import_rows`, `import_batches` and `import_mappings` are readable only with `imports.review`; bank identifiers are stored verbatim in raw fields and masked in `description_normalized`, which client-facing views and AI tools use. | SOW §5 | Architectural | MVP | ADR-038.4, CD-17 | — |
| REQ-DO-10 | Text-layer page text may be sent to the AI provider for PDF extraction only when `features.ai_pdf_extraction` is on; each send is audited (`document.sent_to_ai`) and the wizard shows a consent line. | SOW §6, §11 | Architectural | MVP | ADR-033, CD-35 | CD-35 |
| REQ-DI-21 | Trial balance and balance-sheet imports declare `balance_basis` (cumulative or movement) per batch; `period_balances` carry `period_start` per row so multi-period reports fan out correctly; total/subtotal rows are detected and excluded from accounts. | SOW §6 | Architectural | MVP | ADR-027.1, F-B-10 | — |
| REQ-DI-22 | Re-exported invoices matching `(invoice_type, counterparty, invoice_number)` with changed payment fields are update candidates that supersede the prior row, never duplicates. | SOW §6, §23 | Architectural | MVP | ADR-029.1 | — |
| REQ-DI-23 | A corrected file replaces its predecessor through a single "Replace" transaction (roll back old, commit new); rolling back a batch that other committed batches depend on is refused with the dependency named. | SOW §23 | Architectural | MVP | ADR-029.3 | — |
| REQ-DI-24 | Duplicate scope keys use stable identities (account code/name, masked bank identity), duplicate bank-account identities are refused at creation, and the exact-duplicate pass is re-run inside the commit transaction under an organization lock. | SOW §6, §23 | Architectural | MVP | ADR-029.4–5 | — |
| REQ-DI-25 | Within-batch identical rows that look like batch payments (≥ 3 on one day or payroll wording) default to keep; kept duplicates carry `duplicate_reviewed` and never raise duplicate alerts. | SOW §23 | Architectural | MVP | ADR-029.6 | — |
| REQ-DI-26 | Sales report and purchase report file types (SOW §6) are supported as import types mapped onto the invoice and ledger targets. | SOW §6 | SOW requirement | MVP | `IMPORT_ENGINE.md §6.1` | — |
| REQ-DI-27 | The Claude PDF path reconciles extracted rows only against balances captured deterministically or typed by the reviewer; a ±10% line-count check (`IMP-PDF-002`) governs whether page-level confirmation is allowed; every non-empty source line is recorded as a row or a skipped line. | SOW §6, §11 | Architectural | MVP | ADR-033 | — |
| REQ-DI-28 | The bank statement wizard captures the statement opening balance ("I don't know" allowed). | SOW §6, §15 | Architectural | MVP | ADR-035, CD-06 | — |
| REQ-CA-22 | Cumulative P&L balances are differenced against the previous balance in the same fiscal year; ledger-basis balance-sheet metrics require an opening balance source or are NULL with a reason. | SOW §7 | Architectural | MVP | ADR-027.2–3 | — |
| REQ-CA-23 | A pair is a cash transfer only when both legs are cash-like accounts; card and loan repayments count in cash outflows under their category. | SOW §7, §15 | Architectural | MVP | ADR-028 | — |
| REQ-CA-24 | Revenue is net of VAT where data allows; VAT-inclusive proxies carry `vat_inclusive` and `estimated`; optional net-down from organization VAT settings. | SOW §7 | Architectural | MVP | ADR-027.4 | CD-33 |
| REQ-CA-25 | `fiscal_periods.is_complete` governs the default period on Home, Reports and the AI; alerts (except record-level rules) and the health score run only on complete periods; `basis_differs` suppresses variance-based rules; the MVP period picker is monthly only. | SOW §8, §13 | Architectural | MVP | ADR-030 | — |
| REQ-CA-26 | Calculation runs coalesce only while queued, mark themselves stale when data changes mid-run and loop until current, include `as_of` in the fingerprint, aggregate in SQL, and record which run included each batch. | SOW §7, §23 | Architectural | MVP | ADR-031 | CD-34 |
| REQ-CA-27 | The current metric value is the row pointed to by `metric_current`; snapshots are append-only; referenced snapshots are never archived. | SOW §7, §12 | Architectural | MVP | ADR-031.5 | — |
| REQ-BH-11 | Health dimension rules that count anomalies derive their counts from conditions over snapshots, never from alert rows; dimensions on estimated data are included capped at 70 with a note. | SOW §9 | Architectural | MVP | ADR-035 | — |
| REQ-AL-13 | State-type alert rules are keyed by subject (one alert per persistent condition); event-type rules by period; a run creates at most 25 alerts. | SOW §13 | Architectural | MVP | ADR-036 | — |
| REQ-AL-14 | Alert re-evaluation writes an `alert_revisions` row and an audit event; a severity increase re-opens an acknowledged alert; evidence pins the revision seen. | SOW §5, §13 | Architectural | MVP | ADR-034 | — |
| REQ-AI-24 | Every number in every part of an AI answer carries a `NumberRef` validated against the exact tool field (value, unit, sign, period); named entities and direction words are grounded; the direct answer, causes, risks, opportunities and recommendations are Statements requiring evidence; the final call is forced to `submit_answer` and text blocks are discarded. | SOW §11 | Architectural | MVP | ADR-032 | — |
| REQ-AI-25 | Degraded answers remove unverified statements and list them under "Not covered"; "Create action" is available only when grounding passed. | SOW §11, §17 | Architectural | MVP | ADR-032.5 | — |
| REQ-AI-26 | Evidence tools accept ids only, never model-authored descriptors; all imported free text reaching the model is wrapped and escaped; conversations are bound to (organization, user); access is re-resolved before every tool call. | SOW §11 | Architectural | MVP | ADR-032.6–8 | — |
| REQ-AI-27 | PDF extraction tokens and pages count against per-organization budgets in `platform_org_settings`; the extraction job has outage-tolerant retries and per-page completion. | SOW §11 | Architectural | MVP | ADR-033, ADR-038.5 | — |
| REQ-EV-12 | Engine evidence descriptors name account ids resolved at run time; category and record-status history tables make as-of resolution reproducible after remaps, recategorisation and rollback; derived metrics point at their component snapshots. | SOW §12 | Architectural | MVP | ADR-034 | — |
| REQ-UX-01 | The header Data menu (Add data · Imports · Documents · Accounts) is shown to roles with `imports.review`; there is no Settings → Data. | Role brief | Architectural | MVP | ADR-037 | — |
| REQ-UX-02 | Home Level 2 shows revenue, gross profit (when applicable), operating profit with net profit visible, cash, receivables and payables; one status badge per number from the canonical table. | SOW §8 | Architectural | MVP | ADR-037 | CD-32 |
| REQ-UX-03 | The import wizard derives its steps per import type, skips answered steps from saved mappings, and renders a zero-issue fast path. | SOW §6 | Architectural | MVP | ADR-037 | — |
| REQ-PO-13 | `/portfolio` and platform organization lists use aggregate projections filtered by the caller's accessible organizations, cached per organization tag. | SOW §18 | Architectural | MVP | ADR-038.13 | — |
| REQ-PO-14 | Jobs have a `cancelled` status; workers defer jobs for suspended or pending-deletion organizations; deletion can be cancelled during the grace period. | SOW §5 | Architectural | MVP | ADR-038.12 | — |

**Amended rows.** REQ-DO-02/REQ-DO-05 now rest on ADR-038.1 (no Storage policies for `authenticated`); REQ-AS-03 now includes `alert.reevaluated`, `document.sent_to_ai`, `job.requeued` and `platform_settings` diffs; REQ-AS-10 covers report downloads; REQ-PO-08 (job queue) is governed by ADR-031 coalescing rules; the "Employee `users.view`" row of the RBAC matrix is now ✗ (ADR-037).

## Glossary

| Term | Definition | Source |
|---|---|---|
| Organization | The tenant: one customer business. | ADR-001 |
| Platform | MOTION itself and its operators. | Role brief |
| Member | A user with an `organization_memberships` row (owner, admin, client). | ADR-002 |
| Employee ("My Employee") | A platform-side user (`platform_employee`) with explicit `organization_assignments`. | Role brief; CD-16 |
| Super Admin | Platform operator with `platform_super_admin`. | Role brief |
| Effective role | The single role a user resolves to inside one organization. | RBAC §1 |
| Permission | A string key such as `imports.create`; the unit of authorization. | ADR-003 |
| AccessContext | Server-side object `{userId, orgId, effectiveRole, permissions, actorType}` passed to every service. | ADR-014 |
| Standard category | One of 26 fixed account classifications every account maps to. | ADR-004 |
| Ledger entry | A transaction-level debit or credit line. | DB §3 |
| Period balance | A summary balance for one account in one month, from TB/P&L/BS imports. | DB §3 |
| Basis | Which source family a metric value was computed from. | ADR-005 |
| Assurance level | Verified / calculated / estimated / inferred — how sure MOTION is about a value. | ADR-016 |
| Record status | Pending / needs_review / accepted / duplicate / rejected / incomplete — lifecycle of a record. | ADR-016 |
| Calculation run | One deterministic execution of the financial engine. | ADR-008 |
| Metric snapshot | One computed metric value for one period (and optional dimension). | ADR-008 |
| Evidence bundle / item | The traceability record behind a metric, alert, score, AI answer or action. | ADR-009 |
| Query descriptor | A JSON description that deterministically re-selects contributing rows. | ADR-009 |
| Grounding check | Verification that every number in an AI answer came from a tool output. | ADR-010 |
| Health Score | Explainable 0–100 indicator across weighted dimensions. | SOW §9 |
| Alert | A rule-generated finding with severity, period, evidence and next step. | SOW §13 |
| Action | An accountable task with issue, recommendation, priority, owner, due date, status, evidence, outcome. | SOW §17 |
| Import batch / row | One import run of one file; each parsed row with its status and issues. | ADR-012 |
| Source document | An uploaded file in Supabase Storage with hash and kind. | DB §5 |
| Dedupe hash | Normalised hash used for record-level duplicate detection. | CD-12 |
| Coverage status | Which periods have bank data, ledger data, both or neither. | CD-20 |
| Feature flag | Per-organization boolean enabling a post-MVP module. | ADR-025 |
| Funding Readiness | Indicative, explainable readiness assessment; not a lending decision. | SOW §19 |
| Contribution margin | Revenue minus variable costs (cost of sales) in MOTION's definition. | FINANCIAL_ENGINE.md |
| Fiscal period | A materialised calendar month row for an organization. | ADR-007 |
| Portfolio | The employee's list of assigned organizations. | MVP_SCOPE §2.1 |
| Job | A queued unit of background work in the `jobs` table. | ADR-020 |
