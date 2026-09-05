-- MOTION — Phase 2 (plan Phase 4) · Enums for the financial, banking, import and intelligence schema.
-- Contract: DATABASE_ARCHITECTURE.md §10 (enum summary). Every value below is copied from that table;
-- nothing is added, renamed or reordered. Where a value set is shared by several tables the enum is
-- declared once (ADR-047.12 makes that explicit for transfer_kind_enum, which was previously drifting
-- between bank_transactions, category_history and the engine).

-- The 26 standard categories (ADR-004). `payroll` and `marketing` are sub-types of operating expense
-- kept distinct because the SOW scenarios and the health dimensions need them; the engine folds them
-- into operating expenses in totals.
create type public.standard_category_enum as enum (
  'revenue', 'other_income', 'cost_of_sales', 'operating_expense', 'payroll', 'marketing',
  'interest_expense', 'tax_expense', 'depreciation', 'other_expense',
  'cash', 'receivables', 'inventory', 'other_current_asset', 'fixed_asset', 'other_asset',
  'payables', 'credit_card', 'loan', 'tax_liability', 'other_current_liability',
  'long_term_liability', 'equity', 'drawings', 'transfer', 'uncategorised'
);

create type public.account_type_enum as enum ('asset', 'liability', 'equity', 'income', 'expense');

create type public.record_status_enum as enum
  ('pending', 'needs_review', 'accepted', 'duplicate', 'rejected', 'incomplete');

create type public.assurance_level_enum as enum ('verified', 'calculated', 'estimated', 'inferred');

-- `sales_report`/`purchase_report` target `invoices` (SOW §6).
create type public.import_type_enum as enum (
  'general_ledger', 'trial_balance', 'pnl_report', 'balance_sheet', 'bank_statement',
  'sales_invoices', 'purchase_invoices', 'sales_report', 'purchase_report', 'receipts'
);

create type public.import_target_enum as enum
  ('ledger_entries', 'period_balances', 'bank_transactions', 'invoices');

create type public.import_batch_status_enum as enum (
  'created', 'parsing', 'mapping', 'validating', 'awaiting_review', 'committing',
  'committed', 'rolled_back', 'rejected', 'failed'
);

create type public.import_row_status_enum as enum
  ('pending', 'valid', 'warning', 'error', 'duplicate', 'skipped', 'committed', 'rejected');

create type public.reviewer_decision_enum as enum ('none', 'keep', 'skip', 'fixed');

create type public.extraction_method_enum as enum ('csv', 'xlsx', 'pdf_text', 'pdf_claude', 'manual');

create type public.document_kind_enum as enum (
  'bank_statement', 'general_ledger', 'trial_balance', 'pnl_report', 'balance_sheet',
  'sales_report', 'purchase_report', 'invoice', 'receipt', 'other', 'unknown'
);

create type public.document_status_enum as enum
  ('uploaded', 'scanning', 'ready', 'unreadable', 'quarantined', 'deleted');

create type public.entry_direction_enum as enum ('debit', 'credit');

create type public.balance_kind_enum as enum ('trial_balance', 'pnl_report', 'balance_sheet');

-- ADR-027.2: how a period_balances figure should be read. Copied onto every row from the batch.
create type public.balance_basis_enum as enum ('cumulative', 'movement');

-- ADR-047.3: whether a single signed amount column is in natural (debit-positive) or reporting sign.
create type public.balance_sign_enum as enum ('natural', 'reporting');

-- ADR-047.10: an invoice export listing every invoice, or only the open items.
create type public.invoice_list_kind_enum as enum ('full', 'open_items');

create type public.invoice_type_enum as enum
  ('sales', 'purchase', 'sales_credit_note', 'purchase_credit_note');

create type public.invoice_status_enum as enum ('open', 'partially_paid', 'paid', 'void');

create type public.counterparty_kind_enum as enum ('customer', 'supplier', 'both', 'unknown');

create type public.bank_account_type_enum as enum ('current', 'savings', 'credit_card', 'loan', 'other');

create type public.category_source_enum as enum ('rule', 'user', 'ai_suggested', 'none');

