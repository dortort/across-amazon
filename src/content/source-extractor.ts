import type { SourceContext, SourceExtractionResult } from "../shared/types";

interface CountryAlias {
  code: string;
  aliases: string[];
}

const MARKET_BY_HOST: Record<string, SourceContext["marketplace"]> = {
  "www.amazon.com": "US",
  "www.amazon.ca": "CA",
  "www.amazon.com.mx": "MX",
  "www.amazon.co.uk": "UK",
  "www.amazon.de": "DE",
  "www.amazon.fr": "FR",
  "www.amazon.it": "IT",
  "www.amazon.es": "ES",
  "www.amazon.co.jp": "JP",
  "www.amazon.com.au": "AU"
};

const COUNTRY_ALIASES: CountryAlias[] = [
  { code: "US", aliases: ["united states", "usa", "u.s.", "us"] },
  { code: "CA", aliases: ["canada", "ca"] },
  { code: "MX", aliases: ["mexico", "mx"] },
  { code: "UK", aliases: ["united kingdom", "great britain", "uk", "england"] },
  { code: "DE", aliases: ["germany", "deutschland", "de"] },
  { code: "FR", aliases: ["france", "fr"] },
  { code: "IT", aliases: ["italy", "italia", "it"] },
  { code: "ES", aliases: ["spain", "espana", "españa", "es"] },
  { code: "JP", aliases: ["japan", "jp", "日本"] },
  { code: "AU", aliases: ["australia", "au"] }
];

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

function extractAsin(documentRef: Document, href: string): string | undefined {
  const asinFromUrl = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase();
  if (asinFromUrl) {
    return asinFromUrl;
  }

  const asinInput = documentRef.querySelector<HTMLInputElement>("#ASIN, input[name='ASIN']")?.value;
  if (asinInput && /^[A-Z0-9]{10}$/i.test(asinInput)) {
    return asinInput.toUpperCase();
  }

  const canonicalHref = documentRef.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href;
  const asinFromCanonical = canonicalHref?.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase();
  return asinFromCanonical;
}

function extractVariationTokens(documentRef: Document): string[] {
  const variationSelectors = [
    "#variation_color_name .selection",
    "#variation_size_name .selection",
    "#variation_style_name .selection",
    "#variation_pattern_name .selection",
    "#variation_item_package_quantity .selection",
    "#native_dropdown_selected_size_name",
    "#native_dropdown_selected_color_name"
  ];

  const rawValues = variationSelectors
    .map((selector) => documentRef.querySelector(selector)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const modelMatches = rawValues.match(/[a-z]{1,4}\d{2,}[a-z0-9-]*/g) ?? [];
  const countMatches = rawValues.match(/\b\d+\s?(?:pack|count|ct|pcs|piece|pieces|pk)\b/g) ?? [];
  const sizeMatches = rawValues.match(/\b\d+(?:\.\d+)?\s?(?:oz|ml|l|kg|g|cm|mm|in)\b/g) ?? [];
  const colorMatches = rawValues
    .split(/\s+/)
    .filter((token) => ["black", "white", "blue", "red", "green", "silver", "gold", "pink"].includes(token));

  return [...new Set([...modelMatches, ...countMatches, ...sizeMatches, ...colorMatches])];
}

function resolveDestinationCountryCode(documentRef: Document): string | undefined {
  const destinationText = [
    documentRef.querySelector("#glow-ingress-line2")?.textContent,
    documentRef.querySelector("#glow-ingress-line1")?.textContent,
    documentRef.querySelector("#nav-global-location-data-modal-action")?.textContent,
    documentRef.querySelector("#contextualIngressPtLabel")?.textContent
  ]
    .filter(Boolean)
    .join(" ");

  if (!destinationText) {
    return undefined;
  }

  const normalizedText = normalize(destinationText);
  for (const country of COUNTRY_ALIASES) {
    if (country.aliases.some((alias) => aliasMatches(normalizedText, alias))) {
      return country.code;
    }
  }

  return undefined;
}

function cleanBrand(rawBrand?: string): string | undefined {
  if (!rawBrand) {
    return undefined;
  }

  const cleaned = rawBrand
    .replace(/^brand\s*[:：]\s*/i, "")
    .replace(/^visit the\s+/i, "")
    .replace(/\s+store$/i, "")
    .trim();

  return cleaned || undefined;
}

function toHttpUrl(value: string | null | undefined, href: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed, href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function extractImageUrl(documentRef: Document, href: string): string | undefined {
  const landingImage = documentRef.querySelector("#landingImage");
  const candidates = [
    landingImage?.getAttribute("src"),
    landingImage?.getAttribute("data-old-hires"),
    documentRef.querySelector("#imgTagWrapperId img")?.getAttribute("src"),
    documentRef.querySelector("meta[property='og:image']")?.getAttribute("content")
  ];

  for (const candidate of candidates) {
    const url = toHttpUrl(candidate, href);
    if (url) {
      return url;
    }
  }

  return undefined;
}

export function extractSourceContext(documentRef: Document, href: string, hostname: string): SourceExtractionResult {
  const marketplace = MARKET_BY_HOST[hostname.toLowerCase()];
  if (!marketplace) {
    return {
      error: `Unsupported marketplace hostname: ${hostname}`
    };
  }

  const asin = extractAsin(documentRef, href);
  const title =
    documentRef.querySelector("#productTitle")?.textContent?.trim() ??
    documentRef.querySelector("h1 span")?.textContent?.trim() ??
    "";

  if (!asin || !title) {
    return {
      error: "Unable to extract required source product metadata"
    };
  }

  const brandText =
    documentRef.querySelector("#bylineInfo")?.textContent?.trim() ??
    documentRef.querySelector("tr.po-brand td")?.textContent?.trim();

  const source: SourceContext = {
    marketplace,
    asin,
    title,
    brand: cleanBrand(brandText),
    variationTokens: extractVariationTokens(documentRef),
    destinationCountryCode: resolveDestinationCountryCode(documentRef) ?? marketplace,
    sourceUrl: href
  };

  const imageUrl = extractImageUrl(documentRef, href);
  if (imageUrl) {
    source.imageUrl = imageUrl;
  }

  return {
    source
  };
}

declare global {
  interface Window {
    __ACROSS_AMAZON_SOURCE_CONTEXT__?: SourceExtractionResult;
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof location !== "undefined") {
  window.__ACROSS_AMAZON_SOURCE_CONTEXT__ = extractSourceContext(document, location.href, location.hostname);
}
