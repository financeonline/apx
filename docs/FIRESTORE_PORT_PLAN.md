# APX — Port plan: Supabase → Firebase

Companion to `FIRESTORE_DATA_MODEL.md`. Seven area teams port in parallel, each owning the files
listed for it; shared foundations (`src/db/*.ts`, `src/db/app/*`, `src/core/db/*`) are changed only by the lead.

## Teams and the code they own

| Team | Area | Source it owns | Integration tests it ports |
|---|---|---|---|
| T | Tenancy, sign-in and account | modules/tenancy, modules/departments, modules/tax; app/account, app/invite, app/onboarding, app/select-organization, app/_lib, app/auth, app/(public) sign-in/up pages, app/app/[orgSlug]/layout.tsx and settings/team pages, components/auth-form.tsx, components/supabase-browser.ts (replace), src/middleware.ts → src/proxy.ts | member-access, team-logins, tax-settings, departments, session-revocation, single-super-admin, resolution-parity, role-follow-ups, unicode-names, rls-isolation, isolation-cases, org-scope, api-governance, audit-h1-h2-regression |
| P | Platform, portfolio and purge | modules/platform, modules/portfolio; app/platform, app/portfolio | platform-companies-modules, platform-pages, portfolio, portfolio-scale, portfolio-transport, org-purge, ai-api-key, ai-model-setting |
| I | Imports, documents and storage | modules/imports, modules/documents, core/storage; app/app/[orgSlug]/data, app/api/documents, upload routes | import-commit, import-end-to-end, import-wizard, import-wizard-types, document-extract, invoice-reading, receipt-reading, storage-cleanup, report-completeness-attestation, opening-cash-assurance, evidence-documents, step0f-reproductions |
| F | Financials, banking, commercial, marketing, engagement, budgets | modules/financials, modules/banking, modules/commercial, modules/marketing, modules/engagement, modules/budgets; their app/app/[orgSlug] pages (money, customers, marketing …) | banking, commercial, marketing, marketing-financials, engagement, budgets, financial-schema, bank-commercial-population, ledger-commercial-population, money-pages, receivables-recovery |
| E | Engine, jobs, health, forecast, scenarios, funding | modules/jobs, modules/financial-engine, modules/health, modules/forecast, modules/scenarios, modules/funding; app/api/jobs | engine-*, jobs-worker, calculation-coalescing, health-scores, health-v5, forecast, scenarios, funding-readiness, pipeline-end-to-end, fu1-remediation, fu12-remediation, adr123-remediation, adr124-remediation, balance-report-pnl |
| R | Actions, alerts, evidence, reporting, investment, exports, dashboard | modules/actions, modules/alerts, modules/evidence, modules/reporting, modules/investment, modules/exports, modules/dashboard; app/app/[orgSlug]/home and the other dashboard/report pages | actions, alerts-persist, evidence-*, reporting, phase17-reports, report-summary-edition, investment, investment-figures, home-figures, insights |
| A | The AI Analyst | modules/ai; app/api/ai | ai-answer, ai-eval-job, ai-eval-record, ai-feedback-review, ai-gross-profit-availability, ai-model-for, ai-persist-turn, ai-quota-feedback, ai-tools, portfolio-ai |

## Every database function and where it goes

