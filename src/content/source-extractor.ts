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
  { code: "GB", aliases: ["united kingdom", "great britain", "uk", "england"] },
  { code: "DE", aliases: ["germany", "deutschland", "de"] },
  { code: "FR", aliases: ["france", "fr"] },
  { code: "IT", aliases: ["italy", "italia", "it"] },
  { code: "ES", aliases: ["spain", "espana", "españa", "es"] },
  { code: "JP", aliases: ["japan", "jp", "日本"] },
  { code: "AU", aliases: ["australia", "au"] }
];

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

const FIVE_DIGITS = /(?:^|\D)(\d{5})(?:\D|$)/;

const DOMESTIC_POSTCODE: Record<SourceContext["marketplace"], RegExp> = {
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

const DELIVER_TO_SELECTORS = ["#glow-ingress-line2", "#glow-ingress-line1", "#contextualIngressPtLabel"];

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

const PRODUCT_PATH_ASIN = /\/(?:dp|gp\/product|clp)\/([A-Z0-9]{10})/i;

function extractAsin(documentRef: Document, href: string): string | undefined {
  const asinFromUrl = href.match(PRODUCT_PATH_ASIN)?.[1]?.toUpperCase();
  if (asinFromUrl) {
    return asinFromUrl;
  }

  const asinInput = documentRef.querySelector<HTMLInputElement>("#ASIN, input[name='ASIN']")?.value;
  if (asinInput && /^[A-Z0-9]{10}$/i.test(asinInput)) {
    return asinInput.toUpperCase();
  }

  const canonicalHref = documentRef.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href;
  const asinFromCanonical = canonicalHref?.match(PRODUCT_PATH_ASIN)?.[1]?.toUpperCase();
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

  const selectedValues = variationSelectors.map((selector) => documentRef.querySelector(selector)?.textContent ?? "");
  const twisterValues = Array.from(
    documentRef.querySelectorAll('[id^="inline-twister-expanded-dimension-text-"]'),
    (element) => element.textContent ?? ""
  );

  const rawValues = [...selectedValues, ...twisterValues]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const modelMatches = rawValues.match(/[a-z]{1,4}\d{2,}[a-z0-9-]*/g) ?? [];
  const countMatches = rawValues.match(/\b\d+\s?(?:pack|count|ct|pcs|piece|pieces|pk)\b/g) ?? [];
  const sizeMatches = rawValues.match(/\b\d+(?:\.\d+)?\s?(?:oz|ml|l|kg|g|cm|mm|in)\b/g) ?? [];
  const colorMatches = rawValues
    .split(/[\s/,]+/)
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

function domesticIso(documentRef: Document, marketplace: SourceContext["marketplace"]): string | undefined {
  const deliverTo = normalize(
    DELIVER_TO_SELECTORS.map((selector) => documentRef.querySelector(selector)?.textContent ?? "").join(" ")
  );
  if (!DOMESTIC_POSTCODE[marketplace].test(deliverTo)) {
    return undefined;
  }
  return marketplace === "UK" ? "GB" : marketplace;
}

function readDeliverTo(documentRef: Document): string | undefined {
  const text = DELIVER_TO_SELECTORS.map((selector) => documentRef.querySelector(selector)?.textContent)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

const BRAND_LABELS = new Set(["brand", "brand name", "marke", "marque", "marca", "marchio", "ブランド"]);

function cleanBrand(rawBrand?: string): string | undefined {
  if (!rawBrand) {
    return undefined;
  }

  const cleaned = rawBrand
    .replace(/\s+/g, " ")
    .replace(/^(?:brand|marke|marque|marca|marchio)\s*[:：]\s*/i, "")
    .replace(/^visit the\s+/i, "")
    .replace(/^visita la tienda de\s+/i, "")
    .replace(/\s+store$/i, "")
    .trim();

  return cleaned && !BRAND_LABELS.has(cleaned.toLowerCase()) ? cleaned : undefined;
}

function readBrandRowValue(documentRef: Document): string | undefined {
  const row = documentRef.querySelector("tr.po-brand");
  if (!row) {
    return undefined;
  }

  const cells = Array.from(row.querySelectorAll("td"));
  const valueCell = row.querySelector("td.a-span9") ?? (cells.length > 1 ? cells[cells.length - 1] : undefined);
  return valueCell?.textContent ?? undefined;
}

function extractBrand(documentRef: Document): string | undefined {
  return [readBrandRowValue(documentRef), documentRef.querySelector("#bylineInfo")?.textContent ?? undefined]
    .map(cleanBrand)
    .find(Boolean);
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

  const source: SourceContext = {
    marketplace,
    asin,
    title,
    brand: extractBrand(documentRef),
    variationTokens: extractVariationTokens(documentRef),
    sourceUrl: href
  };

  const destinationCountryCode =
    readDestinationIso(documentRef) ?? resolveDestinationCountryCode(documentRef) ?? domesticIso(documentRef, marketplace);
  if (destinationCountryCode) {
    source.destinationCountryCode = destinationCountryCode;
  }

  const deliverTo = readDeliverTo(documentRef);
  if (deliverTo) {
    source.deliverTo = deliverTo;
  }

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
