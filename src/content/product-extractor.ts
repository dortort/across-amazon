import type {
  ListingAvailability,
  OfferQuote,
  ProductExtractionRequest,
  ProductExtractionResult,
  VariantOption
} from "../shared/types";
import { buildOtherOffersUrl, parseOtherOffers, quotableOffers } from "./other-offers";
import type { QuotableOffer } from "./other-offers";
import {
  collapseText,
  hasFreeMarker,
  normalize,
  parseCurrencyMarkedMoney,
  parseMoney,
  readAmount,
  readDeliveryPrice,
  readPriceText
} from "./price-reading";
import type { ChargeReading, ParsedMoney } from "./price-reading";

interface CountryAlias {
  code: string;
  aliases: string[];
}

const COUNTRY_ALIASES: CountryAlias[] = [
  { code: "US", aliases: ["united states", "usa", "us"] },
  { code: "CA", aliases: ["canada", "ca"] },
  { code: "MX", aliases: ["mexico", "mx"] },
  { code: "GB", aliases: ["united kingdom", "great britain", "uk"] },
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

function isCountryCode(alias: string): boolean {
  return /^[a-z]{2}$/.test(alias);
}

function aliasMatches(normalizedText: string, alias: string): boolean {
  if (/^[a-z ]+$/.test(alias)) {
    return new RegExp(`(?:^|[^a-z])${alias}(?:[^a-z]|$)`).test(normalizedText);
  }

  return normalizedText.includes(alias);
}

const DELIVER_TO_SELECTORS = ["#glow-ingress-line2", "#glow-ingress-line1", "#contextualIngressPtLabel"];
const DELIVERY_MESSAGE_SELECTORS = ["#delivery-block-message", "#deliveryBlockMessage"];

const FIVE_DIGITS = /(?:^|\D)(\d{5})(?:\D|$)/;

const DOMESTIC_POSTCODE: Record<ProductExtractionRequest["marketplace"], RegExp> = {
  US: /(?:^|\D)(\d{5}(?:-\d{4})?)(?:\D|$)/,
  CA: /(?:^|[^a-z0-9])([a-z]\d[a-z] ?\d[a-z]\d)(?:[^a-z0-9]|$)/,
  MX: FIVE_DIGITS,
  UK: /(?:^|[^a-z0-9])([a-z]{1,2}\d[a-z\d]? ?\d[a-z]{2})(?:[^a-z0-9]|$)/,
  DE: FIVE_DIGITS,
  FR: FIVE_DIGITS,
  IT: FIVE_DIGITS,
  ES: FIVE_DIGITS,
  JP: /(?:^|\D)(\d{3}-\d{4})(?:\D|$)/,
  AU: /(?:^|\D)(\d{4})(?:\D|$)/
};

const ISO_CODE = /^[A-Z]{2}$/;
const NAV_COUNTRY = /\$Nav\.declare\(\s*['"]config\.customerCountryCode['"]\s*,\s*['"]([A-Za-z]{2})['"]\s*\)/;

function asIso(value: unknown): string | undefined {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return ISO_CODE.test(code) ? code : undefined;
}

function readVasCountry(documentRef: Document): string | undefined {
  for (const script of Array.from(documentRef.querySelectorAll('script[type="a-state"]'))) {
    try {
      const state = JSON.parse(script.getAttribute("data-a-state") ?? "{}") as { key?: unknown };
      if (state.key === "vas-base-vm") {
        return asIso((JSON.parse(script.textContent ?? "{}") as { countryCode?: unknown }).countryCode);
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function readNavCountry(documentRef: Document): string | undefined {
  for (const script of Array.from(documentRef.querySelectorAll("script:not([src])"))) {
    const text = script.textContent ?? "";
    const code = text.includes("customerCountryCode") ? asIso(NAV_COUNTRY.exec(text)?.[1]) : undefined;
    if (code) {
      return code;
    }
  }
  return undefined;
}

function readDestinationIso(documentRef: Document): string | undefined {
  return (
    readVasCountry(documentRef) ??
    asIso(documentRef.querySelector<HTMLInputElement>('input#countryCode[type="hidden"]')?.value) ??
    readNavCountry(documentRef)
  );
}

function readTexts(documentRef: Document, selectors: string[]): string {
  return selectors
    .map((selector) => documentRef.querySelector(selector)?.textContent)
    .filter(Boolean)
    .join(" ");
}

function readDeliveryDestinations(documentRef: Document): string[] {
  return Array.from(
    documentRef.querySelectorAll("[data-csa-c-delivery-destination]"),
    (element) => element.getAttribute("data-csa-c-delivery-destination") ?? ""
  );
}

function resolveDestinationCountryCode(documentRef: Document, request: ProductExtractionRequest): string | undefined {
  const machineReadable = readDestinationIso(documentRef);
  if (machineReadable) {
    return machineReadable;
  }

  const deliverToText = readTexts(documentRef, DELIVER_TO_SELECTORS);
  const deliverTo = normalize(deliverToText);
  const message = normalize([readTexts(documentRef, DELIVERY_MESSAGE_SELECTORS), ...readDeliveryDestinations(documentRef)].join(" "));

  if (!deliverTo && !message) {
    return undefined;
  }

  for (const country of COUNTRY_ALIASES) {
    const named = country.aliases.some(
      (alias) => aliasMatches(deliverTo, alias) || (!isCountryCode(alias) && aliasMatches(message, alias))
    );
    if (named) {
      return country.code;
    }
  }

  const postcode = DOMESTIC_POSTCODE[request.marketplace].exec(deliverTo)?.[1];
  const shownOnSource = postcode !== undefined && normalize(request.sourceDeliverTo ?? "").includes(postcode);
  if (!postcode || shownOnSource) {
    return undefined;
  }
  return request.marketplace === "UK" ? "GB" : request.marketplace;
}

interface PriceSource {
  selector: string;
  unanchored?: boolean;
}

const ITEM_PRICE_SOURCES: PriceSource[] = [
  { selector: "#corePrice_feature_div .a-price" },
  { selector: "#price_inside_buybox" },
  { selector: "#corePriceDisplay_desktop_feature_div .a-price" },
  { selector: "#apex_desktop .a-price" },
  { selector: ".a-price.priceToPay, .a-price.apexPriceToPay, .a-price.apex-pricetopay-value", unanchored: true },
  { selector: "#priceblock_ourprice" },
  { selector: "#priceblock_dealprice" },
  { selector: "#tp_price_block_total_price_ww .a-price" },
  { selector: ".a-price.aok-align-center", unanchored: true }
];

const PRODUCT_BLOCK = "#ppd";

const PRICE_TO_PAY = ".priceToPay, .apexPriceToPay, .apex-pricetopay-value";
const OTHER_PRICE = [
  ".apex-priceperunit-value",
  ".pricePerUnit",
  ".apex-basisprice-value",
  ".basisPrice",
  "[data-a-strike='true']",
  "#twister_feature_div",
  "[id^='inline-twister-row-']",
  "#above-dp-container",
  "[id^='sims-']",
  "#outOfStock"
].join(", ");

function isOtherPrice(price: Element): boolean {
  return Boolean(price.closest(OTHER_PRICE)) || (!price.matches(PRICE_TO_PAY) && Boolean(price.closest(".a-text-price")));
}

function findItemPrice(documentRef: Document, marketCurrency: string): ParsedMoney | undefined {
  const productBlock = documentRef.querySelector(PRODUCT_BLOCK) ?? documentRef;
  for (const { selector, unanchored } of ITEM_PRICE_SOURCES) {
    const scope = unanchored ? productBlock : documentRef;
    for (const price of Array.from(scope.querySelectorAll(selector))) {
      const text = isOtherPrice(price) ? undefined : readPriceText(price);
      const amount = text ? parseMoney(text, marketCurrency) : undefined;
      if (amount) {
        return amount;
      }
    }
  }

  return undefined;
}

function readAvailabilityMessage(documentRef: Document): string | undefined {
  const selectors = ["#availability .primary-availability-message", "#outOfStock .a-text-bold"];
  for (const selector of selectors) {
    const text = documentRef.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim();
    if (text) {
      return text;
    }
  }

  return undefined;
}

const UNDELIVERABLE_NOTICES = [
  "cannot be shipped to your selected delivery location",
  "cannot be dispatched to your selected delivery location",
  "kann nicht an den ausgewählten Lieferort",
  "ne peut pas être expédié",
  "non può essere spedito",
  "no se puede enviar",
  "お届け先に発送できません"
].map(normalize);

const UNAVAILABLE_NOTICES = [
  "currently unavailable",
  "derzeit nicht verfügbar",
  "actuellement indisponible",
  "non disponibile",
  "no disponible por el momento",
  "在庫切れ"
].map(normalize);

const AVAILABILITY_BLOCK_SELECTORS = ["#availability", "#outOfStock"];
const OFFER_SELECTORS = ["#add-to-cart-button", "#buy-now-button", "#buybox-see-all-buying-choices"];

function readBlockText(documentRef: Document, selector: string): string {
  const element = documentRef.querySelector(selector);
  if (!element) {
    return "";
  }

  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll("script, style").forEach((node) => node.remove());
  return copy.textContent ?? "";
}

function readAvailability(documentRef: Document, priced: boolean): ListingAvailability {
  if (priced) {
    return "available";
  }

  const notice = normalize(AVAILABILITY_BLOCK_SELECTORS.map((selector) => readBlockText(documentRef, selector)).join(" "));
  if (UNDELIVERABLE_NOTICES.some((text) => notice.includes(text))) {
    return "undeliverable";
  }
  if (UNAVAILABLE_NOTICES.some((text) => notice.includes(text))) {
    return "unavailable";
  }

  const offered = OFFER_SELECTORS.some((selector) => documentRef.querySelector(selector));
  return notice || offered ? "unknown" : "unavailable";
}

const CHARGE_BLOCK_SELECTORS = [
  "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
  "#deliveryBlockMessage",
  "#deliveryBlockMessage_feature_div",
  "#exports_desktop_feature_div",
  "#mir-layout-DELIVERY_BLOCK-slot-DELIVERY_MESSAGE",
  "#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE"
];

function findChargeBlock(documentRef: Document, keywords: string[]): Element | undefined {
  for (const selector of CHARGE_BLOCK_SELECTORS) {
    const element = documentRef.querySelector(selector);
    const content = normalize(element?.textContent ?? "");
    if (element && keywords.some((keyword) => content.includes(keyword))) {
      return element;
    }
  }

  return undefined;
}

function readPriceElement(block: Element, marketCurrency: string): ParsedMoney | undefined {
  const priceElements = [...block.querySelectorAll(".a-color-price"), ...block.querySelectorAll(".a-offscreen")];
  for (const element of priceElements) {
    const amount = readAmount(element.textContent?.trim() ?? "", marketCurrency);
    if (amount) {
      return amount;
    }
  }

  return undefined;
}

function readCharge(
  documentRef: Document,
  keywords: string[],
  isFreeText: (text: string) => boolean,
  marketCurrency: string
): ChargeReading {
  const block = findChargeBlock(documentRef, keywords);
  if (!block) {
    return { isFree: false };
  }

  const explicitAmount = readPriceElement(block, marketCurrency);
  if (explicitAmount) {
    return { amount: explicitAmount, isFree: false };
  }

  const blockText = block.textContent ?? "";
  if (isFreeText(blockText)) {
    return { isFree: true };
  }

  return { amount: parseCurrencyMarkedMoney(blockText, marketCurrency), isFree: false };
}

interface GlobalCharges {
  shipping?: ParsedMoney;
  importFees?: ParsedMoney;
  total?: ParsedMoney;
}

function readAmazonGlobalCharges(documentRef: Document, marketCurrency: string): GlobalCharges {
  const charges: GlobalCharges = {};
  for (const row of Array.from(documentRef.querySelectorAll("#amazonGlobal_feature_div table.a-lineitem tr"))) {
    const cells = Array.from(row.querySelectorAll("td"));
    if (cells.length < 2) {
      continue;
    }

    const label = normalize(cells[0].textContent ?? "");
    const amount = readAmount(cells[cells.length - 1].textContent?.trim() ?? "", marketCurrency);
    if (!amount) {
      continue;
    }

    if (label.includes("import")) {
      charges.importFees ??= amount;
    } else if (label.includes("shipping") || label.includes("delivery")) {
      charges.shipping ??= amount;
    } else if (label === "total") {
      charges.total ??= amount;
    }
  }

  return charges;
}

const IMPORT_CHARGE = /import fee|import charge/;
const NO_IMPORT_CHARGE = /\bno import fee|\bno import charge/;
const SHIPPING_CHARGE = /shipping|delivery/;
const COMBINED_CHARGES = /shipping & import fee|shipping & import charge/;

interface ChargeLine {
  shipping?: ChargeReading;
  importFees?: ChargeReading;
}

function readChargeClause(clause: string, isFree: boolean, marketCurrency: string): ChargeReading | undefined {
  if (isFree) {
    return { isFree: true };
  }

  const amount = parseCurrencyMarkedMoney(clause, marketCurrency);
  return amount ? { amount, isFree: false } : undefined;
}

function splitCombinedCharges(combined: ParsedMoney, delivery: ChargeReading): ChargeLine {
  const shipping = delivery.amount;
  if (!shipping || shipping.currency !== combined.currency || shipping.amount <= 0 || shipping.amount > combined.amount) {
    return { shipping: { amount: combined, isFree: false } };
  }

  const importFees = Math.round((combined.amount - shipping.amount) * 100) / 100;
  return { shipping: delivery, importFees: { amount: { amount: importFees, currency: combined.currency }, isFree: false } };
}

function readAmazonGlobalLine(documentRef: Document, marketCurrency: string, delivery: ChargeReading): ChargeLine {
  for (const line of Array.from(documentRef.querySelectorAll("#amazonGlobal_feature_div > .a-color-secondary"))) {
    const lineText = line.textContent ?? "";
    const combined = COMBINED_CHARGES.test(normalize(lineText)) ? parseCurrencyMarkedMoney(lineText, marketCurrency) : undefined;
    if (combined) {
      return splitCombinedCharges(combined, delivery);
    }

    const charges: ChargeLine = {};
    for (const clause of lineText.split("&")) {
      const text = normalize(clause);
      if (IMPORT_CHARGE.test(text)) {
        charges.importFees ??= readChargeClause(clause, NO_IMPORT_CHARGE.test(text), marketCurrency);
      } else if (SHIPPING_CHARGE.test(text)) {
        charges.shipping ??= readChargeClause(clause, hasFreeMarker(clause), marketCurrency);
      }
    }

    if (charges.shipping || charges.importFees) {
      return charges;
    }
  }

  return {};
}

const SHIPPING_KEYWORDS = ["shipping", "delivery", "envio", "livraison", "versand", "配達"];
const IMPORT_KEYWORDS = ["import fee", "import charge", "deposit", "税", "duty", "aduana"];

function readImportCharge(documentRef: Document, marketCurrency: string): ChargeReading {
  const block = findChargeBlock(documentRef, IMPORT_KEYWORDS);
  if (block && NO_IMPORT_CHARGE.test(normalize(block.textContent ?? ""))) {
    return { isFree: true };
  }

  return readCharge(documentRef, IMPORT_KEYWORDS, hasFreeMarker, marketCurrency);
}

function tableCharge(amount: ParsedMoney | undefined): ChargeReading | undefined {
  return amount ? { amount, isFree: false } : undefined;
}

const ASIN_PATTERN = /^[A-Z0-9]{10}$/i;
const PRODUCT_PATH_ASIN = /\/(?:dp|gp\/product|clp)\/([A-Z0-9]{10})/i;

function readDocumentAsin(documentRef: Document, canonicalHref?: string): string | undefined {
  const asinInput = documentRef.querySelector<HTMLInputElement>("#ASIN, input[name='ASIN']")?.value?.trim();
  if (asinInput && ASIN_PATTERN.test(asinInput)) {
    return asinInput.toUpperCase();
  }

  return canonicalHref?.match(PRODUCT_PATH_ASIN)?.[1]?.toUpperCase();
}

const SELECTED_VARIANT_SELECTORS = [
  '[id^="inline-twister-expanded-dimension-text-"]',
  "#variation_color_name .selection",
  "#variation_size_name .selection",
  "#variation_style_name .selection",
  "#variation_pattern_name .selection",
  "#variation_item_package_quantity .selection"
];

function readSelectedVariants(documentRef: Document): string[] {
  const values = SELECTED_VARIANT_SELECTORS.flatMap((selector) =>
    Array.from(documentRef.querySelectorAll(selector), (element) => collapseText(element))
  );
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function readVariantOptions(documentRef: Document): VariantOption[] {
  return Array.from(documentRef.querySelectorAll('[id^="inline-twister-row-"] li[data-asin]')).flatMap((item) => {
    const asin = item.getAttribute("data-asin")?.trim().toUpperCase();
    const label =
      item.querySelector("img.swatch-image")?.getAttribute("alt")?.replace(/\s+/g, " ").trim() ||
      collapseText(item.querySelector(".swatch-title-text-display"));
    return asin && ASIN_PATTERN.test(asin) && label ? [{ asin, label }] : [];
  });
}

const PRICE_NOT_DISPLAYED = "Price not displayed for destination";
const SHIPPING_NOT_DISPLAYED = "Shipping not displayed for destination";
const IMPORT_FEES_NOT_DISPLAYED = "Import fees not displayed for destination";
const AMAZON_SAYS = "Amazon says: ";

function parseConfidenceOf(priced: boolean, hasShippingInfo: boolean, hasImportInfo: boolean, destinationMatched: boolean): number {
  const confidence = (priced ? 0.5 : 0) + (hasShippingInfo ? 0.2 : 0) + (hasImportInfo ? 0.2 : 0) + (destinationMatched ? 0.1 : 0);
  return Number(confidence.toFixed(2));
}

export function extractProductData(
  documentRef: Document,
  request: ProductExtractionRequest,
  pageUrl: string
): ProductExtractionResult {
  const notes: string[] = [];
  const marketCurrency = MARKET_DEFAULT_CURRENCY[request.marketplace];

  const itemPrice = findItemPrice(documentRef, marketCurrency);

  if (!itemPrice) {
    notes.push(PRICE_NOT_DISPLAYED);
    const availability = readAvailabilityMessage(documentRef);
    if (availability) {
      notes.push(`${AMAZON_SAYS}${availability}`);
    }
  }

  const globalCharges = readAmazonGlobalCharges(documentRef, marketCurrency);
  const delivery =
    readDeliveryPrice(documentRef, marketCurrency) ?? readCharge(documentRef, SHIPPING_KEYWORDS, hasFreeMarker, marketCurrency);
  const globalLine = readAmazonGlobalLine(documentRef, marketCurrency, delivery);
  const { amount: shippingAmount, isFree: shippingIsFree } = tableCharge(globalCharges.shipping) ?? globalLine.shipping ?? delivery;
  const { amount: importAmount, isFree: importIsFree } =
    tableCharge(globalCharges.importFees) ?? globalLine.importFees ?? readImportCharge(documentRef, marketCurrency);

  const hasShippingInfo = Boolean(shippingAmount || shippingIsFree);
  const hasImportInfo = Boolean(importAmount || importIsFree);

  if (!hasShippingInfo) {
    notes.push(SHIPPING_NOT_DISPLAYED);
  }

  if (!hasImportInfo) {
    notes.push(IMPORT_FEES_NOT_DISPLAYED);
  }

  const currency = itemPrice?.currency ?? shippingAmount?.currency ?? importAmount?.currency ?? marketCurrency;

  const destinationDetected = resolveDestinationCountryCode(documentRef, request);
  const destinationMatched =
    !destinationDetected || !request.sourceDestinationCountryCode || destinationDetected === request.sourceDestinationCountryCode;

  if (!destinationMatched) {
    notes.push(`Destination mismatch detected (${destinationDetected})`);
  }

  const canonicalHref = documentRef.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href;
  const canonicalUrl = canonicalHref ?? pageUrl.split("?")[0] ?? pageUrl;

  const totalDisplayedText =
    documentRef.querySelector("#subtotals-marketplace-table .a-color-price")?.textContent?.trim() ??
    documentRef.querySelector("#atfRedesign_desktop_totalPrice")?.textContent?.trim();

  const totalDisplayed = totalDisplayedText ? parseMoney(totalDisplayedText, marketCurrency) : globalCharges.total;

  return {
    marketplace: request.marketplace,
    asin: readDocumentAsin(documentRef, canonicalHref),
    title: collapseText(documentRef.querySelector("#productTitle")),
    selectedVariants: readSelectedVariants(documentRef),
    variantOptions: readVariantOptions(documentRef),
    canonicalUrl,
    destinationCountryCode: destinationDetected,
    destinationMatched,
    hasShippingInfo,
    hasImportInfo,
    isDeliverable: Boolean(itemPrice) && destinationMatched,
    availability: readAvailability(documentRef, Boolean(itemPrice)),
    parseConfidence: parseConfidenceOf(Boolean(itemPrice), hasShippingInfo, hasImportInfo, destinationMatched),
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

interface FetchedText {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<FetchedText>;

const SEE_ALL_BUYING_OPTIONS = "#buybox-see-all-buying-choices";
const OTHER_OFFERS_TIMEOUT_MS = 15_000;
const OTHER_OFFERS_HEADERS = { "X-Requested-With": "XMLHttpRequest", Accept: "text/html,*/*" };
const OTHER_OFFERS_UNREAD = "Other offers could not be read: ";
const NO_OTHER_SELLER = "No other seller delivers to the destination";
const OTHER_SELLER_QUOTED = "Quoted another seller's offer";

async function fetchOtherOffers(documentRef: Document, url: string, fetchRef: FetchLike): Promise<Document> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OTHER_OFFERS_TIMEOUT_MS);
  try {
    const response = await fetchRef(url, { credentials: "include", headers: OTHER_OFFERS_HEADERS, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Amazon answered HTTP ${response.status}`);
    }
    const panel = documentRef.implementation.createHTMLDocument("");
    panel.body.innerHTML = await response.text();
    return panel;
  } catch (error) {
    throw controller.signal.aborted ? new Error(`timed out after ${OTHER_OFFERS_TIMEOUT_MS / 1000} seconds`) : error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function withNote(result: ProductExtractionResult, note: string): ProductExtractionResult {
  return { ...result, notes: [...result.notes, note] };
}

function isFeaturedOfferNote(note: string): boolean {
  return [PRICE_NOT_DISPLAYED, SHIPPING_NOT_DISPLAYED, IMPORT_FEES_NOT_DISPLAYED].includes(note) || note.startsWith(AMAZON_SAYS);
}

function asksForOtherOffers(
  documentRef: Document,
  request: ProductExtractionRequest,
  result: ProductExtractionResult
): boolean {
  return (
    request.readOtherOffers === true &&
    !result.breakdown &&
    result.destinationMatched &&
    result.availability !== "unavailable" &&
    documentRef.querySelector(SEE_ALL_BUYING_OPTIONS) !== null
  );
}

function offerQuote({ item, shipping, seller, dispatcher, fulfilledByAmazon }: QuotableOffer): OfferQuote {
  return { item, shipping, seller, dispatcher, fulfilledByAmazon };
}

function quoteOtherOffers(result: ProductExtractionResult, offers: QuotableOffer[], offerCount: number): ProductExtractionResult {
  const [first] = offers;
  return {
    ...result,
    hasShippingInfo: true,
    hasImportInfo: false,
    isDeliverable: result.destinationMatched,
    availability: "available",
    parseConfidence: parseConfidenceOf(true, true, false, result.destinationMatched),
    breakdown: { item: first.item, shipping: first.shipping },
    otherSeller: {
      seller: first.seller,
      dispatcher: first.dispatcher,
      fulfilledByAmazon: first.fulfilledByAmazon,
      offerCount,
      deliveringNewCount: offers.length
    },
    otherOffers: offers.map(offerQuote),
    notes: [OTHER_SELLER_QUOTED, IMPORT_FEES_NOT_DISPLAYED, ...result.notes.filter((note) => !isFeaturedOfferNote(note))]
  };
}

export async function extractProductDataWithOffers(
  documentRef: Document,
  request: ProductExtractionRequest,
  pageUrl: string,
  fetchRef: FetchLike
): Promise<ProductExtractionResult> {
  const result = extractProductData(documentRef, request, pageUrl);
  if (!asksForOtherOffers(documentRef, request, result)) {
    return result;
  }

  const url = buildOtherOffersUrl(documentRef, new URL(pageUrl).origin, result.asin);
  if (!url) {
    return withNote(result, `${OTHER_OFFERS_UNREAD}the page names no ASIN`);
  }

  let panel: Document;
  try {
    panel = await fetchOtherOffers(documentRef, url, fetchRef);
  } catch (error) {
    return withNote(result, `${OTHER_OFFERS_UNREAD}${error instanceof Error ? error.message : "Unknown request error"}`);
  }

  const offers = parseOtherOffers(panel, MARKET_DEFAULT_CURRENCY[request.marketplace]);
  if (!offers) {
    return withNote(result, `${OTHER_OFFERS_UNREAD}Amazon's answer held no offer list`);
  }

  const quotable = quotableOffers(offers.offers);
  return quotable.length > 0 ? quoteOtherOffers(result, quotable, offers.offerCount) : withNote(result, NO_OTHER_SELLER);
}

declare global {
  interface Window {
    __ACROSS_AMAZON_PRODUCT_REQUEST__?: ProductExtractionRequest;
    __ACROSS_AMAZON_PRODUCT_RESULT__?: Promise<ProductExtractionResult>;
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const request = window.__ACROSS_AMAZON_PRODUCT_REQUEST__;
  if (request) {
    window.__ACROSS_AMAZON_PRODUCT_RESULT__ = extractProductDataWithOffers(document, request, location.href, (url, init) =>
      fetch(url, init)
    );
  }
}
