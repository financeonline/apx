MOTION
STATEMENT OF WORK
Financial Intelligence System — Version 2.0
AI Financial Analyst • Financial Intelligence • Banking • Commercial Intelligence • Funding Readiness
| Document Item | Details |
| Project | MOTION — Financial Intelligence System |
| Document | Statement of Work (SOW) |
| Version | 2.0 |
| Status | Developer / Implementation Scope |
| Primary Backend | Supabase / PostgreSQL |
| Primary Application | Next.js / TypeScript |
| AI Layer | Claude API through a secure server-side abstraction |

CONFIDENTIAL — MOTION PROPRIETARY INFORMATION
# 1. Project Overview
MOTION is a financial intelligence platform designed to transform business financial, banking, commercial and operational data into actionable management intelligence. The system is intended to sit above existing accounting and business systems, rather than replace every specialist system.
The platform will collect and validate business data, perform deterministic financial calculations, identify trends and anomalies, explain business performance through an AI Financial Analyst, recommend actions and provide evidence that allows management to verify material conclusions.
# 2. Product Objective
The system shall answer five core management questions:
- What is happening in the business?
- Why is it happening?
- Where is value being created or lost?
- What requires attention?
- What should management do next?
Core product principle:
DATA → VALIDATION → CALCULATION → INTELLIGENCE → AI ANALYSIS → RECOMMENDATION → ACTION → OUTCOME
# 3. Scope of Work
The development scope includes the following major modules:
| Module | Scope |
| Executive Intelligence Dashboard | Business overview, KPIs, trends, risks, opportunities, actions and drill-down. |
| Data Capture & Import Engine | CSV, XLSX and PDF upload, validation, mapping, duplicate detection and traceability. |
| Financial Data Engine | Accounting, revenue, expenses, customers, suppliers, invoices, payments and source data. |
| Financial Calculation Engine | Deterministic calculations for revenue, profit, margin, cash, working capital and variances. |
| Business Health Score | Explainable 0–100 score across financial and business dimensions. |
| Banking Intelligence | Bank accounts, transactions, cash movement, recurring payments, anomalies and reconciliation. |
| AI Financial Analyst | Natural-language financial questions, diagnosis, explanation, recommendations and evidence. |
| Alerts & Anomaly Detection | Rules-based identification of material financial and banking changes. |
| Forecasting | Revenue, cost, profit, cash, receivables and payables forecasts. |
| What-If Scenarios | User-defined assumptions and baseline-vs-scenario analysis. |
| Team management System | Management and engagement platform between teams and client. |
| Commercial Intelligence (CRM) | CRM, customers, sales, products/services, campaigns and commercial profitability. |
| Action Centre | Turn insights into assigned, trackable management actions. |
| Accountant/CFO Command Centre | Multi-client portfolio monitoring and advisory intelligence. |
| Marketing Analysis | Anaylse, monitor and report on marketing performance of current activities and spend. Review Market opportunities and advise on optimal measures to improve on the current marketing strategy. |
| Funding Readiness | Indicative, explainable readiness assessment; not a lending decision. |
| Intelligent Reporting | Daily, weekly, monthly, adviser and funding-readiness reports. |
| Partner Ecosystem | Future integrations with advisers, lenders, banking/data and specialist providers. |
| Social Responsibility / ESG | Later-stage optional module; not a dependency for the financial MVP. |
| Investment Opportunities | Create available opportunities and create a pitch deck for recommendations of investment or growth opportunities. |

# 4. Technology & Architecture
| Area | Required Direction |
| Frontend | Next.js, TypeScript, Tailwind CSS and shadcn/ui. |
| Backend | Next.js server-side services/API routes and Supabase. |
| Database | Supabase PostgreSQL. |
| Authentication | Supabase Auth. |
| File Storage | Supabase Storage. |
| Security | Row Level Security, role-based access control and tenant isolation. |
| Charts | Recharts or equivalent suitable charting library. |
| AI | Claude API through a server-side service abstraction. |
| Architecture | Modular services separating UI, data access, calculations, intelligence and AI. |

