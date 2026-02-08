import type { ProductExtractionRequest, ProductExtractionResult } from "../shared/types";

interface CountryAlias {
  code: string;
  aliases: string[];
}

const COUNTRY_ALIASES: CountryAlias[] = [
  { code: "US", aliases: ["united states", "usa", "us"] },
  { code: "CA", aliases: ["canada", "ca"] },
  { code: "MX", aliases: ["mexico", "mx"] },
  { code: "UK", aliases: ["united kingdom", "great britain", "uk"] },
  { code: "DE", aliases: ["germany", "deutschland", "de"] },
  { code: "FR", aliases: ["france", "fr"] },
  { code: "IT", aliases: ["italy", "italia", "it"] },
  { code: "ES", aliases: ["spain", "espana", "españa", "es"] },
  { code: "JP", aliases: ["japan", "jp", "日本"] },
  { code: "AU", aliases: ["australia", "au"] }
];

const MARKET_DEFAULT_CURRENCY: Record<ProductExtractionRequest["marketplace"], string> = {
  US: "USD",
  CA: "CAD",
  MX: "MXN",
  UK: "GBP",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  ES: "EUR",
  JP: "JPY",
  AU: "AUD"
};

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function aliasMatches(normalizedText: string, alias: string): boolean {
  if (/^[a-z]{2}$/.test(alias)) {
    const regex = new RegExp(`\\b${alias}\\b`, "i");
    return regex.test(normalizedText);
  }

  return normalizedText.includes(alias);
}

