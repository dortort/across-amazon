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

function isSponsored(element: Element): boolean {
  const labels = [
    element.querySelector("span.s-label-popover-default")?.textContent,
    element.querySelector("span.puis-sponsored-label-text")?.textContent,
    element.querySelector("span.a-color-secondary")?.textContent,
    element.getAttribute("data-cel-widget")
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return labels.includes("sponsored") || labels.includes("patrocinado") || labels.includes("広告");
}

function absoluteUrl(href: string, origin: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }
  return `${origin}${href}`;
}

export function extractSearchCandidates(
  documentRef: Document,
  request: SearchExtractionRequest,
  pageOrigin: string
): SearchCandidate[] {
  const results = Array.from(documentRef.querySelectorAll("div.s-result-item[data-component-type='s-search-result']"));
  const organicResults = results.filter((result) => !isSponsored(result));

  const limit = request.limit ?? 8;
  return organicResults.slice(0, limit).flatMap((result) => {
    const title = result.querySelector("h2 span")?.textContent?.trim();
    const href = result.querySelector<HTMLAnchorElement>("h2 a")?.getAttribute("href");

    if (!title || !href) {
      return [];
    }

    const asin = result.getAttribute("data-asin") || undefined;
    const brand =
      result
        .querySelector(".a-row.a-size-base.a-color-secondary .a-size-base-plus")
        ?.textContent?.trim() || undefined;

    const rawPrice = result.querySelector(".a-price .a-offscreen")?.textContent?.trim();
    const priceAmount = rawPrice ? parseLocalizedNumber(rawPrice) : undefined;
    const currency = rawPrice ? detectCurrency(rawPrice) : undefined;

    return [
      {
        marketplace: request.marketplace,
        asin: asin || undefined,
        title,
        brand,
        price: priceAmount !== undefined && currency ? { amount: priceAmount, currency } : undefined,
        url: absoluteUrl(href, pageOrigin),
        imageUrl: result.querySelector<HTMLImageElement>("img.s-image")?.src
      }
    ];
  });
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
