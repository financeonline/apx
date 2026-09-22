/** Commercial rows as the module reads them (Phase 14, ADR-102). Money is a string (ADR-006). */
import type { OpportunityRow, OpportunityStage } from './rules';

export type { OpportunityRow, OpportunityStage };

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly kind: 'product' | 'service';
  readonly code: string | null;
  readonly isActive: boolean;
  readonly notes: string | null;
}

export interface MarketingChannel {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
}

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly channelId: string | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly status: 'planned' | 'active' | 'ended';
  readonly notes: string | null;
}

export interface CampaignSpend {
  readonly id: string;
  readonly campaignId: string;
  readonly periodId: string;
  readonly amount: string;
  readonly currency: string;
  readonly note: string | null;
}

export interface InvoiceLine {
  readonly id: string;
  readonly invoiceId: string;
  readonly productId: string | null;
  readonly description: string | null;
  readonly quantity: string | null;
  readonly amount: string;
  readonly sortOrder: number;
}

/** `api.product_period_summary`, as returned. */
export interface ProductPeriodSummary {
  readonly products: ReadonlyArray<{
    readonly product_id: string | null;
    readonly period_id: string;
    readonly sales: string;
    readonly cost: string;
    readonly sales_lines: number;
    readonly cost_lines: number;
    readonly invoices: number;
  }>;
  readonly unattributed: ReadonlyArray<{
    readonly period_id: string;
    readonly sales_net: string;
    readonly attributed: string;
    readonly invoices: number;
    readonly invoices_without_lines: number;
  }>;
  readonly customer_mix: ReadonlyArray<{
    readonly product_id: string;
    readonly counterparty_id: string | null;
    readonly sales: string;
    readonly lines: number;
  }>;
}