function parseLocalizedNumber(input: string): number | undefined {
  const sanitized = input.replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  if (!sanitized) {
    return undefined;
  }

  const hasComma = sanitized.includes(",");
  const hasDot = sanitized.includes(".");

  if (hasComma && hasDot) {
    const lastComma = sanitized.lastIndexOf(",");
    const lastDot = sanitized.lastIndexOf(".");
    const normalized =
      lastComma > lastDot ? sanitized.replace(/\./g, "").replace(",", ".") : sanitized.replace(/,/g, "");
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (hasComma) {
    const parts = sanitized.split(",");
    const normalized = parts[parts.length - 1].length === 2 ? sanitized.replace(",", ".") : sanitized.replace(/,/g, "");
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  const parsed = Number.parseFloat(sanitized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function detectCurrency(text: string): string {
  if (text.includes("CA$") || text.includes("C$")) {
    return "CAD";
  }
  if (text.includes("MX$")) {
    return "MXN";
  }
  if (text.includes("AU$")) {
    return "AUD";
  }
  if (text.includes("£")) {
    return "GBP";
  }
  if (text.includes("€")) {
    return "EUR";
  }
  if (text.includes("￥") || text.includes("¥")) {
    return "JPY";
  }
  return "USD";
}

function parseMoney(text: string): { amount: number; currency: string } | undefined {
  const amount = parseLocalizedNumber(text);
  if (amount === undefined) {
    return undefined;
  }

  return {
    amount,
    currency: detectCurrency(text)
  };
}

function resolveDestinationCountryCode(documentRef: Document): string | undefined {
  const locationText = [
    documentRef.querySelector("#glow-ingress-line2")?.textContent,
    documentRef.querySelector("#glow-ingress-line1")?.textContent,
    documentRef.querySelector("#contextualIngressPtLabel")?.textContent,
    documentRef.querySelector("#delivery-block-message")?.textContent,
    documentRef.querySelector("#deliveryBlockMessage")?.textContent
  ]
    .filter(Boolean)
    .join(" ");

  if (!locationText) {
    return undefined;
  }

  const normalizedText = normalize(locationText);
  for (const country of COUNTRY_ALIASES) {
    if (country.aliases.some((alias) => aliasMatches(normalizedText, alias))) {
      return country.code;
    }
  }

  return undefined;
}

function findPriceText(documentRef: Document): string | undefined {
  const selectors = [
    "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
    "#apex_desktop .a-price .a-offscreen",
    "#priceblock_ourprice",
    "#priceblock_dealprice",
    ".a-price.aok-align-center .a-offscreen"
  ];

  for (const selector of selectors) {
    const text = documentRef.querySelector(selector)?.textContent?.trim();
    if (text) {
      return text;
    }
  }

  return undefined;
}

function findChargeByKeywords(documentRef: Document, keywords: string[]): string | undefined {
  const selectors = [
    "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
    "#deliveryBlockMessage",
    "#deliveryBlockMessage_feature_div",
    "#exports_desktop_feature_div",
    "#mir-layout-DELIVERY_BLOCK-slot-DELIVERY_MESSAGE",
    "#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE"
  ];

  for (const selector of selectors) {
    const element = documentRef.querySelector(selector);
    if (!element) {
      continue;
    }

    const content = normalize(element.textContent ?? "");
    if (!keywords.some((keyword) => content.includes(keyword))) {
      continue;
    }

    const priceText =
      element.querySelector(".a-color-price")?.textContent?.trim() ??
      element.querySelector(".a-offscreen")?.textContent?.trim() ??
      element.textContent?.trim();

    if (priceText) {
      return priceText;
    }
  }

  return undefined;
}

function hasFreeMarker(text: string | undefined): boolean {
  if (!text) {
    return false;
  }

  const normalizedText = normalize(text);
  return (
    normalizedText.includes("free") ||
    normalizedText.includes("gratuit") ||
    normalizedText.includes("gratis") ||
    normalizedText.includes("kostenlos") ||
    normalizedText.includes("無料")
  );
}

export function extractProductData(
  documentRef: Document,
  request: ProductExtractionRequest,
  pageUrl: string
): ProductExtractionResult {
  const notes: string[] = [];

  const itemPriceText = findPriceText(documentRef);
  const itemPrice = itemPriceText ? parseMoney(itemPriceText) : undefined;

  const shippingText = findChargeByKeywords(documentRef, ["shipping", "delivery", "envio", "livraison", "versand", "配達"]);
  const importText = findChargeByKeywords(documentRef, ["import fee", "import fees", "deposit", "税", "duty", "aduana"]);

  const shippingAmount = shippingText ? parseMoney(shippingText) : undefined;
  const importAmount = importText ? parseMoney(importText) : undefined;

  const shippingIsFree = hasFreeMarker(shippingText);
  const importIsFree = hasFreeMarker(importText) || normalize(importText ?? "").includes("no import fee");

  const hasShippingInfo = Boolean(shippingAmount || shippingIsFree);
  const hasImportInfo = Boolean(importAmount || importIsFree);

  if (!hasShippingInfo) {
    notes.push("Shipping not displayed for destination");
  }

  if (!hasImportInfo) {
    notes.push("Import fees not displayed for destination");
  }

  const currency = itemPrice?.currency ?? shippingAmount?.currency ?? importAmount?.currency ?? MARKET_DEFAULT_CURRENCY[request.marketplace];

  const destinationDetected = resolveDestinationCountryCode(documentRef);
  const destinationMatched = !destinationDetected || destinationDetected === request.sourceDestinationCountryCode;

  if (!destinationMatched) {
    notes.push(`Destination mismatch detected (${destinationDetected})`);
  }

  const canonicalUrl =
    documentRef.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href ?? pageUrl.split("?")[0] ?? pageUrl;

  const asin = canonicalUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase();

  const totalDisplayedText =
    documentRef.querySelector("#subtotals-marketplace-table .a-color-price")?.textContent?.trim() ??
    documentRef.querySelector("#atfRedesign_desktop_totalPrice")?.textContent?.trim();

  const totalDisplayed = totalDisplayedText ? parseMoney(totalDisplayedText) : undefined;

  const parseConfidence =
    (itemPrice ? 0.5 : 0) +
    (hasShippingInfo ? 0.2 : 0) +
    (hasImportInfo ? 0.2 : 0) +
    (destinationMatched ? 0.1 : 0);

  return {
    marketplace: request.marketplace,
    asin,
    canonicalUrl,
    destinationCountryCode: destinationDetected,
    destinationMatched,
    hasShippingInfo,
    hasImportInfo,
    isDeliverable: Boolean(itemPrice) && destinationMatched,
    parseConfidence: Number(parseConfidence.toFixed(2)),
    breakdown: itemPrice
      ? {
          item: itemPrice,
          shipping: shippingAmount ?? (shippingIsFree ? { amount: 0, currency } : undefined),
          importFees: importAmount ?? (importIsFree ? { amount: 0, currency } : undefined),
          totalDisplayed
        }
      : undefined,
    notes
  };
}

declare global {
  interface Window {
    __ACROSS_AMAZON_PRODUCT_REQUEST__?: ProductExtractionRequest;
    __ACROSS_AMAZON_PRODUCT_RESULT__?: ProductExtractionResult;
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const request = window.__ACROSS_AMAZON_PRODUCT_REQUEST__;
  if (request) {
    window.__ACROSS_AMAZON_PRODUCT_RESULT__ = extractProductData(document, request, location.href);
  }
}
