import type { SearchCandidate, SearchExtractionRequest } from "../shared/types";

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

const MARKET_DEFAULT_CURRENCY: Record<SearchExtractionRequest["marketplace"], string> = {
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

const CURRENCY_CODE_TOKEN =
  /(?<![A-Za-z])(?:USD|CAD|MXN|GBP|EUR|JPY|AUD|BRL|CHF|CNY|CZK|DKK|HKD|HUF|IDR|ILS|INR|ISK|KRW|MYR|NOK|NZD|PHP|PLN|RON|SEK|SGD|THB|TRY|ZAR)(?![A-Za-z])/;
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

const SPONSORED_LABELS = new Set(["sponsored", "patrocinado", "gesponsert", "sponsorisé", "sponsorizzato", "スポンサー", "広告"]);
const SPONSORED_LABEL_SELECTOR = "span.s-label-popover-default, span.puis-sponsored-label-text";
const PRODUCT_PATH = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i;
const ASIN_PATTERN = /^[A-Z0-9]{10}$/i;

interface ProductLink {
  url: string;
  asin: string;
}

function labelText(element: Element): string {
  return (element.textContent ?? "").normalize("NFC").trim().toLowerCase();
}

function isSponsored(card: Element): boolean {
  if (card.classList.contains("AdHolder")) {
    return true;
  }

  const labelled = Array.from(card.querySelectorAll(SPONSORED_LABEL_SELECTOR)).some((label) => {
    const text = labelText(label);
    return [...SPONSORED_LABELS].some((sponsoredLabel) => text.includes(sponsoredLabel));
  });

  return labelled || Array.from(card.querySelectorAll("span")).some((span) => SPONSORED_LABELS.has(labelText(span)));
}

function readProductLink(anchor: Element | null | undefined, origin: string): ProductLink | undefined {
  const href = anchor?.getAttribute("href")?.trim();
  if (!href) {
    return undefined;
  }

  try {
    const url = new URL(href, origin);
    const asin = PRODUCT_PATH.exec(url.pathname)?.[1];
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !asin) {
      return undefined;
    }
    return { url: url.href, asin: asin.toUpperCase() };
  } catch {
    return undefined;
  }
}

function collapseText(element: Element | null | undefined): string | undefined {
  return element?.textContent?.replace(/\s+/g, " ").trim() || undefined;
}

interface TitleHeading {
  heading: Element;
  title: string;
  link: ProductLink;
}

function findTitleHeading(card: Element, origin: string): TitleHeading | undefined {
  for (const heading of Array.from(card.querySelectorAll("h2"))) {
    const link =
      readProductLink(heading.closest("a[href]"), origin) ?? readProductLink(heading.querySelector("a[href]"), origin);
    const title = collapseText(heading);
    if (link && title) {
      return { heading, title, link };
    }
  }

  return undefined;
}

function findFallbackTitle(card: Element, origin: string): Omit<TitleHeading, "heading"> | undefined {
  const link = Array.from(card.querySelectorAll("a[href]"))
    .map((anchor) => readProductLink(anchor, origin))
    .find((candidate) => candidate !== undefined);
  const title = card.querySelector("img.s-image")?.getAttribute("alt")?.replace(/\s+/g, " ").trim();
  return link && title ? { title, link } : undefined;
}

function findBrand(card: Element, titleHeading?: Element): string | undefined {
  const brandHeading = Array.from(card.querySelectorAll("h2")).find(
    (heading) =>
      heading !== titleHeading &&
      !heading.closest("a") &&
      (heading.classList.contains("a-size-mini") || heading.closest(".a-row.a-color-secondary") !== null)
  );

  return collapseText(brandHeading) ?? collapseText(card.querySelector(".a-row.a-size-base.a-color-secondary .a-size-base-plus"));
}

function findPriceText(card: Element): string | undefined {
  const selectors = [".a-price:not(.a-text-price) .a-offscreen", ".a-price .a-offscreen"];
  for (const selector of selectors) {
    const text = Array.from(card.querySelectorAll(selector))
      .map((element) => element.textContent?.trim())
      .find(Boolean);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function findImageUrl(card: Element): string | undefined {
  const image =
    card.querySelector<HTMLImageElement>(".s-product-image-container img.s-image") ??
    card.querySelector<HTMLImageElement>("img.s-image");
  return image?.src || undefined;
}

export function extractSearchCandidates(
  documentRef: Document,
  request: SearchExtractionRequest,
  pageOrigin: string
): SearchCandidate[] {
  const results = Array.from(documentRef.querySelectorAll("div.s-result-item[data-component-type='s-search-result']"));
  const organicResults = results.filter((result) => !isSponsored(result));

  const limit = request.limit ?? 8;
  const marketCurrency = MARKET_DEFAULT_CURRENCY[request.marketplace];
  const candidates = organicResults.flatMap((result): SearchCandidate[] => {
    const titleHeading = findTitleHeading(result, pageOrigin);
    const titled = titleHeading ?? findFallbackTitle(result, pageOrigin);
    if (!titled) {
      return [];
    }

    const dataAsin = result.getAttribute("data-asin")?.trim();
    const asin = dataAsin && ASIN_PATTERN.test(dataAsin) ? dataAsin.toUpperCase() : titled.link.asin;

    const rawPrice = findPriceText(result);
    const priceAmount = rawPrice ? parseLocalizedNumber(rawPrice) : undefined;
    const currency = rawPrice ? detectCurrency(rawPrice, marketCurrency) : undefined;

    return [
      {
        marketplace: request.marketplace,
        asin,
        title: titled.title,
        brand: findBrand(result, titleHeading?.heading),
        price: priceAmount !== undefined && currency ? { amount: priceAmount, currency } : undefined,
        url: titled.link.url,
        imageUrl: findImageUrl(result)
      }
    ];
  });

  return candidates.slice(0, limit);
}

declare global {
  interface Window {
    __ACROSS_AMAZON_SEARCH_REQUEST__?: SearchExtractionRequest;
    __ACROSS_AMAZON_SEARCH_CANDIDATES__?: SearchCandidate[];
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const request = window.__ACROSS_AMAZON_SEARCH_REQUEST__;
  if (request) {
    window.__ACROSS_AMAZON_SEARCH_CANDIDATES__ = extractSearchCandidates(document, request, location.origin);
  }
}