| SQL function | Lines | TypeScript file | Team |
|---|---:|---|---|
| `api.accept_invitation` | 99 | `src/db/api/tenancy.ts` | T |
| `api.accept_ownership_transfer` | 63 | `src/db/api/tenancy.ts` | T |
| `api.access_requests_list` | 27 | `src/db/api/tenancy.ts` | T |
| `api.begin_member_login` | 42 | `src/db/api/tenancy.ts` | T |
| `api.cancel_deletion` | 25 | `src/db/api/tenancy.ts` | T |
| `api.cancel_ownership_transfer` | 30 | `src/db/api/tenancy.ts` | T |
| `api.change_member_role` | 42 | `src/db/api/tenancy.ts` | T |
| `api.create_organization` | 84 | `src/db/api/tenancy.ts` | T |
| `api.decide_access_request` | 83 | `src/db/api/tenancy.ts` | T |
| `api.disable_user` | 28 | `src/db/api/tenancy.ts` | T |
| `api.enable_user` | 13 | `src/db/api/tenancy.ts` | T |
| `api.finish_member_login` | 66 | `src/db/api/tenancy.ts` | T |
| `api.initiate_ownership_transfer` | 37 | `src/db/api/tenancy.ts` | T |
| `api.invite_member` | 11 | `src/db/api/tenancy.ts` | T |
| `api.invite_member_with_token` | 70 | `src/db/api/tenancy.ts` | T |
| `api.leave_organization` | 22 | `src/db/api/tenancy.ts` | T |
| `api.my_access` | 32 | `src/db/api/tenancy.ts` | T |
| `api.my_context` | 17 | `src/db/api/tenancy.ts` | T |
| `api.my_organizations` | 11 | `src/db/api/tenancy.ts` | T |
| `api.my_platform_role` | 10 | `src/db/api/tenancy.ts` | T |
| `api.my_profile` | 16 | `src/db/api/tenancy.ts` | T |
| `api.org_advisers` | 15 | `src/db/api/tenancy.ts` | T |
| `api.org_audit_events` | 17 | `src/db/api/tenancy.ts` | T |
| `api.org_invitations` | 14 | `src/db/api/tenancy.ts` | T |
| `api.org_member_departments` | 13 | `src/db/api/tenancy.ts` | T |
| `api.org_member_permissions` | 21 | `src/db/api/tenancy.ts` | T |
| `api.org_members` | 15 | `src/db/api/tenancy.ts` | T |
| `api.remove_member` | 32 | `src/db/api/tenancy.ts` | T |
| `api.request_access` | 70 | `src/db/api/tenancy.ts` | T |
| `api.request_deletion` | 22 | `src/db/api/tenancy.ts` | T |
| `api.revoke_invitation` | 22 | `src/db/api/tenancy.ts` | T |
| `api.set_last_active_org` | 12 | `src/db/api/tenancy.ts` | T |
| `api.set_member_departments` | 58 | `src/db/api/tenancy.ts` | T |
| `api.set_member_permission` | 16 | `src/db/api/tenancy.ts` | T |
| `api.set_member_status` | 27 | `src/db/api/tenancy.ts` | T |
| `api.set_tax_settings` | 49 | `src/db/api/tenancy.ts` | T |
| `api.set_vat_registration` | 44 | `src/db/api/tenancy.ts` | T |
| `api.set_currency_and_country` | 49 | `src/db/api/tenancy.ts` | T |
| `api.update_organization` | 89 | `src/db/api/tenancy.ts` | T |
| `api.update_profile` | 45 | `src/db/api/tenancy.ts` | T |
| `api.withdraw_access_request` | 33 | `src/db/api/tenancy.ts` | T |
| `api.grant_platform_role` | 30 | `src/db/api/platform.ts` | P |
| `api.revoke_platform_role` | 22 | `src/db/api/platform.ts` | P |
| `api.platform_audit_events` | 36 | `src/db/api/platform.ts` | P |
| `api.platform_company_owners` | 15 | `src/db/api/platform.ts` | P |
| `api.platform_create_organization` | 65 | `src/db/api/platform.ts` | P |
| `api.platform_owner_login_change` | 51 | `src/db/api/platform.ts` | P |
| `api.platform_purge_now` | 40 | `src/db/api/platform.ts` | P |
| `api.platform_set_company_owner` | 41 | `src/db/api/platform.ts` | P |
| `api.platform_users_list` | 14 | `src/db/api/platform.ts` | P |
| `api.create_assignment` | 32 | `src/db/api/platform.ts` | P |
| `api.revoke_assignment` | 50 | `src/db/api/platform.ts` | P |
| `api.update_platform_org_settings` | 33 | `src/db/api/platform.ts` | P |
| `api.update_platform_settings` | 18 | `src/db/api/platform.ts` | P |
| `api.set_org_module` | 40 | `src/db/api/platform.ts` | P |
| `api.set_ai_active_provider` | 36 | `src/db/api/platform.ts` | P |
| `api.set_ai_api_key` | 30 | `src/db/api/platform.ts` | P |
| `api.set_ai_model` | 47 | `src/db/api/platform.ts` | P |
| `api.set_openai_api_key` | 30 | `src/db/api/platform.ts` | P |
| `api.clear_ai_api_key` | 20 | `src/db/api/platform.ts` | P |
| `api.clear_openai_api_key` | 23 | `src/db/api/platform.ts` | P |
| `api.ai_api_key_status` | 16 | `src/db/api/platform.ts` | P |
| `api.openai_api_key_status` | 15 | `src/db/api/platform.ts` | P |
| `api.requeue_job` | 33 | `src/db/api/platform.ts` | P |
| `api.cancel_job` | 35 | `src/db/api/platform.ts` | P |
| `api.portfolio_finished_actions` | 15 | `src/db/api/portfolio.ts` | P |
| `api.portfolio_health_breakdowns` | 38 | `src/db/api/portfolio.ts` | P |
| `api.portfolio_open_actions` | 22 | `src/db/api/portfolio.ts` | P |
| `api.portfolio_recent_alerts` | 17 | `src/db/api/portfolio.ts` | P |
| `api.portfolio_standing_alerts` | 16 | `src/db/api/portfolio.ts` | P |
| `api.portfolio_summary` | 60 | `src/db/api/portfolio.ts` | P |
| `api.attest_report_completeness` | 112 | `src/db/api/imports.ts` | I |
| `api.commit_import_batch` | 18 | `src/db/api/imports.ts` | I |
| `api.confirm_pdf_page` | 31 | `src/db/api/imports.ts` | I |
| `api.create_import_accounts` | 59 | `src/db/api/imports.ts` | I |
| `api.create_import_counterparties` | 87 | `src/db/api/imports.ts` | I |
| `api.decide_import_rows` | 48 | `src/db/api/imports.ts` | I |
| `api.delete_document` | 36 | `src/db/api/imports.ts` | I |
| `api.record_batch_confirmation` | 89 | `src/db/api/imports.ts` | I |
| `api.reject_import_batch` | 30 | `src/db/api/imports.ts` | I |
| `api.replace_import_batch` | 63 | `src/db/api/imports.ts` | I |
| `api.rollback_import_batch` | 21 | `src/db/api/imports.ts` | I |
| `api.save_import_mapping` | 54 | `src/db/api/imports.ts` | I |
| `api.set_statement_balances` | 30 | `src/db/api/imports.ts` | I |
| `api.start_import_batch` | 74 | `src/db/api/imports.ts` | I |
| `api.create_bank_account` | 36 | `src/db/api/financials.ts` | F |
| `api.merge_counterparties` | 37 | `src/db/api/financials.ts` | F |
| `api.remap_account` | 55 | `src/db/api/financials.ts` | F |
| `api.set_account_loan_security` | 44 | `src/db/api/financials.ts` | F |
| `api.set_opening_balance` | 32 | `src/db/api/financials.ts` | F |
| `api.set_opening_balance_flag` | 28 | `src/db/api/financials.ts` | F |
| `api.supersede_record` | 31 | `src/db/api/financials.ts` | F |
| `api.update_counterparty` | 40 | `src/db/api/financials.ts` | F |
| `api.mark_transfer` | 75 | `src/db/api/banking.ts` | F |
| `api.override_bank_category` | 36 | `src/db/api/banking.ts` | F |
| `api.bank_period_summary` | 108 | `src/db/api/banking.ts` | F |
| `api.product_period_summary` | 72 | `src/db/api/commercial.ts` | F |
| `api.set_campaign_spend` | 26 | `src/db/api/commercial.ts` | F |
| `api.set_invoice_lines` | 52 | `src/db/api/commercial.ts` | F |
| `api.upsert_campaign` | 43 | `src/db/api/commercial.ts` | F |
| `api.upsert_channel` | 29 | `src/db/api/commercial.ts` | F |
| `api.upsert_opportunity` | 75 | `src/db/api/commercial.ts` | F |
| `api.upsert_product` | 35 | `src/db/api/commercial.ts` | F |
| `api.set_company_profile` | 81 | `src/db/api/marketing.ts` | F |
| `api.request_marketing_report` | 69 | `src/db/api/marketing.ts` | F |
| `api.add_action_comment` | 37 | `src/db/api/engagement.ts` | F |
| `api.comment_engagement_item` | 28 | `src/db/api/engagement.ts` | F |
| `api.create_engagement_item` | 42 | `src/db/api/engagement.ts` | F |
| `api.update_engagement_status` | 46 | `src/db/api/engagement.ts` | F |
| `api.mark_notifications_read` | 16 | `src/db/api/engagement.ts` | F |
| `api.action_assignees` | 15 | `src/db/api/actions.ts` | R |
| `api.assign_action` | 34 | `src/db/api/actions.ts` | R |
| `api.create_action` | 52 | `src/db/api/actions.ts` | R |
| `api.create_action_from_alert` | 88 | `src/db/api/actions.ts` | R |
| `api.create_action_from_recommendation` | 67 | `src/db/api/actions.ts` | R |
| `api.set_action_status` | 34 | `src/db/api/actions.ts` | R |
| `api.update_action` | 38 | `src/db/api/actions.ts` | R |
| `api.update_own_action` | 32 | `src/db/api/actions.ts` | R |
| `api.set_alert_status` | 41 | `src/db/api/alerts.ts` | R |
| `api.request_investment_report` | 84 | `src/db/api/investment.ts` | R |
| `api.archive_scenario` | 26 | `src/db/api/scenarios.ts` | E |
| `api.ai_quota_status` | 40 | `src/db/api/ai.ts` | A |
| `api.archive_conversation` | 24 | `src/db/api/ai.ts` | A |
| `api.create_conversation` | 16 | `src/db/api/ai.ts` | A |
| `api.review_ai_feedback` | 43 | `src/db/api/ai.ts` | A |
| `api.submit_ai_feedback` | 31 | `src/db/api/ai.ts` | A |
| `api.enqueue_job` | 112 | `src/db/api/jobs.ts` | E |
| `api.is_recalculating` | 14 | `src/db/api/jobs.ts` | E |
| `api.has_accepted_records` | 17 | `src/db/api/jobs.ts` | E |
| `api_server.record_access_event` | 106 | `src/db/api_server/access.ts` | T |
| `api_server.throttle` | 14 | `src/db/api_server/access.ts` | T |
| `api_server.prune_rate_limits` | 19 | `src/db/api_server/access.ts` | T |
| `api_server.revoke_user_sessions` | 19 | `src/db/api_server/access.ts` | T |
| `api_server.aggregate_periods` | 12 | `src/db/api_server/engine.ts` | E |
| `api_server.aggregate_transfer_legs` | 12 | `src/db/api_server/engine.ts` | E |
| `api_server.aggregation_instant` | 14 | `src/db/api_server/engine.ts` | E |
| `api_server.bank_daily_movements` | 12 | `src/db/api_server/engine.ts` | E |
| `api_server.batch_coverage` | 12 | `src/db/api_server/engine.ts` | E |
| `api_server.build_metric_bundle_as` | 155 | `src/db/api_server/engine.ts` | E |
| `api_server.start_calculation_run` | 54 | `src/db/api_server/engine.ts` | E |
| `api_server.finish_calculation_run` | 87 | `src/db/api_server/engine.ts` | E |
| `api_server.finish_chunk` | 102 | `src/db/api_server/engine.ts` | E |
| `api_server.set_period_completeness` | 33 | `src/db/api_server/engine.ts` | E |
| `api_server.apply_banking_pass` | 198 | `src/db/api_server/engine.ts` | E |
| `api_server.finish_health` | 109 | `src/db/api_server/engine.ts` | E |
| `api_server.finish_forecast` | 107 | `src/db/api_server/engine.ts` | E |
| `api_server.finish_scenario` | 103 | `src/db/api_server/engine.ts` | E |
| `api_server.finish_funding` | 74 | `src/db/api_server/engine.ts` | E |
| `api_server.enqueue_funding_backstop` | 35 | `src/db/api_server/engine.ts` | E |
| `api_server.enqueue_job` | 50 | `src/db/api_server/jobs.ts` | E |
| `api_server.claim_job` | 51 | `src/db/api_server/jobs.ts` | E |
| `api_server.finish_job` | 70 | `src/db/api_server/jobs.ts` | E |
| `api_server.enqueue_engine_upgrade` | 48 | `src/db/api_server/jobs.ts` | E |
| `api_server.enqueue_health_upgrade` | 37 | `src/db/api_server/jobs.ts` | E |
| `api_server.enqueue_scheduled_recalculation` | 66 | `src/db/api_server/jobs.ts` | E |
| `api_server.enqueue_nightly_sweep` | 34 | `src/db/api_server/jobs.ts` | E |
| `api_server.begin_extraction` | 50 | `src/db/api_server/imports.ts` | I |
| `api_server.begin_receipt_extraction` | 63 | `src/db/api_server/imports.ts` | I |
| `api_server.charge_extraction_page` | 31 | `src/db/api_server/imports.ts` | I |
| `api_server.record_extraction_page` | 56 | `src/db/api_server/imports.ts` | I |
| `api_server.register_document` | 65 | `src/db/api_server/imports.ts` | I |
| `api_server.finalize_upload` | 40 | `src/db/api_server/imports.ts` | I |
| `api_server.write_import_rows` | 53 | `src/db/api_server/imports.ts` | I |
| `api_server.set_batch_validation` | 39 | `src/db/api_server/imports.ts` | I |
| `api_server.fail_import_batch` | 24 | `src/db/api_server/imports.ts` | I |
| `api_server.commit_batch_as` | 23 | `src/db/api_server/imports.ts` | I |
| `api_server.record_storage_cleanup` | 44 | `src/db/api_server/imports.ts` | I |
| `api_server.ai_create_conversation` | 23 | `src/db/api_server/ai.ts` | A |
| `api_server.ai_persist_turn` | 205 | `src/db/api_server/ai.ts` | A |
| `api_server.portfolio_ai_begin_turn` | 37 | `src/db/api_server/ai.ts` | A |
| `api_server.portfolio_ai_finish_turn` | 23 | `src/db/api_server/ai.ts` | A |
| `api_server.anthropic_api_key` | 8 | `src/db/api_server/ai.ts` | A |
| `api_server.openai_api_key` | 8 | `src/db/api_server/ai.ts` | A |
| `api_server.ai_model` | 14 | `src/db/api_server/ai.ts` | A |
| `api_server.ai_model_for` | 19 | `src/db/api_server/ai.ts` | A |
| `api_server.record_report` | 46 | `src/db/api_server/reporting.ts` | R |
| `api_server.record_report_file` | 41 | `src/db/api_server/reporting.ts` | R |
| `api_server.record_report_pdf` | 33 | `src/db/api_server/reporting.ts` | R |
| `api_server.enqueue_scheduled_reports` | 69 | `src/db/api_server/reporting.ts` | R |
| `api_server.start_investment_report` | 33 | `src/db/api_server/reporting.ts` | R |
| `api_server.finish_investment_report` | 45 | `src/db/api_server/reporting.ts` | R |
| `api_server.fail_investment_report` | 37 | `src/db/api_server/reporting.ts` | R |
| `api_server.persist_alerts` | 198 | `src/db/api_server/reporting.ts` | R |
| `api_server.start_marketing_report` | 33 | `src/db/api_server/marketing.ts` | F |
| `api_server.finish_marketing_report` | 45 | `src/db/api_server/marketing.ts` | F |
| `api_server.fail_marketing_report` | 37 | `src/db/api_server/marketing.ts` | F |
| `api_server.purge_organization` | 156 | `src/db/api_server/purge.ts` | P |

`app.*` helpers and triggers go with the function that uses them (shared ones are in `src/db/app/`).