# 5. Multi-Tenant Architecture & Security
The application shall be designed as a multi-tenant SaaS platform. Company/entity isolation is mandatory.
- Users must only access companies/entities for which they have explicit permission.
- Supabase Row Level Security shall enforce tenant isolation at the database layer.
- Roles and permissions shall be enforced server-side as well as in the user interface.
- API keys and sensitive credentials shall never be exposed to the browser.
- Source documents shall be access-controlled.
- Important data changes and material system-generated events shall be auditable.
- File uploads shall be validated and safely stored.
- The application shall prevent cross-company data leakage.
# 6. Financial Data & Import
The system shall support initial ingestion of:
- CSV files
- XLSX spreadsheets
- PDF bank statements and financial documents
- Invoices and receipts
- Trial balances
- General ledgers
- P&L and balance sheet reports
- Sales and purchase reports
Imported records shall preserve source traceability, including source file, import batch and source reference/page where available.
Data statuses shall include, where applicable:
- Verified
- Calculated
- Estimated
- Inferred
- Incomplete
- Needs Review
- Duplicate
- Rejected
# 7. Financial Calculation Engine
Financial calculations shall be deterministic, testable and independent of the language model. The LLM shall not be the authoritative calculator.
- Revenue and revenue growth
- Gross profit and gross margin
- Operating expenses and operating profit
- Net profit and net margin
- Cash inflows, outflows and net cash movement
- Opening and closing cash
- Receivables and payables
- Working capital
- Contribution margin
- Customer/product/service contribution where data supports it
- Revenue, cost and customer concentration
- Period-over-period variance
- Budget/forecast variance where applicable
# 8. Executive Intelligence Dashboard
The dashboard shall prioritise decisions rather than display an unstructured collection of KPIs.
- Business Health Score
- Revenue, gross profit, operating profit and net profit
- Cash position and liquidity indicators
- Revenue, profit and cash trends
- Major expense movements
- Receivables and payables
- Top risks
- Top opportunities
- Outstanding management actions
- Data quality and refresh status
Progressive drill-down shall support: Dashboard → Analysis → Account/Customer/Category → Transaction → Source Document.
# 9. Business Health Score
MOTION shall provide an explainable 0–100 Business Health Score. The score is an analytical indicator and shall not be represented as a lending decision or guarantee.
| Dimension | Indicative Inputs |
| Profitability | Margins, profit trend, contribution. |
| Cash Flow | Cash movement, liquidity pressure, cash trend. |
| Revenue Growth | Growth, recurring revenue, volatility and concentration. |
| Cost Control | Cost/revenue ratios, variance and unusual expenditure. |
| Customer Quality | Customer contribution, concentration and retention where available. |
| Marketing Efficiency | CAC, revenue/contribution per acquisition where available. |
| Banking Health | Balance trends, inflow/outflow behaviour and transaction anomalies. |
| Funding Readiness | Indicative financial and banking readiness factors. |

Each dimension shall expose the underlying metrics, rules, positive factors, negative factors and data-quality status.
# 10. AI Financial Analyst
The AI Financial Analyst is a core product capability. It shall not operate as a generic chatbot. It shall interpret validated financial calculations and structured evidence.
Supported question categories include:
- Why did profit increase or decrease?
- Why is cash falling?
- Which expenses increased the most?
- Which customers are most profitable?
- Where is the business losing money?
- Which products/services have the strongest contribution?
- What changed this month?
- What risks require attention?
- What should management focus on?
- Can the business afford a proposed expenditure?
- What happens if revenue or costs change?
Standard AI response structure:
- Direct answer
- Key findings
- Causes/drivers
- Risks
- Opportunities
- Recommended actions
- Confidence/data-quality notes
- Evidence and source trail
# 11. AI Governance & Accuracy
- The AI shall never invent financial figures, transactions or source records.
- The AI shall not present estimates as verified facts.
- The AI shall distinguish facts, calculations, estimates, inferences and recommendations.
- The AI shall not bypass user permissions or company isolation.
- Material financial figures shall originate from deterministic calculation services.
- Material AI conclusions shall be traceable to evidence.
- AI prompts and outputs shall be designed to resist prompt-injection attempts and data leakage.
- The system shall provide a mechanism to report incorrect insights.
# 12. Evidence & Traceability
Material conclusions shall be inspectable through an evidence layer.
- Financial metric
- Calculation
- Transaction
- Invoice
- Bank transaction
- Customer
- Supplier
- Source document
- Accounting period
A user should be able to move from an AI statement to the calculation and then to the underlying records/source document.
# 13. Alerts & Anomaly Detection
The rules-based engine shall identify material changes such as:
- Unusual expense increases
- Unusual bank transactions
- Revenue decline
- Margin deterioration
- Cash deterioration
- Receivables/payables deterioration
- Customer or supplier concentration
- Unusual recurring payments
- Duplicate transactions
- Large transaction deviations
- Significant period variance
Each alert shall contain severity, explanation, affected metric, period, evidence and recommended next step.
# 14. Forecasting & What-If Analysis
Forecasting shall support revenue, expenses, operating profit, cash, receivables and payables where sufficient data exists.
Scenario analysis shall support changes such as:
- Revenue increases/decreases
- Payroll changes
- Supplier cost changes
- Marketing spend changes
- Hiring
- Pricing changes
- Debt and repayment assumptions
Outputs shall show BASELINE versus SCENARIO and clearly expose assumptions.
# 15. Banking Intelligence
- Bank account overview
- Balances and cash trends
- Inflows and outflows
- Transaction categorisation
- Recurring payments
- Unusual transaction detection
- Liquidity indicators
- Reconciliation status
- Bank transaction drill-down to source data
Live bank connectivity shall be implemented only through supported secure integrations; the system shall not claim live connectivity where none exists.
# 16. Commercial Intelligence
Commercial intelligence shall connect commercial activity with financial outcomes.
Core chain:
Traffic → Lead → Opportunity → Customer → Revenue → Cost → Contribution
- CRM and customer records
- Sales pipeline
- Products/services
- Marketing campaigns
- Marketing channels
- Customer profitability
- Campaign profitability
- Acquisition cost
- Conversion
- Customer concentration
- Sales performance
# 17. Action Centre
The Action Centre shall convert intelligence into accountable execution.
| Field | Requirement |
| Issue | Problem or opportunity that triggered the action. |
| Recommendation | AI or user-defined recommendation. |
| Priority | Critical / High / Medium / Low. |
| Owner | Assigned person/team. |
| Due Date | Target completion date. |
| Status | Open / In Progress / Completed / Dismissed. |
| Evidence | Linked analysis/source evidence. |
| Outcome | Result/value after completion, where applicable. |

