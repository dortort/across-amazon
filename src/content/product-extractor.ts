import type { ListingAvailability, ProductExtractionRequest, ProductExtractionResult, VariantOption } from "../shared/types";

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

function isCountryCode(alias: string): boolean {
  return /^[a-z]{2}$/.test(alias);
}

function aliasMatches(normalizedText: string, alias: string): boolean {
  if (/^[a-z ]+$/.test(alias)) {
    return new RegExp(`(?:^|[^a-z])${alias}(?:[^a-z]|$)`).test(normalizedText);
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

type ParsedMoney = { amount: number; currency: string };

const CURRENCY_CODE = String.raw`(?<![A-Za-z])(?:USD|CAD|MXN|GBP|EUR|JPY|AUD|BRL|CHF|CNY|CZK|DKK|HKD|HUF|IDR|ILS|INR|ISK|KRW|MYR|NOK|NZD|PHP|PLN|RON|SEK|SGD|THB|TRY|ZAR)(?![A-Za-z])`;
const CURRENCY_CODE_TOKEN = new RegExp(CURRENCY_CODE);
const DOLLAR_CURRENCIES = new Set(["USD", "CAD", "MXN", "AUD"]);

function detectCurrency(text: string, marketCurrency: string): string {
  if (text.includes("US$")) {
    return "USD";
  }
  if (text.includes("CA$") || text.includes("C$")) {
    return "CAD";
  }
  if (text.includes("MX$")) {
    return "MXN";
  }
  if (text.includes("AU$")) {
    return "AUD";
  }
  const code = CURRENCY_CODE_TOKEN.exec(text)?.[0];
  if (code) {
    return code;
  }
  if (text.includes("£")) {
    return "GBP";
  }
  if (text.includes("€")) {
    return "EUR";
  }
  if (text.includes("￥") || text.includes("¥") || text.includes("円")) {
    return "JPY";
  }
  if (text.includes("$")) {
    return DOLLAR_CURRENCIES.has(marketCurrency) ? marketCurrency : "USD";
  }
  return marketCurrency;
}

const AMOUNT = String.raw`(?:\d{1,3}(?:[\u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)*)`;
const PREFIXED_MONEY = new RegExp(String.raw`(?:(?:CA|C|MX|AU|US)?\$|£|€|￥|¥|${CURRENCY_CODE}\s*)${AMOUNT}`);
const SUFFIXED_MONEY = new RegExp(String.raw`${AMOUNT}\s*(?:€|£|￥|¥|円|\$|${CURRENCY_CODE})`);
const BARE_AMOUNT = /^\d[\d\s.,]*$/;

function parseMoney(text: string, marketCurrency: string): ParsedMoney | undefined {
  const amount = parseLocalizedNumber(text);
  if (amount === undefined) {
    return undefined;
  }

  return {
    amount,
    currency: detectCurrency(text, marketCurrency)
  };
}

function parseCurrencyMarkedMoney(text: string, marketCurrency: string): ParsedMoney | undefined {
  const token = PREFIXED_MONEY.exec(text)?.[0] ?? SUFFIXED_MONEY.exec(text)?.[0];
  return token ? parseMoney(token, marketCurrency) : undefined;
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
  return postcode && !shownOnSource ? request.marketplace : undefined;
}

const ITEM_PRICE_SOURCES = [
  "#corePrice_feature_div .a-price",
  "#price_inside_buybox",
  "#corePriceDisplay_desktop_feature_div .a-price",
  "#apex_desktop .a-price",
  ".a-price.priceToPay, .a-price.apexPriceToPay, .a-price.apex-pricetopay-value",
  "#priceblock_ourprice",
  "#priceblock_dealprice",
  "#tp_price_block_total_price_ww .a-price",
  ".a-price.aok-align-center"
];

const PRICE_TO_PAY = ".priceToPay, .apexPriceToPay, .apex-pricetopay-value";
const OTHER_PRICE = [
  ".apex-priceperunit-value",
  ".pricePerUnit",
  ".apex-basisprice-value",
  ".basisPrice",
  "[data-a-strike='true']",
  "#twister_feature_div",
  "[id^='inline-twister-row-']"
].join(", ");

function isOtherPrice(price: Element): boolean {
  return Boolean(price.closest(OTHER_PRICE)) || (!price.matches(PRICE_TO_PAY) && Boolean(price.closest(".a-text-price")));
}

function readPricePart(price: Element, selector: string): string {
  return price.querySelector(selector)?.textContent?.replace(/\s+/g, "") ?? "";
}

function readPriceText(price: Element): string | undefined {
  const offscreen = collapseText(price.querySelector(".a-offscreen"));
  if (offscreen) {
    return offscreen;
  }

  const whole = readPricePart(price, ".a-price-whole");
  if (whole) {
    return `${readPricePart(price, ".a-price-symbol")}${whole}${readPricePart(price, ".a-price-fraction")}`;
  }

  return collapseText(price);
}

function findItemPrice(documentRef: Document, marketCurrency: string): ParsedMoney | undefined {
  for (const selector of ITEM_PRICE_SOURCES) {
    for (const price of Array.from(documentRef.querySelectorAll(selector))) {
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

interface ChargeReading {
  amount?: ParsedMoney;
  isFree: boolean;
}

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

function readAmount(text: string, marketCurrency: string): ParsedMoney | undefined {
  return parseCurrencyMarkedMoney(text, marketCurrency) ?? (BARE_AMOUNT.test(text) ? parseMoney(text, marketCurrency) : undefined);
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

const IMPORT_CHARGE = /import (?:fee|charge)/;
const NO_IMPORT_CHARGE = /(?:^|[^a-z])no import (?:fee|charge)/;
const SHIPPING_CHARGE = /shipping|delivery/;

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

function readAmazonGlobalLine(documentRef: Document, marketCurrency: string): ChargeLine {
  for (const line of Array.from(documentRef.querySelectorAll("#amazonGlobal_feature_div > .a-color-secondary"))) {
    const charges: ChargeLine = {};
    for (const clause of (line.textContent ?? "").split("&")) {
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

const PRIMARY_DELIVERY_PRICE = "[id^='mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE'] [data-csa-c-delivery-price]";

function readDeliveryPrice(documentRef: Document, marketCurrency: string): ChargeReading | undefined {
  for (const message of Array.from(documentRef.querySelectorAll(PRIMARY_DELIVERY_PRICE))) {
    const value = message.getAttribute("data-csa-c-delivery-price")?.trim() ?? "";
    const amount = readAmount(value, marketCurrency);
    if (amount) {
      return { amount, isFree: false };
    }
    if (hasFreeMarker(value)) {
      return { isFree: true };
    }
  }

  return undefined;
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

function collapseText(element: Element | null | undefined): string | undefined {
  return element?.textContent?.replace(/\s+/g, " ").trim() || undefined;
}

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

export function extractProductData(
  documentRef: Document,
  request: ProductExtractionRequest,
  pageUrl: string
): ProductExtractionResult {
  const notes: string[] = [];
  const marketCurrency = MARKET_DEFAULT_CURRENCY[request.marketplace];

  const itemPrice = findItemPrice(documentRef, marketCurrency);

  if (!itemPrice) {
    notes.push("Price not displayed for destination");
    const availability = readAvailabilityMessage(documentRef);
    if (availability) {
      notes.push(`Amazon says: ${availability}`);
    }
  }

  const globalCharges = readAmazonGlobalCharges(documentRef, marketCurrency);
  const globalLine = readAmazonGlobalLine(documentRef, marketCurrency);
  const { amount: shippingAmount, isFree: shippingIsFree } =
    tableCharge(globalCharges.shipping) ??
    globalLine.shipping ??
    readDeliveryPrice(documentRef, marketCurrency) ??
    readCharge(documentRef, SHIPPING_KEYWORDS, hasFreeMarker, marketCurrency);
  const { amount: importAmount, isFree: importIsFree } =
    tableCharge(globalCharges.importFees) ?? globalLine.importFees ?? readImportCharge(documentRef, marketCurrency);

  const hasShippingInfo = Boolean(shippingAmount || shippingIsFree);
  const hasImportInfo = Boolean(importAmount || importIsFree);

  if (!hasShippingInfo) {
    notes.push("Shipping not displayed for destination");
  }

  if (!hasImportInfo) {
    notes.push("Import fees not displayed for destination");
  }

  const currency = itemPrice?.currency ?? shippingAmount?.currency ?? importAmount?.currency ?? marketCurrency;

  const destinationDetected = resolveDestinationCountryCode(documentRef, request);
  const destinationMatched = !destinationDetected || destinationDetected === request.sourceDestinationCountryCode;

  if (!destinationMatched) {
    notes.push(`Destination mismatch detected (${destinationDetected})`);
  }

  const canonicalHref = documentRef.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href;
  const canonicalUrl = canonicalHref ?? pageUrl.split("?")[0] ?? pageUrl;

  const totalDisplayedText =
    documentRef.querySelector("#subtotals-marketplace-table .a-color-price")?.textContent?.trim() ??
    documentRef.querySelector("#atfRedesign_desktop_totalPrice")?.textContent?.trim();

  const totalDisplayed = totalDisplayedText ? parseMoney(totalDisplayedText, marketCurrency) : globalCharges.total;

  const parseConfidence =
    (itemPrice ? 0.5 : 0) +
    (hasShippingInfo ? 0.2 : 0) +
    (hasImportInfo ? 0.2 : 0) +
    (destinationMatched ? 0.1 : 0);

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