-- ADR-047.12: ONE transfer enum, used by bank_transactions, category_history and the engine.
-- Only `cash_transfer` pairs are excluded from cash metrics (ADR-028).
create type public.transfer_kind_enum as enum (
  'none', 'cash_transfer', 'card_repayment', 'loan_repayment', 'loan_drawdown', 'other_transfer'
);

create type public.recurring_direction_enum as enum ('inflow', 'outflow');

create type public.recurring_cadence_enum as enum
  ('weekly', 'fortnightly', 'monthly', 'quarterly', 'annual', 'irregular');

create type public.recurring_status_enum as enum ('active', 'stopped', 'changed');

create type public.calculation_trigger_enum as enum (
  'import_commit', 'import_rollback', 'recalc_manual', 'scheduled', 'account_remapped',
  'settings_changed', 'banking_edit', 'record_superseded', 'counterparty_merged'
);

-- ADR-047.7 adds `superseded`: a chunked run whose boundary pointer moved on beneath it.
create type public.calculation_status_enum as enum ('queued', 'running', 'succeeded', 'failed', 'superseded');

create type public.calculation_failure_enum as enum ('error', 'worker_lost', 'superseded');

create type public.metric_basis_enum as enum
  ('period_balances', 'ledger', 'invoices', 'bank', 'mixed', 'none');

create type public.metric_unit_enum as enum ('money', 'ratio', 'count', 'days');

create type public.metric_dimension_enum as enum
  ('none', 'account', 'standard_category', 'counterparty', 'bank_account');

create type public.severity_enum as enum ('critical', 'high', 'medium', 'low', 'info');

create type public.alert_status_enum as enum ('open', 'acknowledged', 'resolved', 'dismissed');

-- ADR-047.2 adds `condition_returned`, the reason a resolved state alert re-opens.
create type public.alert_status_reason_enum as enum (
  'user', 'condition_cleared', 'record_removed', 'rule_retired', 'severity_increased',
  'condition_returned'
);

-- ADR-036: state rules are keyed by (rule_key, subject); event rules by (rule_key, period_id, subject).
create type public.alert_key_kind_enum as enum ('state', 'event');

create type public.alert_subject_enum as enum
  ('none', 'account', 'counterparty', 'bank_transaction', 'recurring_group', 'standard_category');

create type public.action_status_enum as enum ('open', 'in_progress', 'completed', 'dismissed');

create type public.action_priority_enum as enum ('critical', 'high', 'medium', 'low');

create type public.action_source_enum as enum ('ai', 'alert', 'health_score', 'user', 'report');

create type public.evidence_kind_enum as enum
  ('metric', 'alert', 'ai_response', 'health_score', 'action', 'report');

create type public.evidence_creator_enum as enum ('system', 'ai', 'user');

create type public.evidence_item_enum as enum (
  'metric_snapshot', 'calculation_run', 'ledger_entry', 'bank_transaction', 'invoice',
  'period_balance', 'counterparty', 'account', 'source_document', 'fiscal_period', 'alert', 'query'
);

-- The four tables whose lifecycle record_status_events logs, and which supersede_record accepts.
create type public.financial_record_table_enum as enum
  ('ledger_entries', 'bank_transactions', 'invoices', 'period_balances');

create type public.record_status_event_enum as enum
  ('accepted', 'superseded', 'unsuperseded', 'rejected', 'restored');

create type public.ai_conversation_status_enum as enum ('active', 'archived');

create type public.ai_message_role_enum as enum ('user', 'assistant');

create type public.grounding_status_enum as enum ('passed', 'failed', 'degraded', 'not_applicable');

create type public.ai_feedback_type_enum as enum ('incorrect', 'unhelpful', 'helpful', 'unsafe');

create type public.ai_feedback_status_enum as enum ('open', 'reviewed', 'actioned', 'dismissed');

create type public.mapping_confidence_enum as enum ('confirmed', 'suggested', 'unmapped');

create type public.account_source_enum as enum ('seeded', 'imported', 'user');

create type public.report_kind_enum as enum ('monthly_management');
