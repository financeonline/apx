/**
 * Commercial Intelligence (Phase 14, ADR-102). Rows a person records about products, campaigns,
 * channels, spend and the pipeline; pure rules that turn them and the engine's customer figures into
 * stated results; writes through `api.*` under `customers.edit`. No financial figure is defined here.
 */
export {
  OPEN_STAGES,
  OPPORTUNITY_STAGES,
  acquisitionCost,
  attributeCampaignRevenue,
  concentrationTrend,
  conversion,
  monthOf,
  pipelineByStage,
  productContribution,
  salesByPeriod,
  wonCustomers,
  type AcquisitionCost,
  type AttributionStatus,
  type CacReason,
  type CampaignAttribution,
  type ConcentrationPoint,
  type ContributionReason,
  type Conversion,
  type OpportunityRow,
  type OpportunityStage,
  type PeriodRef as CommercialPeriodRef,
  type ProductContribution,
  type ProductFigures,
  type SalesPeriodPoint,
  type StageSummary,
  type WonCustomer,
} from './domain/rules';
export type { Campaign, CampaignSpend, InvoiceLine, MarketingChannel, Product, ProductPeriodSummary } from './domain/types';
export {
  listCampaignSpend, listCampaigns, listChannels, listInvoiceLines, listInvoiceNets, listLinesForProduct, listOpportunities, listProducts,
  productPeriodSummary, type ProductLineRow,
} from './data/repository';
export {
  CampaignInput, ChannelInput, InvoiceLinesInput, OpportunityInput, ProductInput, SpendInput,
  setCampaignSpend, setInvoiceLines, upsertCampaign, upsertChannel, upsertOpportunity, upsertProduct,
} from './services';