# 18. Accountant / CFO Command Centre
An authorised adviser shall be able to monitor multiple client companies.
- Client portfolio dashboard
- Client health scores
- Clients requiring attention
- Client alerts
- Client AI analysis
- Client reports
- Outstanding actions
- Advisory opportunities
Client isolation and explicit assignment permissions are mandatory.
# 19. Funding Readiness
MOTION shall provide an indicative Funding Readiness Assessment based on available financial, banking and business information. It shall not constitute a lending decision, approval or guarantee.
- Revenue and profitability
- Cash flow
- Banking behaviour
- Existing debt
- Receivables and payables
- Financial consistency
- Data completeness
The output shall show readiness score, positive factors, negative factors, missing information, improvement actions and evidence.
# 20. Reporting
| Report | Purpose |
| Daily Executive Brief | Key movements, risks, opportunities and actions. |
| Weekly Intelligence Report | Financial changes, causes and unresolved issues. |
| Monthly Management Report | Financial, cash, commercial and management analysis. |
| Accountant/CFO Report | Adviser-ready client intelligence. |
| Funding Readiness Report | Indicative readiness assessment and evidence. |
| Custom AI Report | User-selected period, questions and analytical dimensions. |

# 21. Development Phases & Deliverables
| Phase | Deliverables |
| 1 — Foundation | Next.js/TypeScript foundation, Supabase, authentication, company/workspace model, roles and RLS. |
| 2 — Data Architecture | Financial, banking, sales, purchase, document and classification schemas. |
| 3 — Import Engine | CSV/XLSX/PDF ingestion, validation, mapping, duplicate detection and source traceability. |
| 4 — Calculation Engine | Deterministic financial metrics and automated tests. |
| 5 — Executive Dashboard | Business dashboard, KPIs, trends, risks, opportunities and drill-down. |
| 6 — Health Score | Explainable 0–100 business health engine and UI. |
| 7 — Alerts | Rules-based anomalies, alerts and alert management. |
| 8 — AI Analyst | Secure AI analyst, financial Q&A, evidence and recommendations. |
| 9 — Evidence | Evidence model and source/calculation traceability. |
| 10 — Action Centre | Recommendations, assignment, tracking and outcomes. |
| 11 — Forecasting | Forecast engine and actual-vs-forecast views. |
| 12 — Scenarios | What-if scenario engine and saved scenarios. |
| 13 — Banking | Banking intelligence and reconciliation. |
| 14 — Commercial | CRM, marketing, customer/product profitability. |
| 15 — Adviser Platform | Accountant/CFO multi-client command centre. |
| 16 — Funding | Indicative funding-readiness assessment. |
| 17 — Reporting | Executive, management, adviser and funding reports. |
| 18 — Security/QA | Security audit, AI evaluation, performance and production readiness. |

