export type Marketplace = "US" | "CA" | "MX" | "UK" | "DE" | "FR" | "IT" | "ES" | "JP" | "AU";

export interface Money {
  amount: number;
  currency: string;
}

export interface SourceContext {
  marketplace: Marketplace;
  asin: string;
  title: string;
  brand?: string;
  variationTokens: string[];
  destinationCountryCode: string;
  sourceUrl: string;
  imageUrl?: string;
}

export interface SearchCandidate {
  marketplace: Marketplace;
  asin?: string;
  title: string;
  brand?: string;
  price?: Money;
  url: string;
  imageUrl?: string;
}

export interface MatchScore {
  total: number;
  titleScore: number;
  brandScore: number;
  variationScore: number;
  confidenceLabel: "HIGH" | "MEDIUM" | "LOW";
}

export interface PriceBreakdown {
  item: Money;
  shipping?: Money;
  importFees?: Money;
  totalDisplayed?: Money;
}

export type ComparisonStatus =
  | "OK"
  | "UNAVAILABLE"
  | "DESTINATION_MISMATCH"
  | "NO_CONFIDENT_MATCH"
  | "PARSE_FAILED";

export interface ComparisonResult {
  marketplace: Marketplace;
  status: ComparisonStatus;
  confidence: number;
  productUrl?: string;
  breakdown?: PriceBreakdown;
  normalizedTotal?: Money;
  notes?: string[];
}

export interface FxTable {
  base: string;
  date: string;
  rates: Record<string, number>;
  source: "ECB" | "FRANKFURTER";
}

export interface ProductExtractionResult {
  marketplace: Marketplace;
  asin?: string;
  canonicalUrl: string;
  destinationCountryCode?: string;
  destinationMatched: boolean;
  hasShippingInfo: boolean;
  hasImportInfo: boolean;
  isDeliverable: boolean;
  parseConfidence: number;
  breakdown?: PriceBreakdown;
  notes: string[];
}

export interface SourceExtractionResult {
  source?: SourceContext;
  error?: string;
}

export interface SearchExtractionRequest {
  marketplace: Marketplace;
  limit?: number;
}

export interface ProductExtractionRequest {
  marketplace: Marketplace;
  sourceDestinationCountryCode: string;
}

export type ComparisonPhase = "OPEN" | "SEARCH" | "MATCH" | "READ";

export interface RunComparisonProgressPayload {
  completed: number;
  total: number;
  currentMarketplace?: Marketplace;
  phase?: ComparisonPhase;
  results?: ComparisonResult[];
}

export interface RunComparisonResultPayload {
  source?: SourceContext;
  baseline?: ComparisonResult;
  results: ComparisonResult[];
  generatedAt: string;
  fxTable?: FxTable;
  error?: string;
}

export interface LoadSourcePayload {
  source?: SourceContext;
  baseline?: ComparisonResult;
  error?: string;
}

export interface ExtensionSettings {
  enabledMarketplaces: Marketplace[];
  comparisonCurrency: string | "SOURCE";
  disclosureAcknowledged: boolean;
}

export interface CachedComparisonRecord {
  createdAt: string;
  source: SourceContext;
  baseline?: ComparisonResult;
  results: ComparisonResult[];
  fxTable?: FxTable;
}
