import { MARKETPLACE_BY_CODE, MARKETPLACE_CODES } from "../../src/shared/markets";
import { convertMoney, deliveredTotal } from "../../src/shared/money";
import type {
  ComparisonResult,
  ComparisonStatus,
  ExtensionSettings,
  FxTable,
  Marketplace,
  Money,
  PriceBreakdown,
  SourceContext
} from "../../src/shared/types";

export const NBSP = " ";
export const MINUS = "−";
export const SETTINGS_KEY = "settings:v1";
export const ACTIVE_TAB_ID = 42;
export const GENERATED_AT = "2026-07-30T09:00:00.000Z";
export const ASIN = "B09XS7JWHH";
export const IMAGE_HOST = "https://m.media-amazon.com";
export const NORMALIZED_CURRENCY = "USD";

export const fxTable: FxTable = {
  base: "EUR",
  date: "2026-07-30",
  rates: { EUR: 1, USD: 1.08, GBP: 0.852, CAD: 1.475, AUD: 1.655, JPY: 155.52, MXN: 19.46 },
  source: "ECB"
};

export function money(amount: number, currency: string): Money {
  return { amount, currency };
}

export function productUrl(marketplace: Marketplace): string {
  return `https://${MARKETPLACE_BY_CODE[marketplace].domain}/dp/${ASIN}`;
}

export const source: SourceContext = {
  marketplace: "US",
  asin: ASIN,
  title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones",
  brand: "Sony",
  variationTokens: ["black"],
  destinationCountryCode: "US",
  sourceUrl: productUrl("US"),
  imageUrl: `${IMAGE_HOST}/images/I/sony-wh1000xm5.jpg`
};

function normalizedTotal(breakdown: PriceBreakdown): Money {
  const delivered = deliveredTotal(breakdown);
  const converted = delivered ? convertMoney(delivered, NORMALIZED_CURRENCY, fxTable) : undefined;
  if (!converted) {
    throw new Error(`Cannot convert ${JSON.stringify(breakdown)} to ${NORMALIZED_CURRENCY}`);
  }
  return converted;
}

function okResult(
  marketplace: Marketplace,
  costs: [item: number, shipping: number, importFees: number],
  confidence: number,
  notes: string[]
): ComparisonResult {
  const currency = MARKETPLACE_BY_CODE[marketplace].currency;
  const [item, shipping, importFees] = costs;
  const breakdown: PriceBreakdown = {
    item: money(item, currency),
    shipping: money(shipping, currency),
    importFees: money(importFees, currency)
  };
  return {
    marketplace,
    status: "OK",
    confidence,
    productUrl: productUrl(marketplace),
    breakdown,
    normalizedTotal: normalizedTotal(breakdown),
    notes
  };
}

function failedResult(
  marketplace: Marketplace,
  status: Exclude<ComparisonStatus, "OK">,
  confidence: number,
  notes: string[]
): ComparisonResult {
  return { marketplace, status, confidence, notes };
}

const SOURCE_NOTE = "The page you are on. Everything else is measured against this.";

export const baseline: ComparisonResult = okResult("US", [399.99, 0, 0], 1, [SOURCE_NOTE]);

export const cheapBaseline: ComparisonResult = okResult("US", [299.99, 0, 0], 1, [SOURCE_NOTE]);

export const de = okResult("DE", [279.0, 12.99, 31.2], 0.91, [
  "Match confidence: HIGH",
  "Import fees deposit quoted on the product page. Delivery 6–10 days."
]);
export const deWithoutImportFees: ComparisonResult = {
  ...de,
  breakdown: { item: money(279.0, "EUR"), shipping: money(12.99, "EUR") },
  normalizedTotal: undefined,
  notes: ["Matched by ASIN", "Import fees not displayed for destination"]
};
export const it_ = okResult("IT", [289.9, 14.5, 30.2], 0.76, [
  "Match confidence: MEDIUM",
  "Colour is not stated in the listing title — confirm it is the black variant before buying."
]);
export const uk = okResult("UK", [259.0, 9.99, 24.6], 0.94, ["Import fees deposit quoted. Sold and shipped by Amazon UK."]);
export const ca = okResult("CA", [479.99, 12.99, 41.62], 0.97, ["Duties collected at checkout. Delivery 4–7 days."]);
export const au = okResult("AU", [599.0, 19.95, 53.35], 0.9, ["GST included in the quoted import estimate."]);
export const jp = failedResult("JP", "DESTINATION_MISMATCH", 0.93, [
  "Match found, but the seller does not ship to the United States."
]);
export const fr = failedResult("FR", "UNAVAILABLE", 0.9, ["Out of stock — no delivery date offered."]);
export const es = failedResult("ES", "PARSE_FAILED", 0.89, [
  "Import fees are only revealed at checkout, so the delivered total cannot be quoted."
]);
export const mx = failedResult("MX", "NO_CONFIDENT_MATCH", 0.31, [
  "Closest listing scored 31% — below the confidence floor."
]);

export const TARGET_ORDER: Marketplace[] = ["CA", "MX", "UK", "DE", "FR", "IT", "ES", "JP", "AU"];

export const mockupResults: ComparisonResult[] = [ca, mx, uk, de, fr, it_, es, jp, au];

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabledMarketplaces: [...MARKETPLACE_CODES],
  comparisonCurrency: "SOURCE",
  disclosureAcknowledged: false
};