# 22. MVP Definition
The recommended MVP shall prioritise the following end-to-end journey:
Upload Data → Validate → Calculate → Dashboard → Health Score → Alerts → AI Analyst → Evidence → Action
The following should be treated as post-MVP expansion unless otherwise agreed:
- Large-scale third-party integrations
- Lender marketplace/matching
- Full CRM replacement
- Advanced attribution
- Partner ecosystem
- Social Responsibility/ESG
# 23. Acceptance Criteria
- A new company can be created and securely isolated.
- Users can authenticate and receive role-appropriate access.
- Supported financial files can be uploaded and validated.
- Invalid and duplicate data is surfaced rather than silently discarded.
- Financial metrics are calculated deterministically.
- Dashboard figures originate from application data/calculation services.
- Health Score is explainable.
- Alerts contain evidence and severity.
- AI Financial Analyst answers supported financial questions using validated data.
- AI does not invent financial figures or access unauthorised company data.
- Material AI conclusions have evidence/source traceability.
- Users can convert recommendations into actions.
- Critical/high security issues are resolved before production release.
- Type checking, linting, automated tests and production build complete successfully.
# 24. Testing & Quality Assurance
Testing shall cover:
- Unit tests for financial calculations
- Database constraints
- RLS and tenant isolation
- Import parsing and validation
- API/service validation
- AI behaviour and failure cases
- Evidence mapping
- Critical user journeys
- Responsive UI
- Security checks
# 25. Client / Developer Responsibilities
Client responsibilities may include:
- Provide approved product requirements and branding assets.
- Provide access to required third-party accounts/integrations.
- Provide sample business data for testing where legally permitted.
- Review and approve milestone deliverables.
- Provide timely feedback and clarification.
Developer responsibilities include:
- Implement the agreed technical architecture and functionality.
- Maintain code quality and documentation.
- Implement appropriate testing.
- Protect credentials and tenant data.
- Document configuration and deployment requirements.
- Report blockers and technical risks promptly.
# 26. Exclusions / Limitations
- MOTION does not itself constitute accounting, audit, tax, legal, investment or lending advice.
- Funding readiness is indicative and does not guarantee funding.
- External data-provider availability, API limits, pricing and third-party terms are outside the application's control.
- Data quality and accuracy depend partly on the source information supplied by users or third-party systems.
- Advanced integrations not specifically agreed shall be treated as future scope.
# 27. Intellectual Property & Confidentiality
The parties shall follow the applicable development agreement, NDA and intellectual-property provisions. Subject to those agreements and applicable law, the intended Motion-owned assets include the application source code, architecture, database structures, workflows, analytical matrices, scoring approaches, dashboards, UI concepts, algorithms and related development assets. Client and third-party source data remains subject to its applicable ownership and rights.
Final contractual ownership, licensing, confidentiality, data processing, regulatory and liability terms should be confirmed in the executed agreement.
# 28. Change Control
Any material feature, integration, workflow, report, external service or requirement not included in this SOW may be handled through written change control, including its impact on cost, timeline and dependencies.
# 29. Commercial Product Strategy
- Direct SaaS subscriptions for businesses.
- Professional plans for accountants and CFO advisers.
- Enterprise plans for larger groups.
- Potential compliant partner/referral revenue from funding and specialist services.
- Future ecosystem/API opportunities.
A strong initial distribution strategy is to work with accountants, CFO advisers and business advisers, where one professional relationship can introduce the platform to multiple businesses.
# 30. Acknowledgement & Signatures
By signing below, each party confirms that they have received and reviewed this document, understand its confidential nature, acknowledge Motion’s intellectual property position set out above, and agree to comply with the confidentiality and permitted-use obligations contained in this document.
| Motion (Party-1) | Party 2 | Party 3 |
| Company / Organisation | Company / Organisation | Company / Organisation |
| Full Name /  / …………………… | Full Name /  / …………………… | Full Name /  / …………………… |
| Position / Title /  / …………………… | Position / Title /  / …………………… | Position / Title /  / …………………… |
| Signature /  /  / …………………… | Signature /  /  / …………………… | Signature /  /  / …………………… |
| Date /  / …………………… | Date /  / …………………… | Date /  / …………………… |
| Acknowledged & Agreed / ☐ Yes | Acknowledged & Agreed / ☐ Yes | Acknowledged & Agreed / ☐ Yes |

| CONFIDENTIAL — MOTION PROPRIETARY INFORMATION / MOTION Financial Intelligence System — Statement of Work — Version 2.0 |

