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
  destinationCountryCode?: string;
  deliverTo?: string;
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
  otherSeller?: OtherSeller;
  otherOffers?: OfferQuote[];
  notes?: string[];
}

export interface FxTable {
  base: string;
  date: string;
  rates: Record<string, number>;
  source: "ECB" | "FRANKFURTER";
}

export interface VariantOption {
  asin: string;
  label: string;
}

export type ListingAvailability = "available" | "unavailable" | "undeliverable" | "unknown";

export interface OfferQuote {
  item: Money;
  shipping: Money;
  seller?: string;
  dispatcher?: string;
  fulfilledByAmazon: boolean;
}

export interface OtherSeller {
  seller?: string;
  dispatcher?: string;
  fulfilledByAmazon: boolean;
  offerCount: number;
  readCount: number;
  readComplete: boolean;
  deliveringNewCount: number;
  unreadableCount: number;
  comparedCount?: number;
}

export interface ProductExtractionResult {
  marketplace: Marketplace;
  asin?: string;
  title?: string;
  selectedVariants: string[];
  variantOptions: VariantOption[];
  canonicalUrl: string;
  destinationCountryCode?: string;
  destinationMatched: boolean;
  hasShippingInfo: boolean;
  hasImportInfo: boolean;
  isDeliverable: boolean;
  availability: ListingAvailability;
  parseConfidence: number;
  breakdown?: PriceBreakdown;
  otherSeller?: OtherSeller;
  otherOffers?: OfferQuote[];
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
  sourceDestinationCountryCode?: string;
  sourceDeliverTo?: string;
  readOtherOffers?: boolean;
}

export interface LocationRequest {
  marketplace: Marketplace;
  countryCode: string;
}

export type LocationStatus = "ALREADY_SET" | "SET" | "NO_WIDGET" | "NOT_OFFERED" | "FAILED";

export interface LocationResult {
  status: LocationStatus;
  countryCode?: string;
  reason?: string;
}

export type PageKind = "product" | "search";

export type PageJobPage =
  | { kind: "product"; request: ProductExtractionRequest }
  | { kind: "search"; request: SearchExtractionRequest };

export interface PageJob {
  runKey: string;
  url: string;
  page: PageJobPage;
  location?: LocationRequest;
  expectDestination?: string;
}

export type PageFallbackReason =
  | "network"
  | "timeout"
  | "http-status"
  | "off-host"
  | "charset"
  | "shape"
  | "destination"
  | "offers"
  | "error"
  | "no-answer";

export interface PageJobRead {
  outcome: "read";
  finalUrl: string;
  product?: ProductExtractionResult;
  candidates?: SearchCandidate[];
  location?: LocationResult;
  locationRequested?: boolean;
}

export interface PageJobFallback {
  outcome: "fallback";
  reason: PageFallbackReason;
  detail?: string;
  location?: LocationResult;
  locationRequested?: boolean;
}

export type PageJobResult =
  | PageJobRead
  | PageJobFallback
  | { outcome: "location-set"; finalUrl: string; location: LocationResult }
  | { outcome: "not-found"; finalUrl: string; status: number }
  | { outcome: "robot-check"; finalUrl: string; status: number }
  | { outcome: "cancelled" };

export type ComparisonPhase = "OPEN" | "SEARCH" | "MATCH" | "READ";

export interface MarketProgress {
  marketplace: Marketplace;
  phase: ComparisonPhase;
}

export interface RunComparisonProgressPayload {
  completed: number;
  total: number;
  inFlight: MarketProgress[];
  latest?: MarketProgress;
  results?: ComparisonResult[];
  fxTable?: FxTable;
  activeTabId?: number;
  runId?: string;
}

export interface RunComparisonResultPayload {
  source?: SourceContext;
  baseline?: ComparisonResult;
  results: ComparisonResult[];
  generatedAt: string;
  fxTable?: FxTable;
  error?: string;
  activeTabId?: number;
  runId?: string;
}

export interface LoadSourcePayload {
  source?: SourceContext;
  baseline?: ComparisonResult;
  error?: string;
}

export interface ExtensionSettings {
  enabledMarketplaces: Marketplace[];
  comparisonCurrency: string | "SOURCE";
}

export interface CachedComparisonRecord {
  createdAt: string;
  source: SourceContext;
  baseline?: ComparisonResult;
  results: ComparisonResult[];
  fxTable?: FxTable;
}
